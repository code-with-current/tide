/**
 * read_media_file tool — read binary files as base64 data URLs.
 *
 * Handles images, audio, and other binary files that read_file (text-only)
 * cannot process. Returns a data URL suitable for inline display or model
 * vision input. Detects MIME type from the file extension.
 *
 * Replaces the MCP filesystem server's `read_media_file`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../path-safety';
import { withPermission } from '../permission-wrapper';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB cap — models can't handle larger images anyway

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

export async function runReadMediaFile(
  relPath: string,
  workspaceRoot: string,
): Promise<{
  status: 'executed' | 'failed';
  output: string;
  meta?: string;
  display?: { kind: 'media'; dataUrl: string; mimeType: string };
}> {
  let abs: string;
  try {
    abs = resolveInsideWorkspace(workspaceRoot, relPath);
  } catch (e: any) {
    return { status: 'failed', output: `Path error: ${e.message}` };
  }

  if (!fs.existsSync(abs)) {
    return { status: 'failed', output: `File not found: ${relPath}` };
  }

  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    return { status: 'failed', output: `Path is a directory, not a file: ${relPath}` };
  }
  if (stat.size > MAX_BYTES) {
    return {
      status: 'failed',
      output: `File is ${(stat.size / 1024 / 1024).toFixed(1)}MB — max is ${MAX_BYTES / 1024 / 1024}MB. Use a smaller file.`,
    };
  }

  const ext = path.extname(abs).toLowerCase();
  const mimeType = MIME_MAP[ext];
  if (!mimeType) {
    return {
      status: 'failed',
      output: `Unsupported file type: ${ext}. Supported: ${Object.keys(MIME_MAP).join(', ')}`,
    };
  }

  try {
    const buffer = fs.readFileSync(abs);
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      status: 'executed',
      output: `Read ${relPath} (${(stat.size / 1024).toFixed(1)}KB, ${mimeType})`,
      meta: `${mimeType} · ${(stat.size / 1024).toFixed(1)}KB`,
      display: { kind: 'media', dataUrl, mimeType },
    };
  } catch (e: any) {
    return { status: 'failed', output: `Cannot read file: ${e.message}` };
  }
}

// ─── Legacy envelope ──────────────────────────────────────────────────

export const readMediaFileTool: ToolRegistration = {
  name: 'read_media_file',
  definition: {
    name: 'read_media_file',
    description:
      'Read a binary/media file (image, audio, PDF) as a base64 data URL. ' +
      'Use for viewing images, diagrams, or other non-text files. ' +
      'Supports: png, jpg, gif, webp, svg, bmp, ico, mp3, wav, mp4, webm, pdf. ' +
      'Max 10MB.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root.' },
      },
      required: ['path'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 5_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) =>
    runReadMediaFile(typeof args.path === 'string' ? args.path : '', ctx.workspaceRoot),
};

// ─── SDK factory ──────────────────────────────────────────────────────

export function createReadMediaFileTool(ctx: ToolContext) {
  return tool({
    description:
      'Read a binary/media file (image, audio, PDF) as a base64 data URL. ' +
      'Use for viewing images, diagrams, or other non-text files. ' +
      'Supports: png, jpg, gif, webp, svg, bmp, ico, mp3, wav, mp4, webm, pdf. Max 10MB.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to workspace root.'),
    }),
    execute: async ({ path: p }) =>
      withPermission(ctx, 'read_media_file', { path: p }, () =>
        runReadMediaFile(p, ctx.workspaceRoot),
      ),
  });
}
