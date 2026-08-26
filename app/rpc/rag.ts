/** RAG RPC — port of electron/ipc/rag.ts (frozen Electron shell). Status /
 *  download / enable / disable / init for the Memory & RAG panel. The two
 *  Electron progress event channels (tide:rag:initProgress,
 *  tide:rag:downloadProgress) ride one ragProgress message with the payloads
 *  verbatim, discriminated by `kind` (mcpEvents' discriminated-payload
 *  pattern) through a mutable emit slot, so registering the RPC tier
 *  repeatedly (tests) never stacks pushes and pre-registration emissions are
 *  dropped exactly like the Electron shell's zero-window broadcast was.
 *  initRagWorkspace keeps the job pattern: {ok, startedAt} returns
 *  immediately, the ingest runs detached, runningInits guards re-entry, and
 *  its progress/failed events arrive via ragProgress. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDatabase } from '../platform/sqlite.js';
import * as store from '../core/store.js';
import { hydrateRagConfig } from '../core/configStore.js';
import { isRagCloudConfigured } from '../core/agent/system-model.js';
import { localModelExists } from '../core/rag/local-onnx-embedder.js';
import { downloadModel } from '../core/rag/model-downloader.js';
import { ingestWorkspace } from '../core/rag/ingest.js';
import { createLogger } from '../core/logger.js';
import { appDataDir } from '../platform/paths.js';
import type {
  RagStatus,
  RagWorkspaceOpResult,
  RagInitResult,
  RagInitProgressEvent,
} from '../../src/types';
import type { RagProgressMessage } from '../../shared/rpc';

const log = createLogger('rag');
const runningInits = new Map<string, Promise<unknown>>();

const EMPTY_STATUS: RagStatus = {
  embedderId: null,
  dim: 384,
  enabledWorkspaces: [],
  cloudAllowed: false,
  chunkTokens: 384,
  localAvailable: null,
  cloudConfigured: false,
  chunkCount: 0,
  initState: 'never',
  lastIngestedAt: null,
  state: 'no-index',
};

export interface RagRpcSend {
  progress(msg: RagProgressMessage): void;
}

let emitProgress: ((msg: RagProgressMessage) => void) | null = null;

function getRagStatus(workspaceId: string): RagStatus {
  const ws = store.listWorkspaces().find((w) => w.id === workspaceId);
  if (!ws) return { ...EMPTY_STATUS, enabledWorkspaces: store.listRagEnabledWorkspaces() };

  const ragConfig = hydrateRagConfig(ws.ragConfig);
  const localAvailable = localModelExists();
  const cloudConfigured = isRagCloudConfigured();

  let state: RagStatus['state'];
  if (ragConfig.embedderId === 'cloud-base') {
    state = 'cloud-fallback';
  } else if (localAvailable) {
    state = 'ok';
  } else if (ragConfig.cloudAllowed && cloudConfigured) {
    state = 'cloud-fallback';
  } else {
    state = 'unavailable';
  }

  const { chunkCount, lastIngestedAt } = readIngestState(workspaceId);
  const initState: RagStatus['initState'] = runningInits.has(workspaceId)
    ? 'running'
    : lastIngestedAt !== null
      ? 'done'
      : 'never';

  return {
    embedderId: ragConfig.embedderId,
    dim: ragConfig.dim,
    enabledWorkspaces: store.listRagEnabledWorkspaces(),
    cloudAllowed: ragConfig.cloudAllowed,
    chunkTokens: ragConfig.chunkTokens,
    localAvailable,
    cloudConfigured,
    chunkCount,
    initState,
    lastIngestedAt,
    state,
  };
}

function readIngestState(workspaceId: string): { chunkCount: number; lastIngestedAt: number | null } {
  const dbPath = path.join(appDataDir(), 'rag', workspaceId, 'index.db');
  if (!fs.existsSync(dbPath)) return { chunkCount: 0, lastIngestedAt: null };
  try {
    const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
    try {
      const countRow = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'lastIngestedAt'").get() as { value?: string } | undefined;
      return { chunkCount: countRow.n, lastIngestedAt: metaRow?.value ? Number(metaRow.value) : null };
    } finally {
      db.close();
    }
  } catch {
    return { chunkCount: 0, lastIngestedAt: null };
  }
}

async function downloadRagModel(): Promise<RagWorkspaceOpResult> {
  if (localModelExists()) return { ok: true };
  try {
    await downloadModel((progress) => {
      emitProgress?.({
        kind: 'download',
        event: {
          received: progress.received,
          total: progress.total,
          phase: 'downloading' as const,
        },
      });
    });
    // Final event — signals completion.
    emitProgress?.({
      kind: 'download',
      event: {
        received: 0,
        total: 0,
        phase: 'done' as const,
      },
    });
    return { ok: true };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    log.error('model download failed', { err: e });
    emitProgress?.({
      kind: 'download',
      event: {
        received: 0,
        total: 0,
        phase: 'failed' as const,
        error,
      },
    });
    return { ok: false, error };
  }
}

async function enableRagWorkspace(workspaceId: string): Promise<RagWorkspaceOpResult> {
  const dl = await downloadRagModel();
  if (!dl.ok) return dl;
  store.addRagEnabledWorkspace(workspaceId);
  return { ok: true };
}

function disableRagWorkspace(workspaceId: string): RagWorkspaceOpResult {
  store.removeRagEnabledWorkspace(workspaceId);
  return { ok: true };
}

function initRagWorkspace(workspaceId: string): RagInitResult {
  if (runningInits.has(workspaceId)) {
    return { ok: false, error: 'init already running for this workspace' };
  }
  const startedAt = Date.now();
  const progress = (partial: Omit<RagInitProgressEvent, 'workspaceId'>) => {
    const event: RagInitProgressEvent = { workspaceId, ...partial };
    emitProgress?.({ kind: 'init', event });
  };
  const p = (async () => {
    try {
      await ingestWorkspace(workspaceId, { onProgress: (e) => progress(e) });
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      log.error('init failed', { workspaceId, err: e });
      progress({ phase: 'failed', filesSeen: 0, chunksTotal: 0, chunksEmbedded: 0, error });
    } finally {
      runningInits.delete(workspaceId);
    }
  })();
  runningInits.set(workspaceId, p);
  return { ok: true, startedAt };
}

export function registerRagRpc(send: RagRpcSend) {
  emitProgress = send.progress;

  return {
    ragStatus: ({ workspaceId }: { workspaceId: string }) => {
      try {
        return getRagStatus(workspaceId);
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : 'failed' };
      }
    },

    ragDownloadModel: (_: Record<string, never>) => downloadRagModel(),

    ragModelExists: (_: Record<string, never>) => localModelExists(),

    ragEnableWorkspace: ({ workspaceId }: { workspaceId: string }) => enableRagWorkspace(workspaceId),

    ragDisableWorkspace: ({ workspaceId }: { workspaceId: string }) => disableRagWorkspace(workspaceId),

    ragInitWorkspace: ({ workspaceId }: { workspaceId: string }) => initRagWorkspace(workspaceId),
  };
}

export type RagRpcHandlers = ReturnType<typeof registerRagRpc>;
