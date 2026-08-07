/** memory tool — semantic + full-text search over the workspace RAG index. Verifies RAG is enabled, opens the store, resolves the embedder that built the index, embeds the query, and merges vector + FTS top-K via reciprocal rank fusion (RRF, k=60). Read-only and auto-approved. */

import { tool } from 'ai';
import { z } from 'zod';
import * as path from 'node:path';
import type { ToolContext } from './tool-context.js';
import { openRagStore, type VectorHit, type FtsHit } from '../../rag/store.js';
import { resolveForQuery } from '../../rag/resolve.js';
import { localModelExists } from '../../rag/local-onnx-embedder.js';
import { isRagCloudConfigured } from '../system-model.js';
import { hydrateRagConfig } from '../../configStore.js';
import * as workspaceStore from '../../store.js';
import type { ToolResult, ToolRegistration } from './types';

const DEFAULT_K = 5;
const MAX_K = 20;
/** RRF constant. Standard value from the original TREC paper; balances
 *  head vs tail of the rankings without tuning. */
const RRF_K = 60;

/** Shared body — testable without the SDK wrapper. ctx-free; the
 *  workspaceId comes from the caller (the SDK factory pulls it from
 *  ToolContext, tests pass it directly). */
export async function runMemory(
  query: string,
  k: number,
  workspaceId: string,
): Promise<ToolResult> {
  if (!query.trim()) {
    return { status: 'failed', output: 'Missing required arg: query' };
  }
  if (!workspaceId) {
    return {
      status: 'failed',
      output: 'No active workspace bound to this session.',
    };
  }

  // 1. Workspace must be in the enabled list. The hint is actionable:
  //    the user (or model, if it has shell access) can navigate to
  //    Settings → Memory & RAG and toggle it on.
  const enabled = workspaceStore.listRagEnabledWorkspaces();
  if (!enabled.includes(workspaceId)) {
    return {
      status: 'executed',
      output:
        `RAG is not enabled for this workspace. ` +
        `Enable it in Settings → Memory & RAG (toggles the Switch on for this workspace; ` +
        `ingestion will run automatically on first enable).`,
    };
  }

  // 2. Open the store. If this throws (sqlite-vec missing, db corrupt),
  //    surface the actual error rather than a generic "failed".
  let ragStore;
  try {
    ragStore = openRagStore(workspaceId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'failed', output: `Failed to open RAG index: ${msg}` };
  }

  try {
    const total = ragStore.chunkCount();
    if (total === 0) {
      return {
        status: 'executed',
        output:
          `RAG index for this workspace is empty. ` +
          `Re-trigger ingestion from Settings → Memory & RAG → Re-index.`,
      };
    }

    // 3. Resolve the query-time embedder. resolveForQuery refuses to cross
    //    embedders — a local-built index whose runtime died throws rather
    //    than silently re-embedding via cloud (vectors would mismatch).
    const ws = workspaceStore.listWorkspaces().find((w) => w.id === workspaceId);
    const ragConfig = hydrateRagConfig(ws?.ragConfig);
    let embedder;
    try {
      ({ embedder } = resolveForQuery({
        config: ragConfig,
        localAvailable: localModelExists(),
        cloudConfigured: isRagCloudConfigured(),
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        status: 'failed',
        output: `RAG index unusable: ${msg}`,
      };
    }

    // 4. Embed the query + run both searches.
    const kClamped = Math.min(Math.max(k, 1), MAX_K);
    let queryVec: number[];
    try {
      const vecs = await embedder.embed([query]);
      queryVec = vecs[0];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'failed', output: `Embedding query failed: ${msg}` };
    }

    const vecHits = ragStore.queryByVector(queryVec, kClamped);
    const ftsHits = ragStore.queryByFts(query, kClamped);

    // 5. Reciprocal rank fusion.
    const fused = fuse(vecHits, ftsHits, kClamped);

    if (fused.length === 0) {
      return {
        status: 'executed',
        output: `No matches for "${query}" across ${total} indexed chunks.`,
      };
    }

    // 6. Format. Truncate body to BODY_CAP chars to keep the tool result
    //    readable and avoid bloating the model's context.
    const BODY_CAP = 1500;
    const lines = fused.map((hit, i) => {
      const loc = `${shortPath(hit.path)}:${hit.startLine}` +
        (hit.symbol ? ` (${hit.symbol})` : '');
      const sim = 'similarity' in hit
        ? ` · ${Math.round(hit.similarity * 100)}%`
        : '';
      const body = hit.content.length > BODY_CAP
        ? hit.content.slice(0, BODY_CAP) + '\n…[truncated]'
        : hit.content;
      return `[${i + 1}] ${loc}${sim}\n${body}`;
    });

    const text =
      `Found ${fused.length} relevant chunk${fused.length === 1 ? '' : 's'} ` +
      `for "${query}" (out of ${total}):\n\n${lines.join('\n\n')}`;

    return {
      status: 'executed',
      output: text,
      // `display.kind:'text'` makes ToolCallCard render the body in a collapsible section (like web_search/web_fetch). Without it the card shows only the header — the user sees the tool was called but can't read what it found.
      display: { kind: 'text', text },
    };
  } finally {
    ragStore.close();
  }
}

/** Reciprocal Rank Fusion — zero-parameter merge of two rankings using rank-only signals; generic over distinct hit types so VectorHit + FtsHit fuse without forcing one score shape. */
function fuse<T1 extends { id: string }, T2 extends { id: string }>(
  vec: T1[],
  fts: T2[],
  k: number,
): Array<T1 | T2> {
  type Item = T1 | T2;
  const scores = new Map<string, { item: Item; score: number }>();
  for (let i = 0; i < vec.length; i++) {
    scores.set(vec[i].id, { item: vec[i], score: 1 / (RRF_K + i + 1) });
  }
  for (let i = 0; i < fts.length; i++) {
    const s = 1 / (RRF_K + i + 1);
    const existing = scores.get(fts[i].id);
    if (existing) existing.score += s;
    else scores.set(fts[i].id, { item: fts[i], score: s });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.item);
}

/** Workspace-relative path for compact display. Falls back to basename
 *  if the path isn't under the workspace (e.g. temp fixture in tests). */
function shortPath(absPath: string): string {
  const parts = absPath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 3) return absPath;
  return '…/' + parts.slice(-2).join('/');
}

/** Re-export the hit types so consumers can import everything from this
 *  module without reaching into store.js. */
export type { VectorHit, FtsHit };

// ─── SDK factory (the registration path used by orchestrator-sdk) ──────

export function createMemoryTool(ctx: ToolContext) {
  return tool({
    description:
      'FIRST tool to call for ANY codebase question. Searches the workspace RAG index ' +
      'by meaning and returns ranked code chunks in ~0.5s. Call this BEFORE directory_tree, ' +
      'list_dir, read_file, or grep. Returns file path + line range + source body for each match. ' +
      'Example: memory({ query: "how is authentication handled" }) → returns the auth files + code.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'Natural language query describing what you are looking for. Examples: ' +
          '"user authentication flow", "database connection setup", "API route definitions".',
        ),
      k: z
        .number()
        .int()
        .min(1)
        .max(MAX_K)
        .optional()
        .describe(`Top-K chunks to return. Default ${DEFAULT_K}, max ${MAX_K}.`),
    }),
    execute: async ({ query, k }) =>
      runMemory(query, k ?? DEFAULT_K, ctx.workspaceId),
  });
}

// ─── Legacy ToolRegistration shape (kept for the registry's non-SDK map) ──
// Consumed by the legacy orchestrator (USE_SDK_ORCHESTRATOR=false). Today that path is dormant, but the registry imports it for shape parity + so a flip back doesn't break; the execute signature mirrors the SDK shape.

export const memoryTool: ToolRegistration = {
  name: 'memory' as const,
  definition: {
    name: 'memory' as const,
    description:
      'FIRST tool to call for ANY codebase question. Searches the workspace RAG index ' +
      'by meaning and returns ranked code chunks in ~0.5s. Call BEFORE directory_tree, ' +
      'list_dir, read_file, or grep. Returns file path + line range + source body.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language: "how is authentication handled", "database setup", "API routes".' },
        k: { type: 'number', description: `Top-K results. Default ${DEFAULT_K}, max ${MAX_K}.` },
      },
      required: ['query'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 5_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) => {
    const query = typeof args.query === 'string' ? args.query : '';
    const k = typeof args.k === 'number' ? args.k : DEFAULT_K;
    // The legacy ToolContext in ./types doesn't carry workspaceId (only
    // the SDK one does). The legacy path is dormant today
    // (USE_SDK_ORCHESTRATOR=true), so a missing workspaceId here just
    // surfaces an actionable hint via runMemory.
    return runMemory(query, k, (ctx as { workspaceId?: string }).workspaceId ?? '');
  },
};

// path import is only used by shortPath above; keep it here so the
// import isn't shaken out by tree-shaking in some bundler configs.
void path;
