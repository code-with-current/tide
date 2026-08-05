/** notebook_edit tool: edit a Jupyter (.ipynb) cell by index, handling the JSON shape (source is an array of lines) so the model passes source as a plain string. Modes: replace / insert / delete / append. */

import * as fs from 'fs';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveAndFollowSymlinks } from '../path-safety';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string[];
  metadata?: Record<string, unknown>;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

type EditMode = 'replace' | 'insert' | 'delete' | 'append';

/** Shared body. */
export async function runNotebookEdit(
  relPath: string,
  mode: EditMode,
  cellType: NotebookCell['cell_type'],
  source: string | null,
  cellIndex: number,
  workspaceRoot: string,
): Promise<ToolResult> {
  if (!relPath) return { status: 'failed', output: 'Missing required arg: path' };
  if (!relPath.endsWith('.ipynb')) {
    return { status: 'failed', output: `Path must end in .ipynb (got: ${relPath})` };
  }

  if ((mode === 'replace' || mode === 'insert' || mode === 'append') && source == null) {
    return { status: 'failed', output: `source is required for mode="${mode}"` };
  }
  if ((mode === 'replace' || mode === 'insert' || mode === 'delete') && cellIndex < 0) {
    return { status: 'failed', output: `cell_index is required for mode="${mode}"` };
  }

  let abs: string;
  try {
    abs = resolveAndFollowSymlinks(workspaceRoot, relPath);
  } catch (e: any) {
    return { status: 'failed', output: `Path error: ${e.message}` };
  }

  let nb: Notebook;
  try {
    nb = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (e: any) {
    return { status: 'failed', output: `Cannot read notebook: ${e.message}` };
  }
  if (!Array.isArray(nb.cells)) {
    return { status: 'failed', output: 'Notebook has no cells array — malformed .ipynb' };
  }

  const sourceAsArray = (s: string): string[] => {
    const lines = s.split('\n');
    // Jupyter source keeps trailing newlines on every line except the last.
    return lines.map((line, i) => i < lines.length - 1 ? line + '\n' : line);
  };

  const newCell: NotebookCell = {
    cell_type: cellType,
    source: source != null ? sourceAsArray(source) : [],
    metadata: {},
  };

  // Normalize code-cell outputs/metadata so new cells don't break viewers.
  if (cellType === 'code') {
    (newCell as any).execution_count = null;
    (newCell as any).outputs = [];
  }

  let action: string;
  try {
    switch (mode) {
      case 'replace':
        if (cellIndex >= nb.cells.length) {
          return { status: 'failed', output: `cell_index ${cellIndex} out of range (have ${nb.cells.length} cells)` };
        }
        nb.cells[cellIndex] = newCell;
        action = `replaced cell ${cellIndex}`;
        break;
      case 'insert':
        if (cellIndex > nb.cells.length) {
          return { status: 'failed', output: `cell_index ${cellIndex} out of range (have ${nb.cells.length} cells)` };
        }
        nb.cells.splice(cellIndex, 0, newCell);
        action = `inserted cell at ${cellIndex}`;
        break;
      case 'delete':
        if (cellIndex >= nb.cells.length) {
          return { status: 'failed', output: `cell_index ${cellIndex} out of range (have ${nb.cells.length} cells)` };
        }
        nb.cells.splice(cellIndex, 1);
        action = `deleted cell ${cellIndex}`;
        break;
      case 'append':
        nb.cells.push(newCell);
        action = `appended cell at ${nb.cells.length - 1}`;
        break;
      default:
        return { status: 'failed', output: `Unknown edit_mode: ${mode}` };
    }
  } catch (e: any) {
    return { status: 'failed', output: `Edit failed: ${e.message}` };
  }

  try {
    fs.writeFileSync(abs, JSON.stringify(nb, null, 1) + '\n', 'utf-8');
  } catch (e: any) {
    return { status: 'failed', output: `Write failed: ${e.message}` };
  }

  return {
    status: 'executed',
    output: `Edited ${relPath}: ${action}. Notebook now has ${nb.cells.length} cells.`,
    meta: `${nb.cells.length} cells`,
  };
}

export const notebookEditTool: ToolRegistration = {
  name: 'notebook_edit',
  definition: {
    name: 'notebook_edit',
    description:
      'Edit a Jupyter notebook (.ipynb) cell by index. Handles the JSON shape so the ' +
      'source can be provided as a plain string. Modes: replace (overwrite cell), insert ' +
      '(add before index), delete (remove cell), append (add at end). New cells default ' +
      'to code type unless cell_type is specified.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .ipynb file, relative to workspace root.' },
        cell_index: { type: 'number', description: '0-based cell index. Required for replace/insert/delete; ignored for append.' },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Type for new/inserted cells. Defaults to code.' },
        edit_mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete', 'append'],
          description: 'How to apply the edit. Defaults to replace.',
        },
        source: { type: 'string', description: 'New cell source as a string. Required for replace/insert/append.' },
      },
      required: ['path', 'edit_mode'],
    },
  },
  riskTier: 'write',
  requiresWorktree: false,
  timeoutMs: 5_000,
  autoApproveIn: ['edit', 'full'],
  execute: async (args, ctx) =>
    runNotebookEdit(
      String(args.path ?? ''),
      (String(args.edit_mode ?? 'replace') as EditMode),
      (String(args.cell_type ?? 'code') as NotebookCell['cell_type']),
      args.source != null ? String(args.source) : null,
      typeof args.cell_index === 'number' ? args.cell_index : -1,
      ctx.workspaceRoot,
    ),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────

export function createNotebookEditTool(ctx: ToolContext) {
  return tool({
    description:
      'Edit a Jupyter notebook (.ipynb) cell by index. Handles the JSON shape so the ' +
      'source can be provided as a plain string. Modes: replace (overwrite cell), insert ' +
      '(add before index), delete (remove cell), append (add at end). New cells default ' +
      'to code type unless cell_type is specified.',
    inputSchema: z.object({
      path: z.string().describe('Path to the .ipynb file, relative to workspace root.'),
      cell_index: z.number().optional().describe('0-based cell index. Required for replace/insert/delete; ignored for append.'),
      cell_type: z.enum(['code', 'markdown', 'raw']).optional().describe('Type for new/inserted cells. Defaults to code.'),
      edit_mode: z.enum(['replace', 'insert', 'delete', 'append']).describe('How to apply the edit.'),
      source: z.string().optional().describe('New cell source as a string. Required for replace/insert/append.'),
    }),
    execute: async ({ path, cell_index, cell_type, edit_mode, source }) =>
      withPermission(ctx, 'notebook_edit', { path, cell_index, cell_type, edit_mode, source }, () =>
        runNotebookEdit(
          path,
          edit_mode,
          cell_type ?? 'code',
          source != null ? source : null,
          typeof cell_index === 'number' ? cell_index : -1,
          ctx.workspaceRoot,
        ),
      ),
  });
}
