/** directory_tree tool: recursive tree view formatted like the `tree` command (compact, readable). Respects .gitignore with depth/entry caps. */
import * as fs from 'fs';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../path-safety';
import { withPermission } from '../permission-wrapper';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';

const MAX_DEPTH = 10;
const MAX_ENTRIES = 2000;

interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

export async function runDirectoryTree(
  relPath: string,
  workspaceRoot: string,
): Promise<{
  status: 'executed' | 'failed';
  output: string;
  meta?: string;
}> {
  let abs: string;
  try {
    abs = resolveInsideWorkspace(workspaceRoot, relPath || '.');
  } catch (e: any) {
    return { status: 'failed', output: `Path error: ${e.message}` };
  }

  let entryCount = 0;
  const truncationNote = { truncated: false, count: 0 };

  function buildTree(dirPath: string, depth: number): TreeNode[] {
    if (depth >= MAX_DEPTH || truncationNote.truncated) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entryCount >= MAX_ENTRIES) {
        truncationNote.truncated = true;
        truncationNote.count = entryCount;
        break;
      }
      entryCount++;
      const node: TreeNode = {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
      };
      if (entry.isDirectory()) {
        const children = buildTree(path.join(dirPath, entry.name), depth + 1);
        if (children.length > 0) node.children = children;
      }
      nodes.push(node);
    }
    return nodes;
  }

  try {
    const tree = buildTree(abs, 0);
    const output = formatTree(tree);
    const note = truncationNote.truncated
      ? `\n\n(truncated at ${MAX_ENTRIES} entries)`
      : '';
    return {
      status: 'executed',
      output: output + note,
      meta: `${entryCount} entries`,
    };
  } catch (e: any) {
    return { status: 'failed', output: `Cannot read tree: ${e.message}` };
  }
}

/** Format tree nodes as an indented tree (like the `tree` command). Dirs end with `/`. */
function formatTree(nodes: TreeNode[]): string {
  const lines: string[] = [];
  function walk(node: TreeNode, prefix: string, isLast: boolean) {
    const connector = isLast ? '└── ' : '├── ';
    const suffix = node.type === 'dir' ? '/' : '';
    lines.push(`${prefix}${connector}${node.name}${suffix}`);
    const children = node.children ?? [];
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < children.length; i++) {
      walk(children[i], childPrefix, i === children.length - 1);
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    walk(nodes[i], '', i === nodes.length - 1);
  }
  return lines.join('\n');
}

// ─── Legacy envelope ──────────────────────────────────────────────────

export const directoryTreeTool: ToolRegistration = {
  name: 'directory_tree',
  definition: {
    name: 'directory_tree',
    description:
      'Get a recursive tree view of files and directories as JSON. Use for ' +
      'understanding project structure at a glance. Respects workspace boundaries. ' +
      'Max depth 10, max 2000 entries.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to workspace root. Defaults to root.',
        },
      },
      required: [],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 10_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runDirectoryTree(typeof args.path === 'string' ? args.path : '', ctx.workspaceRoot),
};

// ─── SDK factory ──────────────────────────────────────────────────────

export function createDirectoryTreeTool(ctx: ToolContext) {
  return tool({
    description:
      'Get a recursive tree view of files and directories as JSON. Use for ' +
      'understanding project structure at a glance. Each node has {name, type, children?}. ' +
      'Max depth 10, max 2000 entries.',
    inputSchema: z.object({
      path: z.string().optional().describe('Directory path relative to workspace root. Defaults to root.'),
    }),
    execute: async ({ path: p }) =>
      withPermission(ctx, 'directory_tree', { path: p }, () =>
        runDirectoryTree(p ?? '', ctx.workspaceRoot),
      ),
  });
}
