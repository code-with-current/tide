/** multi_edit tool: batch string-replacement edits in one file, atomically (any failed edit leaves the file untouched and fails the call with the bad edit's index). Latency win over N edit_file calls; reuses edit_file's diff builder. */

import * as fs from 'fs';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveAndFollowSymlinks } from '../path-safety';
import type { DiffHunk, DiffLine } from '../../../src/types/index';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

interface EditOp {
  old_string: string;
  new_string: string;
}

/** Shared body — needs only workspaceRoot for path resolution. */
export async function runMultiEdit(
  relPath: string,
  edits: EditOp[],
  workspaceRoot: string,
): Promise<ToolResult> {
  if (!relPath) return { status: 'failed', output: 'Missing required arg: path' };
  if (edits.length === 0) return { status: 'failed', output: 'Missing or empty required arg: edits' };

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

  // Apply edits in order. Each edit must be unique *at apply time* —
  // earlier edits may have changed the text a later edit matches.
  let current = original;
  const applied: { index: number; lineNo: number }[] = [];
  for (let i = 0; i < edits.length; i++) {
    const op = edits[i];
    if (!op || !op.old_string) {
      return { status: 'failed', output: `Edit ${i}: missing old_string. File unchanged.` };
    }
    const occurrences: number[] = [];
    let idx = current.indexOf(op.old_string);
    while (idx !== -1) {
      const lineNo = current.slice(0, idx).split('\n').length;
      occurrences.push(lineNo);
      idx = current.indexOf(op.old_string, idx + 1);
    }
    if (occurrences.length === 0) {
      return {
        status: 'failed',
        output: `Edit ${i} (${i + 1}/${edits.length}): old_string not found. File unchanged. Check whitespace and indentation.`,
      };
    }
    if (occurrences.length > 1) {
      return {
        status: 'failed',
        output: `Edit ${i} (${i + 1}/${edits.length}): old_string not unique — matches at lines ${occurrences.join(', ')}. Add more context. File unchanged.`,
      };
    }
    current = current.replace(op.old_string, op.new_string);
    applied.push({ index: i, lineNo: occurrences[0] });
  }

  try {
    fs.writeFileSync(abs, current, 'utf-8');
  } catch (e: any) {
    return { status: 'failed', output: `Write failed: ${e.message}` };
  }

  const hunks = buildMultiDiff(original, current, relPath);
  const additions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0);
  const deletions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0);

  return {
    status: 'executed',
    output: `Applied ${applied.length} edits to ${relPath}: +${additions} −${deletions} lines.`,
    meta: `${applied.length} edits · +${additions} −${deletions}`,
    display: { kind: 'diff', path: relPath, hunks, additions, deletions },
  };
}

const editOpSchema = z.object({
  old_string: z.string(),
  new_string: z.string(),
});

export const multiEditTool: ToolRegistration = {
  name: 'multi_edit',
  definition: {
    name: 'multi_edit',
    description:
      'Apply multiple string-replacement edits to a single file in one atomic call. ' +
      'Each edit must have a unique old_string (same rule as edit_file). If any edit ' +
      'fails, the file is left unchanged and the call returns the failing edit index. ' +
      'Edits apply in order: earlier edits can change text that later edits match. ' +
      'Use this instead of N separate edit_file calls for multi-spot refactors.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace root.' },
        edits: {
          type: 'array',
          description: 'Ordered list of edits to apply.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text to find (must be unique at apply time).' },
              new_string: { type: 'string', description: 'Replacement text.' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  riskTier: 'write',
  requiresWorktree: false,
  timeoutMs: 15_000,
  autoApproveIn: ['edit', 'full'],
  execute: async (args, ctx) =>
    runMultiEdit(
      String(args.path ?? ''),
      Array.isArray(args.edits) ? (args.edits as EditOp[]) : [],
      ctx.workspaceRoot,
    ),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────

export function createMultiEditTool(ctx: ToolContext) {
  return tool({
    description:
      'Apply multiple string-replacement edits to a single file in one atomic call. ' +
      'Each edit must have a unique old_string (same rule as edit_file). If any edit ' +
      'fails, the file is left unchanged and the call returns the failing edit index. ' +
      'Edits apply in order: earlier edits can change text that later edits match. ' +
      'Use this instead of N separate edit_file calls for multi-spot refactors.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to workspace root.'),
      edits: z.array(editOpSchema).describe('Ordered list of edits to apply.'),
    }),
    execute: async ({ path, edits }) =>
      withPermission(ctx, 'multi_edit', { path, edits }, () =>
        runMultiEdit(path, edits as EditOp[], ctx.workspaceRoot),
      ),
  });
}

/** Build a diff with one hunk per changed region — coarser than a real diff algorithm but enough for the UI (3 lines of context per contiguous change). */
function buildMultiDiff(before: string, after: string, path: string): DiffHunk[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  // Use a simple LCS-free approach: walk both, find runs of difference.
  // For typical multi-edit workloads (a handful of changes), this is fine.
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  const diffMask: boolean[] = [];
  for (let i = 0; i < maxLen; i++) {
    diffMask.push(beforeLines[i] !== afterLines[i]);
  }
  // Find contiguous runs of true.
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < maxLen) {
    if (!diffMask[i]) { i++; continue; }
    const start = i;
    while (i < maxLen && diffMask[i]) i++;
    const end = i - 1;
    const ctxStart = Math.max(0, start - 3);
    const ctxEnd = Math.min(maxLen - 1, end + 3);
    const lines: DiffLine[] = [];
    lines.push({
      type: 'hunk',
      text: `@@ -${ctxStart + 1},${end - ctxStart + 1} +${ctxStart + 1},${end - ctxStart + 1} @@ ${path}`,
    });
    for (let j = ctxStart; j <= end; j++) {
      if (j < start || j > end) {
        if (beforeLines[j] !== undefined) {
          lines.push({ type: 'context', oldNo: j + 1, newNo: j + 1, text: beforeLines[j] });
        }
      } else {
        if (beforeLines[j] !== undefined) {
          lines.push({ type: 'del', oldNo: j + 1, text: beforeLines[j] });
        }
        if (afterLines[j] !== undefined) {
          lines.push({ type: 'add', newNo: j + 1, text: afterLines[j] });
        }
      }
    }
    // Trailing context.
    for (let j = end + 1; j <= ctxEnd; j++) {
      if (beforeLines[j] !== undefined && beforeLines[j] === afterLines[j]) {
        lines.push({ type: 'context', oldNo: j + 1, newNo: j + 1, text: beforeLines[j] });
      }
    }
    hunks.push({ header: lines[0].text, lines: lines.slice(1) });
  }
  return hunks;
}
