/** grep tool: search file contents (not names — that's list_dir) using ripgrep when available, falling back to a Node implementation. Caps at maxResults (default 100) lines so a pattern matching every line doesn't blow up context. */

import { spawnSync } from 'child_process';
import { toolEnv } from './tool-env';
import * as fs from 'fs';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../path-safety';
import { redact } from '../redaction';
import { getToolMeta } from './tool-meta';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

const MAX_RESULTS = 100;

/** Shared body — needs workspaceRoot (resolve) + timeoutMs (rg spawn timeout). */
export async function runGrep(
  pattern: string,
  relPath: string,
  glob: string,
  maxResults: number,
  workspaceRoot: string,
  timeoutMs: number,
): Promise<ToolResult> {
  if (!pattern) return { status: 'failed', output: 'Missing required arg: pattern' };

  let abs: string;
  try {
    abs = resolveInsideWorkspace(workspaceRoot, relPath || '.');
  } catch (e: any) {
    return { status: 'failed', output: `Path error: ${e.message}` };
  }

  // Try ripgrep first.
  const rgArgs = ['--line-number', '--no-heading', '--color=never', '--max-count', String(maxResults)];
  if (glob) rgArgs.push('--glob', glob);
  rgArgs.push('--', pattern, abs);

  try {
    const result = spawnSync('rg', rgArgs, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: toolEnv(),
    });
    if (result.status === 0 || result.stdout) {
      // rg returns exit 1 for "no matches" — that's not an error.
      const out = (result.stdout || '').trim();
      return {
        status: 'executed',
        output: out || '(no matches)',
        meta: out ? `${out.split('\n').length} matches` : '0 matches',
        display: { kind: 'text', text: out || '(no matches)' },
      };
    }
    // rg errored (not installed, bad regex, etc.) — fall through to Node impl.
    if (result.error && !(result.error as any).code === 'ENOENT') {
      // Real error from rg, not "binary not found".
      const msg = (result.stderr || result.error.message || '').trim();
      return { status: 'failed', output: `rg error: ${msg.slice(0, 200)}` };
    }
  } catch {
    // fall through to Node impl
  }

  // Node fallback — slower but works without rg.
  try {
    const re = new RegExp(pattern, 'i');
    const matches = grepNode(abs, re, glob, maxResults);
    const out = matches.join('\n');
    return {
      status: 'executed',
      output: redact(out) || '(no matches)',
      meta: `${matches.length} matches`,
      display: { kind: 'text', text: redact(out) || '(no matches)' },
    };
  } catch (e: any) {
    return { status: 'failed', output: `Bad regex: ${e.message}` };
  }
}

export const grepTool: ToolRegistration = {
  name: 'grep',
  definition: {
    name: 'grep',
    description:
      'Search file contents with a regular expression. Uses ripgrep if installed ' +
      'for speed; falls back to a Node implementation. Returns matching lines with ' +
      'file:line prefixes. Defaults to searching the whole workspace; pass `path` ' +
      'to scope to a subdirectory. Use `glob` to filter file patterns (e.g. "*.ts").',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Directory or file to search. Defaults to workspace root.' },
        glob: { type: 'string', description: 'File glob filter, e.g. "*.ts" or "**/*.test.ts".' },
        maxResults: { type: 'number', description: `Max matching lines to return. Default ${MAX_RESULTS}.` },
      },
      required: ['pattern'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 15_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runGrep(
      String(args.pattern ?? ''),
      typeof args.path === 'string' ? args.path : '',
      typeof args.glob === 'string' ? args.glob : '',
      typeof args.maxResults === 'number' ? args.maxResults : MAX_RESULTS,
      ctx.workspaceRoot,
      ctx.timeoutMs,
    ),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────

export function createGrepTool(ctx: ToolContext) {
  return tool({
    description:
      'Search file contents with a regular expression. Uses ripgrep if installed ' +
      'for speed; falls back to a Node implementation. Returns matching lines with ' +
      'file:line prefixes. Defaults to searching the whole workspace; pass `path` ' +
      'to scope to a subdirectory. Use `glob` to filter file patterns (e.g. "*.ts").',
    inputSchema: z.object({
      pattern: z.string().describe('Regular expression to search for.'),
      path: z.string().optional().describe('Directory or file to search. Defaults to workspace root.'),
      glob: z.string().optional().describe('File glob filter, e.g. "*.ts" or "**/*.test.ts".'),
      maxResults: z.number().optional().describe('Max matching lines to return. Default 100.'),
    }),
    execute: async ({ pattern, path, glob, maxResults }) =>
      withPermission(ctx, 'grep', { pattern, path, glob, maxResults }, () =>
        runGrep(
          pattern,
          path ?? '',
          glob ?? '',
          maxResults ?? MAX_RESULTS,
          ctx.workspaceRoot,
          getGrepTimeoutMs(),
        ),
      ),
  });
}

/** Read the grep timeout from toolMeta. bash.ts uses the same pattern —
 *  toolMeta is the single source for per-tool timeouts now that the SDK
 *  ToolContext no longer carries timeoutMs. */
function getGrepTimeoutMs(): number {
  return getToolMeta('grep').timeoutMs;
}

/** Recursive Node-based grep fallback. Returns `path:line:match` strings. */
function grepNode(root: string, re: RegExp, glob: string, max: number): string[] {
  const out: string[] = [];
  const globRe = glob ? new RegExp(globToRegex(glob)) : null;
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'next', '.cache']);

  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (skip.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.agent') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        if (globRe && !globRe.test(e.name)) continue;
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (out.length >= max) return;
            if (re.test(lines[i])) {
              out.push(`${full}:${i + 1}:${lines[i]}`);
            }
          }
        } catch {
          // binary or unreadable — skip
        }
      }
    }
  };

  walk(root);
  return out;
}

/** Convert a shell glob to a RegExp. Supports * and **. */
function globToRegex(glob: string): string {
  return glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
}
