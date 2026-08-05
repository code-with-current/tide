/** edit_file tool: replace a unique exact string match in a file; refuses (with all match line numbers) if old_string isn't unique. Returns a unified-diff display; the permission gate is the safety net without worktree isolation. */

import * as fs from 'fs';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveAndFollowSymlinks } from '../path-safety';
import { withPermission } from '../permission-wrapper';
import type { DiffHunk, DiffLine } from '../../../src/types/index';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';

export async function runEditFile(
  relPath: string,
  oldStr: string,
  newStr: string,
  workspaceRoot: string,
): Promise<{
  status: 'executed' | 'failed';
  output: string;
  meta?: string;
  display?: { kind: 'diff'; path: string; hunks: DiffHunk[]; additions: number; deletions: number };
}> {
  if (!relPath) return { status: 'failed', output: 'Missing required arg: path' };
  if (!oldStr) return { status: 'failed', output: 'Missing required arg: old_string' };

  let abs: string;
  try {
    abs = resolveAndFollowSymlinks(workspaceRoot, relPath);
  } catch (e: any) {
    return { status: 'failed', output: `Path error: ${e.message}` };
  }

  let original: string;
  try {
    original = fs.readFileSync(abs, 'utf-8');
  } catch (e: any) {
    return { status: 'failed', output: `Cannot read file: ${e.message}` };
  }

  // Find all occurrences with their line numbers.
  const occurrences: number[] = [];
  let idx = original.indexOf(oldStr);
  while (idx !== -1) {
    const lineNo = original.slice(0, idx).split('\n').length;
    occurrences.push(lineNo);
    idx = original.indexOf(oldStr, idx + 1);
  }

  if (occurrences.length === 0) {
    return {
      status: 'failed',
      output: `old_string not found in ${relPath}. Check whitespace, indentation, and exact characters.`,
    };
  }
  if (occurrences.length > 1) {
    return {
      status: 'failed',
      output: `old_string is not unique — matches at lines: ${occurrences.join(', ')}. Add more surrounding context to old_string to make it unique.`,
    };
  }

  const updated = original.replace(oldStr, newStr);
  try {
    fs.writeFileSync(abs, updated, 'utf-8');
  } catch (e: any) {
    return { status: 'failed', output: `Write failed: ${e.message}` };
  }

  const hunks = buildUnifiedDiff(original, updated, relPath);
  const additions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0);
  const deletions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0);

  return {
    status: 'executed',
    output: `Edited ${relPath}: replaced 1 occurrence, +${additions} −${deletions} lines.`,
    meta: `+${additions} −${deletions}`,
    display: { kind: 'diff', path: relPath, hunks, additions, deletions },
  };
}

// ─── Legacy envelope (deleted in Phase 3) ──────────────────────────────

export const editFileTool: ToolRegistration = {
  name: 'edit_file',
  definition: {
    name: 'edit_file',
    description:
      'Edit a file by replacing a unique exact string match. If old_string ' +
      'appears more than once, the call fails with the line numbers of all ' +
      'matches — provide more context in old_string to disambiguate. The file ' +
      'must already exist; use write_file for new files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace root.' },
        old_string: { type: 'string', description: 'Exact text to find (must be unique).' },
        new_string: { type: 'string', description: 'Text to replace it with.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  riskTier: 'write',
  requiresWorktree: false,
  timeoutMs: 10_000,
  autoApproveIn: ['edit', 'full'],
  execute: async (args, ctx) =>
    runEditFile(
      String(args.path ?? ''),
      String(args.old_string ?? ''),
      String(args.new_string ?? ''),
      ctx.workspaceRoot,
    ),
};

// ─── New SDK factory envelope (Phase 3+) ───────────────────────────────

export function createEditFileTool(ctx: ToolContext) {
  return tool({
    description:
      'Edit a file by replacing a unique exact string match. If old_string ' +
      'appears more than once, the call fails with the line numbers of all ' +
      'matches — provide more context in old_string to disambiguate. The file ' +
      'must already exist; use write_file for new files.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to workspace root.'),
      old_string: z.string().describe('Exact text to find (must be unique).'),
      new_string: z.string().describe('Text to replace it with.'),
    }),
    execute: async ({ path: p, old_string, new_string }) =>
      withPermission(ctx, 'edit_file', { path: p, old_string, new_string }, () =>
        runEditFile(p, old_string, new_string, ctx.workspaceRoot),
      ),
  });
}

/** Build a minimal unified-diff view: one hunk with 3 lines of context above/below the changed region. Sufficient for the UI card; not a full `diff -u` reimplementation. */
function buildUnifiedDiff(before: string, after: string, path: string): DiffHunk[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let startOld = 0;
  const max = Math.min(beforeLines.length, afterLines.length);
  while (startOld < max && beforeLines[startOld] === afterLines[startOld]) startOld++;

  let endOld = beforeLines.length - 1;
  let endNew = afterLines.length - 1;
  while (endOld > startOld && endNew > startOld && beforeLines[endOld] === afterLines[endNew]) {
    endOld--;
    endNew--;
  }

  const ctxStart = Math.max(0, startOld - 3);
  const headerOldNo = ctxStart + 1;
  const headerNewNo = ctxStart + 1;

  const trailingCtx: string[] = [];
  let k = endNew;
  let j = endOld;
  while (j > startOld && k > startOld && beforeLines[j] === afterLines[k]) {
    trailingCtx.unshift(afterLines[k]);
    j--; k--;
  }
  const addedLines = afterLines.slice(startOld, k + 1);

  const cleanLines: DiffLine[] = [];
  cleanLines.push({
    type: 'hunk',
    text: `@@ -${headerOldNo},${endOld - ctxStart + 1} +${headerNewNo},${endNew - ctxStart + 1} @@ ${path}`,
  });
  for (let i = ctxStart; i < startOld; i++) {
    cleanLines.push({ type: 'context', oldNo: i + 1, newNo: i + 1, text: beforeLines[i] });
  }
  for (let i = startOld; i <= endOld; i++) {
    cleanLines.push({ type: 'del', oldNo: i + 1, text: beforeLines[i] });
  }
  for (const ln of addedLines) {
    cleanLines.push({ type: 'add', newNo: 0, text: ln });
  }
  for (let i = 0; i < trailingCtx.length; i++) {
    cleanLines.push({ type: 'context', text: trailingCtx[i] });
  }

  return [{ header: cleanLines[0].text, lines: cleanLines.slice(1) }];
}
