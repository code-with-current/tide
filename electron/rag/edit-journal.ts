/** Episodic edit memory — after a turn that edited files, write a journal
 *  record into the workspace RAG index as a chunk so the existing `memory`
 *  tool can recall *what was changed and why* semantically, with zero
 *  changes to the search path. Journal chunks use a `tide://edit-journal`
 *  path namespace that the file walk never visits; since ingestion only
 *  adds chunks (never purges), journal entries survive a full re-index. */

import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import { openRagStore, type ChunkRow } from './store.js';
import { resolveForQuery } from './resolve.js';
import { localModelExists } from './local-onnx-embedder.js';
import { isRagCloudConfigured } from '../agent/system-model.js';
import { hydrateRagConfig } from '../configStore.js';
import * as workspaceStore from '../store.js';

const log = createLogger('rag');

export interface EditJournalEntry {
  sessionId: string;
  messageId: string;
  /** Absolute paths of files edited this turn (deduped by caller or here). */
  files: string[];
  /** One line per edit tool call, e.g. `edit_file src/lib/foo.ts (add retry loop)`. */
  operations: string[];
  /** The turn's narration — the "why". Caps enforced here. */
  summary: string;
  createdAt: number;
}

/** Cap on the narration embedded — MiniLM truncates ~512 tokens anyway;
 *  keeping the row small avoids bloating future memory results. */
const SUMMARY_CAP = 1200;

/** Write one journal entry. Best-effort: any failure is logged and
 *  swallowed — the edit itself already succeeded, memory must never
 *  break the turn pipeline. Also a no-op when RAG is disabled or the
 *  index doesn't exist yet (nothing to fuse into). */
export async function recordEditTurn(
  workspaceId: string,
  entry: EditJournalEntry,
): Promise<void> {
  if (!workspaceId || entry.files.length === 0) return;
  if (!workspaceStore.listRagEnabledWorkspaces().includes(workspaceId)) return;

  try {
    const ragStore = openRagStore(workspaceId);
    try {
      if (ragStore.chunkCount() === 0) return;

      // The journal vector must live in the same embedding space as the
      // index — resolve the query-time embedder, which refuses to cross
      // embedders (same contract as the memory tool).
      const ws = workspaceStore.listWorkspaces().find((w) => w.id === workspaceId);
      const ragConfig = hydrateRagConfig(ws?.ragConfig);
      const { embedder, embedderId } = resolveForQuery({
        config: ragConfig,
        localAvailable: localModelExists(),
        cloudConfigured: isRagCloudConfigured(),
      });

      const date = new Date(entry.createdAt).toISOString();
      const content =
        `Edit journal ${date} (session ${entry.sessionId})\n` +
        `Files: ${entry.files.join(', ')}\n` +
        `Operations:\n${entry.operations.map((o) => `- ${o}`).join('\n')}\n` +
        `Why: ${entry.summary.slice(0, SUMMARY_CAP)}`;

      const row: ChunkRow = {
        id: `journal_${entry.messageId}`,
        path: `tide://edit-journal/${date.slice(0, 10)}/${entry.messageId}`,
        symbol: 'edit journal',
        content,
        contentHash: createHash('sha256').update(content).digest('hex'),
        startLine: 0,
        endLine: 0,
        embedderId,
        createdAt: entry.createdAt,
      };

      const vectors = await embedder.embed([content]);
      const rowids = ragStore.upsertChunks([row]);
      ragStore.upsertVectors([
        { rowid: rowids[0].rowid, chunkId: row.id, embedding: vectors[0] },
      ]);
      log.info('edit journal recorded', { session: entry.sessionId, files: entry.files.length });
    } finally {
      ragStore.close();
    }
  } catch (e) {
    log.warn('edit journal write failed', {
      session: entry.sessionId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
