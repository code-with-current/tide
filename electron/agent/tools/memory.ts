/** memory tool — semantic + full-text search over the workspace RAG index,
 *  fused with the global knowledge-sources index (filtered to sources
 *  enabled for this workspace). Verifies RAG, opens both stores, resolves
 *  the embedder that built each index, embeds the query, and merges
 *  vector + FTS top-K via reciprocal rank fusion (RRF, k=60). Knowledge
 *  hits are labeled with their doc origin so the model can cite
 *  "docs.react.dev" vs repo files. Read-only and auto-approved. */

import { tool } from 'ai';
import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ToolContext } from './tool-context.js';
import { openRagStore, type VectorHit, type FtsHit } from '../../rag/store.js';
import { resolveForQuery } from '../../rag/resolve.js';
import { localModelExists } from '../../rag/local-onnx-embedder.js';
import { isRagCloudConfigured } from '../system-model.js';
import { hydrateRagConfig } from '../../configStore.js';
import * as workspaceStore from '../../store.js';
import { knowledgeDbPath, openKnowledgeStore } from '../../knowledge/store.js';
import type { Embedder } from '../../rag/embedder.js';
import type { ToolResult, ToolRegistration } from './types';

const DEFAULT_K = 5;
const MAX_K = 20;
/** RRF constant. Standard value from the original TREC paper; balances
 *  head vs tail of the rankings without tuning. */
const RRF_K = 60;

/** Knowledge hit decorated with its source's display name so results can cite the origin ("React Docs · react.dev/guide") distinctly from repo files. */
type KnowledgeHit = (VectorHit | FtsHit) & { sourceName: string };

const NO_KNOWLEDGE: { hits: KnowledgeHit[]; total: number } = { hits: [], total: 0 };

/** Tagged preparation failures: the workspace half surfaces these fatally;
 *  the knowledge half treats any of them as "no knowledge results". */
class RagUnusableError extends Error {}
class QueryEmbedError extends Error {}

interface PreparedQuery {
  embedderId: string;
  queryVec: number[];
}

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

  // 1. Workspace gate governs only the workspace half — a workspace with
  //    RAG disabled still reaches registered knowledge sources.
  const wsEnabled =
    workspaceStore.listRagEnabledWorkspaces().includes(workspaceId);

  // 2. Open the workspace store. If this throws (sqlite-vec missing, db
  //    corrupt), surface the actual error rather than a generic "failed".
  let ragStore: ReturnType<typeof openRagStore> | null = null;
  if (wsEnabled) {
    try {
      ragStore = openRagStore(workspaceId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'failed', output: `Failed to open RAG index: ${msg}` };
    }
  }

  try {
    const wsTotal = ragStore?.chunkCount() ?? 0;

    // 3. Query preparation (embedder resolution + query embedding) is lazy
    //    and memoized: paid at most once, and never started when no half
    //    ends up needing it. Failures are tagged so the workspace half can
    //    surface them fatally while the knowledge half swallows them.
    const kClamped = Math.min(Math.max(k, 1), MAX_K);
    let prepared: PreparedQuery | null = null;
    const prepareQuery = async (): Promise<PreparedQuery> => {
      if (!prepared) {
        let embedder: Embedder;
        let embedderId: string;
        try {
          const ws = workspaceStore.listWorkspaces().find((w) => w.id === workspaceId);
          const ragConfig = hydrateRagConfig(ws?.ragConfig);
          ({ embedder, embedderId } = resolveForQuery({
            config: ragConfig,
            localAvailable: localModelExists(),
            cloudConfigured: isRagCloudConfigured(),
          }));
        } catch (e: unknown) {
          throw new RagUnusableError(
            e instanceof Error ? e.message : String(e),
          );
        }
        try {
          const vecs = await embedder.embed([query]);
          prepared = { embedderId, queryVec: vecs[0] };
        } catch (e: unknown) {
          throw new QueryEmbedError(
            e instanceof Error ? e.message : String(e),
          );
        }
      }
      return prepared;
    };

    if (wsEnabled) {
      try {
        await prepareQuery();
      } catch (e: unknown) {
        if (e instanceof RagUnusableError) {
          return { status: 'failed', output: `RAG index unusable: ${e.message}` };
        }
        return { status: 'failed', output: `Embedding query failed: ${(e as Error).message}` };
      }
    }

    let wsFused: Array<VectorHit | FtsHit> = [];
    if (ragStore && wsTotal > 0) {
      const { queryVec } = await prepareQuery();
      wsFused = fuse(
        ragStore.queryByVector(queryVec, kClamped),
        ragStore.queryByFts(query, kClamped),
        kClamped,
      );
    }

    const knowledge = await searchKnowledgeSources({
      workspaceId,
      query,
      k: kClamped,
      prepareQuery,
    });

    // 5. Reciprocal rank fusion: within each store first, then across stores.
    const fused = fuse(wsFused, knowledge.hits, kClamped);
    const grandTotal = wsTotal + knowledge.total;

    if (fused.length === 0) {
      if (!wsEnabled) {
        return {
          status: 'executed',
          output:
            `RAG is not enabled for this workspace. ` +
            `Enable it in Settings → Memory & RAG (toggles the Switch on for this workspace; ` +
            `ingestion will run automatically on first enable).`,
        };
      }
      if (wsTotal === 0) {
        return {
          status: 'executed',
          output:
            `RAG index for this workspace is empty. ` +
            `Re-trigger ingestion from Settings → Memory & RAG → Re-index.`,
        };
      }
      return {
        status: 'executed',
        output: `No matches for "${query}" across ${grandTotal} indexed chunks.`,
      };
    }

    // 6. Format. Truncate body to BODY_CAP chars to keep the tool result
    //    readable and avoid bloating the model's context.
    const BODY_CAP = 1500;
    const lines = fused.map((hit, i) => {
      const loc = 'sourceName' in hit
        ? `[${hit.sourceName}] ${hit.path}`
        : `${shortPath(hit.path)}:${hit.startLine}` +
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
      `for "${query}" (out of ${grandTotal}):\n\n${lines.join('\n\n')}`;

    return {
      status: 'executed',
      output: text,
      // `display.kind:'text'` makes ToolCallCard render the body in a collapsible section (like web_search/web_fetch). Without it the card shows only the header — the user sees the tool was called but can't read what it found.
      display: { kind: 'text', text },
    };
  } finally {
    ragStore?.close();
  }
}

/** Search the global knowledge-sources index. Best-effort by design: any
 *  failure here (db missing/corrupt, registry error) degrades to "no
 *  knowledge results" so a broken global DB never fails the tool. */
async function searchKnowledgeSources(opts: {
  workspaceId: string;
  query: string;
  k: number;
  prepareQuery: () => Promise<PreparedQuery>;
}): Promise<{ hits: KnowledgeHit[]; total: number }> {
  try {
    const dbPath = knowledgeDbPath();
    // existsSync guard: openRagStoreAt would otherwise create an empty db as a side effect of every query.
    if (!fs.existsSync(dbPath)) return NO_KNOWLEDGE;
    const ks = openKnowledgeStore(dbPath);
    try {
      const { embedderId, queryVec } = await opts.prepareQuery();
      // First-embedder-wins pinning (meta.embedderId): silently skip on
      // mismatch — unlike the workspace path, which surfaces an error.
      const pinned = ks.rag.getMeta('embedderId');
      if (pinned && pinned !== embedderId) return NO_KNOWLEDGE;

      const enabledIds = new Set(ks.enabledSourceIdsFor(opts.workspaceId));
      const sources = ks.listSources();
      // Total counts only what this workspace can see — chunks behind
      // disabled sources must not leak into the reported coverage.
      const visibleChunks = sources
        .filter((s) => enabledIds.has(s.id))
        .reduce((n, s) => n + s.chunkCount, 0);
      if (enabledIds.size === 0 || visibleChunks === 0) return NO_KNOWLEDGE;

      const names = new Map(ks.listSources().map((s) => [s.id, s.name] as const));
      // Over-fetch then filter by sourceId: cheap post-filtering beats
      // sqlite-vec metadata-filter complexity (plan decision 4).
      const overFetch = opts.k * 3;
      const isEnabled = (
        h: VectorHit | FtsHit,
      ): h is (VectorHit | FtsHit) & { sourceId: string } =>
        h.sourceId != null && enabledIds.has(h.sourceId);
      const kVec = ks.rag.queryByVector(queryVec, overFetch).filter(isEnabled);
      const kFts = ks.rag.queryByFts(opts.query, overFetch).filter(isEnabled);
      const hits: KnowledgeHit[] = fuse(kVec, kFts, opts.k).map((h) => ({
        ...h,
        sourceName: names.get(h.sourceId) ?? h.sourceId,
      }));
      return { hits, total: visibleChunks };
    } finally {
      // A close() failure here must not discard already-computed hits.
      try {
        ks.close();
      } catch {
        /* nothing actionable */
      }
    }
  } catch (e) {
    console.warn(
      '[memory] knowledge search skipped:',
      e instanceof Error ? e.message : String(e),
    );
    return NO_KNOWLEDGE;
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
      'and registered knowledge sources by meaning and returns ranked chunks in ~0.5s. ' +
      'Call this BEFORE directory_tree, list_dir, read_file, or grep. Returns file path + ' +
      'line range + source body for each match; knowledge-source hits are labeled [source] origin ' +
      '(e.g. [React Docs] react.dev/learn) — cite that origin when using them. ' +
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
      'and registered knowledge sources by meaning and returns ranked chunks in ~0.5s. ' +
      'Call BEFORE directory_tree, list_dir, read_file, or grep. Returns file path + line ' +
      'range + source body; knowledge-source hits are labeled [source] origin.',
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
