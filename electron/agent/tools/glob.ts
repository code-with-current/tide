/**
 * glob tool — find files by pattern.
 *
 * Dedicated tool (not a shell `find` wrapper) so the model gets structured
 * results instead of freeform command output. Supports the common glob
 * syntax: *, **, ?, character classes. Respects a basic .gitignore
 * (node_modules, .git, dist) by default.
 */

import * as fs from 'fs';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveAndFollowSymlinks } from '../path-safety';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

const MAX_RESULTS = 200;
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'release', '.next', '.cache']);

/** Shared body — takes the parsed args + workspaceRoot (the only ctx field it needs). */
export async function runGlob(
  pattern: string,
  relPath: string,
  workspaceRoot: string,
): Promise<ToolResult> {
  if (!pattern) return { status: 'failed', output: 'Missing required arg: pattern' };

  let root: string;
  try {
    root = relPath
      ? resolveAndFollowSymlinks(workspaceRoot, relPath)
      : workspaceRoot;
  } catch (e: any) {
    return { status: 'failed', output: `Path error: ${e.message}` };
  }

  try {
    const stats = fs.statSync(root);
    if (!stats.isDirectory()) {
      return { status: 'failed', output: `Not a directory: ${relPath || '(root)'}` };
    }
  } catch {
    return { status: 'failed', output: `Directory not found: ${relPath || '(root)'}` };
  }

  const matches: string[] = [];
  const regex = globToRegex(pattern);
  walk(root, '', (rel) => {
    if (matches.length >= MAX_RESULTS) return false;
    // Normalize to forward slashes for matching + display.
    const normalized = rel.split(path.sep).join('/');
    if (regex.test(normalized)) {
      matches.push(normalized);
    }
    return true;
  });

  if (matches.length === 0) {
    return {
      status: 'executed',
      output: `No files matching "${pattern}" in ${relPath || '.'}.`,
      meta: '0 matches',
      display: { kind: 'file_list', paths: [] },
    };
  }

  matches.sort();
  return {
    status: 'executed',
    output: `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${pattern}":\n${matches.slice(0, 50).join('\n')}${matches.length > 50 ? `\n…and ${matches.length - 50} more` : ''}`,
    meta: `${matches.length} files`,
    display: { kind: 'file_list', paths: matches },
  };
}

export const globTool: ToolRegistration = {
  name: 'glob',
  definition: {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Supports * (single segment), ** (any depth), ' +
      '? (single char), and [abc] (char class). Returns up to 200 paths relative to ' +
      'the workspace root. Ignores node_modules/.git/dist by default. Faster than ' +
      'list_dir when you know the extension or naming pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "src/**/*.tsx", "**/*.test.ts", "lib/*.md".',
        },
        path: {
          type: 'string',
          description: 'Subdirectory to search in (relative to workspace root). Defaults to workspace root.',
        },
      },
      required: ['pattern'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 10_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runGlob(String(args.pattern ?? ''), typeof args.path === 'string' ? args.path : '', ctx.workspaceRoot),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────

export function createGlobTool(ctx: ToolContext) {
  return tool({
    description:
      'Find files matching a glob pattern. Supports * (single segment), ** (any depth), ' +
      '? (single char), and [abc] (char class). Returns up to 200 paths relative to ' +
      'the workspace root. Ignores node_modules/.git/dist by default. Faster than ' +
      'list_dir when you know the extension or naming pattern.',
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern, e.g. "src/**/*.tsx", "**/*.test.ts", "lib/*.md".'),
      path: z.string().optional().describe('Subdirectory to search in (relative to workspace root). Defaults to workspace root.'),
    }),
    execute: async ({ pattern, path }) =>
      withPermission(ctx, 'glob', { pattern, path }, () => runGlob(pattern, path ?? '', ctx.workspaceRoot)),
  });
}

/** Walk a directory tree, calling visitor(relPath) for every file. Visitor
 *  returns false to stop the walk (used for the MAX_RESULTS cap). */
function walk(rootAbs: string, relDir: string, visit: (relPath: string) => boolean): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const childAbs = path.join(rootAbs, entry.name);
      walk(childAbs, childRel, visit);
    } else if (entry.isFile()) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (!visit(rel)) return;
    }
  }
}

/** Convert a glob pattern to a RegExp. Supports *, **, ?, [abc]. */
function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // ** — match any number of path segments (including zero).
      i += 2;
      if (pattern[i] === '/') i++;
      re += '.*';
    } else if (c === '*') {
      // * — match within a single path segment (not /).
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      // Pass through character classes.
      const end = pattern.indexOf(']', i);
      if (end === -1) { re += '\\['; i++; }
      else { re += pattern.slice(i, end + 1); i = end + 1; }
    } else if ('.+^${}()|\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}
