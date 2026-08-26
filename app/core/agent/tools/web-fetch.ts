/** web_fetch tool: fetch a URL and return its text content (basic HTML tag-stripping, not a full readability extractor); caps response size to bound token cost. */

import { tool } from 'ai';
import { z } from 'zod';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

const MAX_BYTES = 64 * 1024; // 64 KB cap

/** Shared body — no ctx dependency (network only), so takes just the URL. */
export async function runWebFetch(url: string): Promise<ToolResult> {
  if (!url) return { status: 'failed', output: 'Missing required arg: url' };
  if (!/^https?:\/\//i.test(url)) {
    return { status: 'failed', output: `URL must start with http:// or https:// (got: ${url})` };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Tide/1.0 (coding agent)' },
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      return { status: 'failed', output: `HTTP ${resp.status} ${resp.statusText}` };
    }
    const contentType = resp.headers.get('content-type') ?? '';
    const raw = await resp.text();
    const truncated = raw.length > MAX_BYTES;
    const body = truncated ? raw.slice(0, MAX_BYTES) : raw;

    // Strip HTML if it looks like HTML. JSON / plain text pass through.
    let text: string;
    if (contentType.includes('text/html') || /<\/?(html|body|div|p|a)\b/i.test(body)) {
      text = stripHtml(body);
    } else {
      text = body;
    }

    const note = truncated ? ` (truncated at ${MAX_BYTES.toLocaleString()} bytes; full response was ${raw.length.toLocaleString()} bytes)` : '';
    return {
      status: 'executed',
      output: text.slice(0, MAX_BYTES),
      meta: `${raw.length.toLocaleString()} bytes${note ? ' · truncated' : ''}`,
      display: { kind: 'text', text: text + (truncated ? `\n\n[truncated at ${MAX_BYTES} bytes]` : '') },
    };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'timed out after 15s' : (e?.message || String(e));
    return { status: 'failed', output: `Fetch failed: ${msg}` };
  }
}

export const webFetchTool: ToolRegistration = {
  name: 'web_fetch',
  definition: {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its content as text. Strips HTML tags into readable prose. ' +
      'Use for documentation, API references, or any web resource the task requires. ' +
      'Capped at 64KB. Use web_search first if you do not have a specific URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
      },
      required: ['url'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 20_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, _ctx) => runWebFetch(String(args.url ?? '')),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────

export function createWebFetchTool(ctx: ToolContext) {
  return tool({
    description:
      'Fetch a URL and return its content as text. Strips HTML tags into readable prose. ' +
      'Use for documentation, API references, or any web resource the task requires. ' +
      'Capped at 64KB. Use web_search first if you do not have a specific URL.',
    inputSchema: z.object({
      url: z.string().describe('Absolute http(s) URL to fetch.'),
    }),
    execute: async ({ url }) =>
      withPermission(ctx, 'web_fetch', { url }, () => runWebFetch(url)),
  });
}

/** Minimal HTML-to-text: drop tags, decode entities, collapse whitespace. */
function stripHtml(html: string): string {
  return html
    // Drop script/style blocks wholesale.
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert block-level closers to newlines so prose stays readable.
    .replace(/<\/(p|div|li|h[1-6]|tr|br|article|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Drop all remaining tags.
    .replace(/<[^>]+>/g, '')
    // Decode common entities.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // Collapse runs of blank lines.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
