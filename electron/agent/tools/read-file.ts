/** read_file tool: read a file from the workspace, sandboxed; caps at maxLines (default 2000). The permission gate (riskTier: read_only → auto-approve) is the safety layer. Dual export: legacy readFileTool + SDK factory createReadFileTool, both calling runReadFile. */

import * as fs from 'fs';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveAndFollowSymlinks, resolveUnderSkillRoot } from '../path-safety';
import { redact } from '../redaction';
import { withPermission } from '../permission-wrapper';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';

const DEFAULT_MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024; // 256 KB hard cap

export async function runReadFile(
  relPath: string,
  maxLines: number,
  workspaceRoot: string,
): Promise<{
  status: 'executed' | 'failed' | 'rejected';
  output: string;
  meta?: string;
  display?: { kind: 'text'; text: string };
}> {
  if (!relPath) return { status: 'failed', output: 'Missing required arg: path' };

  let abs: string;
  try {
    abs = resolveAndFollowSymlinks(workspaceRoot, relPath);
  } catch (e: any) {
    // Not inside the workspace. Allow reads of skill/agent/context files under ~/.claude or ~/.agent — trusted entries the user invoked via `/name`, needed for progressive skill disclosure (they live outside the workspace). Anything else stays rejected (no arbitrary filesystem access).
    try {
      abs = resolveUnderSkillRoot(relPath);
    } catch {
      return { status: 'failed', output: `Path error: ${e.message}` };
    }
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return {
      status: 'failed',
      output: `File not found: ${relPath} (resolved: ${abs}; workspace root: ${workspaceRoot}). Use list_dir to see what's actually in the workspace.`,
    };
  }
  if (!stat.isFile()) {
    return { status: 'failed', output: `Not a regular file: ${relPath} (resolved: ${abs})` };
  }

  const truncated = stat.size > MAX_BYTES;

  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      let content = buf.toString('utf-8');
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip BOM

      const allLines = content.split('\n');
      const overLineCap = allLines.length > maxLines;
      if (overLineCap) content = allLines.slice(0, maxLines).join('\n');

      const notes: string[] = [];
      if (truncated) notes.push(`truncated at ${MAX_BYTES.toLocaleString()} bytes (file is ${stat.size.toLocaleString()} bytes)`);
      if (overLineCap) notes.push(`truncated at ${maxLines} lines (file has ${allLines.length})`);

      const meta = `${stat.size.toLocaleString()} bytes · ${allLines.length} lines`;

      return {
        status: 'executed',
        output: redact(content),
        meta,
        display: { kind: 'text', text: content + (notes.length ? `\n\n[${notes.join('; ')}]` : '') },
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e: any) {
    return { status: 'failed', output: `Read failed: ${e.message}` };
  }
}

// ─── Legacy envelope (deleted in Phase 3) ──────────────────────────────

export const readFileTool: ToolRegistration = {
  name: 'read_file',
  definition: {
    name: 'read_file',
    description:
      'Read a file from the workspace. Returns its contents as text. ' +
      'Paths are relative to the workspace root. Files outside the root, ' +
      'Large files are capped at 2000 lines.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace root.' },
        maxLines: { type: 'number', description: 'Maximum number of lines to return. Default 2000.' },
      },
      required: ['path'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 10_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runReadFile(String(args.path ?? ''), typeof args.maxLines === 'number' ? args.maxLines : DEFAULT_MAX_LINES, ctx.workspaceRoot),
};

// ─── New SDK factory envelope (Phase 3+) ───────────────────────────────

export function createReadFileTool(ctx: ToolContext) {
  return tool({
    description:
      'Read a file from the workspace. Returns its contents as text. ' +
      'Paths are relative to the workspace root. Files outside the root, ' +
      'Large files are capped at 2000 lines.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to workspace root.'),
      maxLines: z.number().optional().describe('Maximum number of lines to return. Default 2000.'),
    }),
    execute: async ({ path, maxLines }) =>
      withPermission(ctx, 'read_file', { path, maxLines }, () =>
        runReadFile(path, maxLines ?? DEFAULT_MAX_LINES, ctx.workspaceRoot),
      ),
  });
}
