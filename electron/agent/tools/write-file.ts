/**
 * write_file tool — create or overwrite a file.
 *
 * Distinct from edit_file: edit_file requires an existing file and a unique
 * match; write_file creates new files or fully replaces content. Refuses
 * to overwrite secret paths. Refuses paths that escape the workspace.
 *
 * Migration state (Phase 2): dual export per the bash.ts pattern.
 */

import * as fs from 'fs';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../path-safety';
import { isSecretPath } from '../redaction';
import { withPermission } from '../permission-wrapper';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';

export async function runWriteFile(
  relPath: string,
  content: string,
  workspaceRoot: string,
): Promise<{
  status: 'executed' | 'failed' | 'rejected';
  output: string;
  meta?: string;
  display?: { kind: 'text'; text: string };
}> {
  if (!relPath) return { status: 'failed', output: 'Missing required arg: path' };

  if (isSecretPath(relPath)) {
    return {
      status: 'rejected',
      output: `Refused: "${relPath}" is on the secret blocklist.`,
    };
  }

  let abs: string;
  try {
    // Use resolveInside (not followSymlinks) so creating a new file at a
    // path where nothing exists yet doesn't trip realpath ENOENT.
    abs = resolveInsideWorkspace(workspaceRoot, relPath);
  } catch (e: any) {
    return { status: 'failed', output: `Path error: ${e.message}` };
  }

  const existed = fs.existsSync(abs);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  } catch (e: any) {
    return { status: 'failed', output: `Write failed: ${e.message}` };
  }

  const lineCount = content.split('\n').length;
  return {
    status: 'executed',
    output: `${existed ? 'Overwrote' : 'Created'} ${relPath} (${lineCount} lines, ${content.length.toLocaleString()} bytes).`,
    meta: `${lineCount} lines · ${content.length.toLocaleString()} bytes`,
    display: { kind: 'text', text: content },
  };
}

// ─── Legacy envelope (deleted in Phase 3) ──────────────────────────────

export const writeFileTool: ToolRegistration = {
  name: 'write_file',
  definition: {
    name: 'write_file',
    description:
      'Create a new file or fully replace an existing file\'s contents. ' +
      'For targeted changes to an existing file, prefer edit_file. The ' +
      'parent directory is created if it doesn\'t exist.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace root.' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
  },
  riskTier: 'write',
  requiresWorktree: false,
  timeoutMs: 10_000,
  autoApproveIn: ['edit', 'full'],
  execute: async (args, ctx) =>
    runWriteFile(String(args.path ?? ''), String(args.content ?? ''), ctx.workspaceRoot),
};

// ─── New SDK factory envelope (Phase 3+) ───────────────────────────────

export function createWriteFileTool(ctx: ToolContext) {
  return tool({
    description:
      'Create a new file or fully replace an existing file\'s contents. ' +
      'For targeted changes to an existing file, prefer edit_file. The ' +
      'parent directory is created if it doesn\'t exist.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to workspace root.'),
      content: z.string().describe('Full file contents to write.'),
    }),
    execute: async ({ path: p, content }) =>
      withPermission(ctx, 'write_file', { path: p, content }, () =>
        runWriteFile(p, content, ctx.workspaceRoot),
      ),
  });
}
