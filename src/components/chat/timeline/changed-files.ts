/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/changedFiles.ts — ADAPTED (Ruling 5).
 *  Upstream derives changed files from OpenCode tool-part metadata shapes Tide's adapter
 *  never emits (metadata.files / metadata.filediff / metadata.results[].filediff /
 *  metadata.patch). Tide's edit_file + multi_edit pack the diff in
 *  `metadata.display = { kind: 'diff', path, hunks: DiffHunk[], additions, deletions }`
 *  (via lib/tide-adapter.ts buildToolMetadata; electron/agent/tools/edit-file.ts:77,
 *  multi-edit.ts:86) — verified, so NO adapter change was needed. Adaptations:
 *  - Primary read: metadata.display (kind 'diff') → path/additions/deletions + a unified
 *    patch text synthesized from the structured hunks (kept on the entry for diff views).
 *  - Fallback: the part's `input.path` (write_file carries a text display, not a diff).
 *  - Status filter uses Tide vocabulary: only 'executed' tool parts count.
 *  - FILE_EDIT_TOOLS re-keyed to Tide names: edit_file, multi_edit, write_file.
 *  - Dropped: GitChangedFile/extractGitChangedFiles/isGitFile (git-status derivation fed
 *    the global PendingChangesBar, which is excluded from the port) and `messageID`
 *    (TimelinePart carries no message coupling; the turn record owns that). */

import type { DiffHunk, DiffLine, ToolName } from '@/types';
import type { FileChangeEntry } from '@/lib/stream/block-state';
import type { TimelinePart } from './types/message-parts';
import { getRelativeFilePath, toAbsoluteFilePath } from './lib/path-utils';

export interface ChangedFile {
  path: string;
  tool: string;
  partId: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export const FILE_EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file']);

const parseCount = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  return undefined;
};

const parsePatchStats = (patch: string): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
};

const diffLinePrefix = (line: DiffLine): string | null => {
  if (line.type === 'add') return `+${line.text}`;
  if (line.type === 'del') return `-${line.text}`;
  if (line.type === 'context') return ` ${line.text}`;
  return null;
};

/** Rebuild a unified-diff text from Tide's structured DiffHunk[] so string-diff
 *  consumers (DiffPreview et al.) can parse the display payload. */
export const diffHunksToPatchText = (path: string, hunks: DiffHunk[]): string => {
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    if (hunk.header) lines.push(hunk.header);
    for (const line of hunk.lines) {
      const prefixed = diffLinePrefix(line);
      if (prefixed !== null) lines.push(prefixed);
    }
  }
  return lines.join('\n');
};

const isDiffHunkArray = (value: unknown): value is DiffHunk[] =>
  Array.isArray(value)
  && value.every(
    (hunk) => hunk != null
      && typeof hunk === 'object'
      && typeof (hunk as DiffHunk).header === 'string'
      && Array.isArray((hunk as DiffHunk).lines),
  );

/** Extract the changed files from Tide edit/write tool parts (executed only). */
export const extractChangedFiles = (parts: TimelinePart[]): ChangedFile[] => {
  const files: ChangedFile[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    if (part.type !== 'tool') continue;
    if (!FILE_EDIT_TOOLS.has(part.tool)) continue;

    const state = part.state as { metadata?: Record<string, unknown>; input?: Record<string, unknown>; status?: string };
    if (state.status !== 'executed') continue;

    const sizeBeforeThisPart = files.length;
    const metadata = state.metadata;
    const display = metadata?.display as
      | { kind?: unknown; path?: unknown; hunks?: unknown; additions?: unknown; deletions?: unknown }
      | undefined;

    if (display && display.kind === 'diff' && typeof display.path === 'string') {
      const rawPath = display.path;
      if (rawPath && !seen.has(rawPath)) {
        seen.add(rawPath);
        files.push({
          path: rawPath,
          tool: part.tool,
          partId: part.id ?? '',
          additions: parseCount(display.additions) ?? undefined,
          deletions: parseCount(display.deletions) ?? undefined,
          ...(isDiffHunkArray(display.hunks) ? { patch: diffHunksToPatchText(rawPath, display.hunks) } : {}),
        });
      }
    }

    if (files.length === sizeBeforeThisPart) {
      const input = state.input ?? part.input;
      const filePath = typeof input?.path === 'string' ? input.path : undefined;
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        files.push({
          path: filePath,
          tool: part.tool,
          partId: part.id ?? '',
        });
      }
    }
  }

  return files;
};

export const toRelativePath = (absolutePath: string, baseDirectory: string): string => {
  return getRelativeFilePath(absolutePath, baseDirectory);
};

export const toAbsolutePath = (path: string, baseDirectory: string): string => {
  return toAbsoluteFilePath(baseDirectory, path);
};

export const getDisplayPath = (file: ChangedFile, currentDirectory: string): { fileName: string; dirPart: string } => {
  const relativePath = currentDirectory ? toRelativePath(file.path, currentDirectory) : file.path;
  const fileName = relativePath.split('/').pop() ?? relativePath;
  const dirPart = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
  return { fileName, dirPart };
};

export const getFileStats = (file: ChangedFile): { additions: number; deletions: number } => {
  if (file.additions !== undefined || file.deletions !== undefined) {
    return { additions: file.additions ?? 0, deletions: file.deletions ?? 0 };
  }
  // No structured stats — count them off the synthesized patch text.
  if (file.patch) {
    const parsed = parsePatchStats(file.patch);
    return { additions: parsed.added, deletions: parsed.removed };
  }
  return { additions: 0, deletions: 0 };
};

/** Extract the changed files from Tide edit/write tool parts as FileChangeEntry[]
 *  (the shape the legacy chat UI's FileChanges card consumes). Same filter as
 *  extractChangedFiles: executed edit-tool parts only, diff display primary,
 *  input.path fallback (write_file), first-seen order, deduped by path. */
export const extractFileChangeEntries = (parts: TimelinePart[]): FileChangeEntry[] => {
  const byPath = new Map<string, FileChangeEntry>();

  for (const part of parts) {
    if (part.type !== 'tool') continue;
    if (!FILE_EDIT_TOOLS.has(part.tool)) continue;

    const state = part.state as { metadata?: Record<string, unknown>; input?: Record<string, unknown>; status?: string };
    if (state.status !== 'executed') continue;

    const metadata = state.metadata;
    const display = metadata?.display as
      | { kind?: unknown; path?: unknown; hunks?: unknown; additions?: unknown; deletions?: unknown }
      | undefined;
    let path: string | undefined;
    let hunks: DiffHunk[] | undefined;
    let additions: number | undefined;
    let deletions: number | undefined;

    if (display && display.kind === 'diff' && typeof display.path === 'string' && display.path) {
      path = display.path;
      if (isDiffHunkArray(display.hunks)) hunks = display.hunks;
      additions = parseCount(display.additions);
      deletions = parseCount(display.deletions);
    }

    if (!path) {
      const input = state.input ?? part.input;
      path = typeof input?.path === 'string' && input.path ? input.path : undefined;
    }
    if (!path || byPath.has(path)) continue;

    byPath.set(path, {
      path,
      status: part.tool === 'write_file' ? 'created' : 'edited',
      toolName: part.tool as ToolName,
      ...(additions !== undefined ? { additions } : {}),
      ...(deletions !== undefined ? { deletions } : {}),
      ...(hunks ? { hunks } : {}),
    });
  }

  return [...byPath.values()];
};
