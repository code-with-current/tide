/**
 * web_search tool — proxies through the Tide search Cloudflare Worker.
 *
 * Architecture:
 *   Electron client → Cloudflare Worker → DuckDuckGo scrape
 *
 * Why a worker instead of scraping directly from the client:
 *   - Server IP avoids DDG's anti-bot challenges (client residential IPs
 *     sometimes get hit; Cloudflare egress IPs are stable)
 *   - Markup-fix lives in ONE place — redeploy the worker, no client update
 *   - JSON response shape — client doesn't parse HTML at all
 *   - Ad filtering happens server-side; client sees clean results
 *
 * Returns up to 10 results with title, URL, snippet.
 *
 * If the worker URL needs to change, override via TIDE_SEARCH_WORKER_URL env
 * var. Default points at the production deployment.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_RESULTS = 10;

// Default worker deployment. Override at runtime via env var if you spin up
// your own worker (e.g. self-hosted or a different Cloudflare account).
const WORKER_URL =
  process.env.TIDE_SEARCH_WORKER_URL ?? 'https://sumo-search.nmapp.workers.dev';

/** Shared body — network only, no ctx dependency. */
export async function runWebSearch(query: string): Promise<ToolResult> {
  const q = query.trim();
  if (!q) return { status: 'failed', output: 'Missing required arg: query' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const { results, engine } = await searchViaWorker(q, controller.signal);
    if (results.length === 0) {
      return {
        status: 'failed',
        output: `No results for "${q}".`,
      };
    }
    const top = results.slice(0, MAX_RESULTS);
    const text = top.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
    ).join('\n\n');
    return {
      status: 'executed',
      output: text,
      meta: `${top.length} results · ${engine}`,
      display: { kind: 'text', text },
    };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'timed out after 12s' : (e?.message || String(e));
    return { status: 'failed', output: `Search failed: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}

export const webSearchTool: ToolRegistration = {
  name: 'web_search',
  definition: {
    name: 'web_search',
    description:
      'Search the web for a query and return up to 10 results with title, URL, and snippet. ' +
      'Use to find documentation, library APIs, error messages, or recent information. ' +
      'Pair with web_fetch to read a specific result in full.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
      },
      required: ['query'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 15_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, _ctx) => runWebSearch(String(args.query ?? '')),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────

export function createWebSearchTool(ctx: ToolContext) {
  return tool({
    description:
      'Search the web for a query and return up to 10 results with title, URL, and snippet. ' +
      'Use to find documentation, library APIs, error messages, or recent information. ' +
      'Pair with web_fetch to read a specific result in full.',
    inputSchema: z.object({
      query: z.string().describe('Search query.'),
    }),
    execute: async ({ query }) =>
      withPermission(ctx, 'web_search', { query }, () => runWebSearch(query)),
  });
}

// ─── Worker proxy call ────────────────────────────────────────

interface WorkerResponse {
  query?: string;
  count?: number;
  /** Which search engine actually served the results — useful for diagnostics. */
  engine?: string;
  results?: SearchResult[];
  error?: string;
}

/** Call the Tide search worker. Throws on non-2xx or network failure.
 *  Returns results + the engine that served them (for the meta tag). */
async function searchViaWorker(
  query: string,
  signal: AbortSignal,
): Promise<{ results: SearchResult[]; engine: string }> {
  const url = `${WORKER_URL}/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const resp = await fetch(url, {
    signal,
    headers: { 'Accept': 'application/json' },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Worker HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as WorkerResponse;
  if (data.error) {
    throw new Error(`Worker: ${data.error}`);
  }
  return { results: data.results ?? [], engine: data.engine ?? 'unknown' };
}
