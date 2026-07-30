/**
 * list_dir tool — non-recursive directory listing.
 *
 * Returns a `file_list` display with names + kinds. Caps at 500 entries to
 * bound output size.
 *
 * Migration state (Phase 2): dual export per the bash.ts pattern.
 */

import * as fs from 'fs';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../path-safety';
import { withPermission } from '../permission-wrapper';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';

const MAX_ENTRIES = 500;

export async function runListDir(
  relPath: string,
  workspaceRoot: string,
): Promise<{
  status: 'executed' | 'failed';
  output: string;
  meta?: string;
  display?: { kind: 'file_list'; paths: string[] };
}> {
  let abs: string;
  try {
    abs = resolveInsideWorkspace(workspaceRoot, relPath || '.');
  } catch (e: any) {
    return { status: 'failed', output: `Path error: ${e.message}` };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e: any) {
    return { status: 'failed', output: `Cannot read dir: ${e.message}` };
  }

  // Sort: dirs first, then files, alphabetical within each.
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const overCap = entries.length > MAX_ENTRIES;
  const shown = overCap ? entries.slice(0, MAX_ENTRIES) : entries;

  const names = shown.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  const listing = names.join('\n');
  const note = overCap ? `\n\n(truncated at ${MAX_ENTRIES} entries; ${entries.length} total)` : '';
  const meta = `${entries.length} entries`;

  return {
    status: 'executed',
    output: listing + note,
    meta,
    display: { kind: 'file_list', paths: names },
  };
}

// ─── Legacy envelope (deleted in Phase 3) ──────────────────────────────

export const listDirTool: ToolRegistration = {
  name: 'list_dir',
  definition: {
    name: 'list_dir',
    description:
      'List the entries in a directory (non-recursive). Use this to discover ' +
      'the structure of a folder before reading specific files. Returns names ' +
      'and kinds (file/dir). Hidden entries (starting with .) are included.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root. Defaults to root.' },
      },
      required: [],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 5_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runListDir(typeof args.path === 'string' ? args.path : '', ctx.workspaceRoot),
};

// ─── New SDK factory envelope (Phase 3+) ───────────────────────────────

export function createListDirTool(ctx: ToolContext) {
  return tool({
    description:
      'List the entries in a directory (non-recursive). Use this to discover ' +
      'the structure of a folder before reading specific files. Returns names ' +
      'and kinds (file/dir). Hidden entries (starting with .) are included.',
    inputSchema: z.object({
      path: z.string().optional().describe('Directory path relative to workspace root. Defaults to root.'),
    }),
    execute: async ({ path }) =>
      withPermission(ctx, 'list_dir', { path }, () =>
        runListDir(path ?? '', ctx.workspaceRoot),
      ),
  });
}
