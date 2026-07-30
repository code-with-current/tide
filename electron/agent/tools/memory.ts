/**
 * memory tool — semantic + full-text search over the active workspace's
 * RAG index. This is the consumer side of the ingestion pipeline (Phase
 * C) — the agent calls it to find code by meaning rather than by exact
 * string match.
 *
 * Flow per call:
 *   1. Verify the workspace is in ragEnabledWorkspaces. Refuse with a
 *      hint otherwise — the model gets actionable text, not a cryptic
 *      error.
 *   2. Open the per-workspace RagStore. Refuse if the index is empty
 *      (initState was 'never' or the index got cleared).
 *   3. resolveForQuery picks the embedder that BUILT the index — never
 *      crosses, even if the other strategy is now available. Throws
 *      "rebuild required" if the recorded embedder can't serve.
 *   4. Embed the query (one vector), run queryByVector + queryByFts
 *      for top-K each.
 *   5. Reciprocal rank fusion (RRF, k=60) merges the two rankings.
 *      RRF is the standard zero-parameter fusion: it doesn't need
 *      scores, only ranks, so it works across FTS's bm25 (lower is
 *      better) and cosine similarity (higher is better) without
 *      normalization headaches.
 *   6. Format top-K chunks as `[n] path:line (symbol) · 87%\n<body>`.
 *
 * Cost: one embed call per tool use (~50–200ms locally). The store
 * opens cheaply (better-sqlite3 with sqlite-vec extension load) — about
 * 10–20ms — and closes in <1ms. Total tool latency well under the 5s
 * timeout in tool-meta.ts.
 *
 * Permission: read-only, auto-approved in every mode. The tool only
 * reads from the per-workspace index; it never writes.
 */

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

    // 3. Resolve the query-time embedder. resolveForQuery reads the
    //    index's recorded embedderId and refuses to cross — a
    //    local-built index whose local runtime has died throws rather
    //    than silently re-embedding via cloud (the vectors would land
    //    in a different space and produce garbage scores).
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

    // 6. Format. Show path:line + symbol + similarity (when available).
    //    Truncate chunk body to keep tool result readable; long bodies
    //    bloat the model's context. 1500 chars ≈ 75 lines of source —
    //    enough for a complete function/class without mid-body cutoff.
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
      // `display.kind: 'text'` makes ToolCallCard render the body in a
      // collapsible section (same as web_search/web_fetch results).
      // Without this, the card shows only the header (tool name + arg
      // preview) with an empty body — the user sees the tool was called
      // but can't read what it found.
      display: { kind: 'text', text },
    };
  } finally {
    ragStore.close();
  }
}

/** Reciprocal Rank Fusion — zero-parameter merge of two rankings.
 *  Works with rank-only signals (no need to normalize bm25 vs cosine).
 *  Returns top-K by fused score.
 *
 *  Generic over two distinct item types so VectorHit + FtsHit (which
 *  carry different score-shape fields — `similarity` vs `rank`) can be
 *  fused without forcing one shape. The output is the union type; the
 *  formatter checks for `similarity`/`rank` defensively. */
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
      'Semantic search over the active workspace\'s RAG index. Use this when you ' +
      'need to find code by MEANING — concepts, intent, "how is X handled" — rather ' +
      'than exact strings (use grep for exact matches). Returns up to K chunks ranked ' +
      'by vector similarity + FTS5 text match, each with file path, line range, ' +
      'symbol name, and source body. Requires the workspace to have RAG enabled AND ' +
      'ingested via Settings → Memory & RAG; the tool returns a hint instead of failing ' +
      'if either precondition is missing.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'What to look for. Natural language ("how do we handle user auth") OR ' +
          'code-shaped ("fetchUser", "function add(a, b)") both work — the embedder ' +
          'is code-tuned.',
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
//
// The legacy orchestrator (USE_SDK_ORCHESTRATOR=false) consumes this.
// Today USE_SDK_ORCHESTRATOR=true so this path is dormant, but the
// registry imports it for shape parity + so a flip back doesn't break.
// The execute signature mirrors the SDK shape.

export const memoryTool: ToolRegistration = {
  name: 'memory' as const,
  definition: {
    name: 'memory' as const,
    description:
      'Semantic search over the active workspace\'s RAG index. Use for meaning-based ' +
      'lookups: "how is X handled", "where do we validate Y". Returns top-K chunks ' +
      'with file path + line range + symbol + body.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to look for (natural language or code-shaped).' },
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
