/** Pure helpers for the block-stream model, shared by orchestrator and streamReducer. No React, no Zustand. */

import type { FollowupMode, ToolName } from '@/types';

// ─── Tool categorization ────────────────────────────────────────────────

const COMMAND_TOOLS = new Set<ToolName>(['bash', 'bash_output', 'kill_shell', 'git']);
const EDIT_TOOLS = new Set<ToolName>(['edit_file', 'multi_edit', 'write_file', 'notebook_edit']);
const EXPLORATION_TOOLS = new Set<ToolName>([
  'read_file', 'grep', 'glob', 'list_dir', 'web_fetch', 'web_search',
]);

export type ToolCategory = 'commands' | 'edits' | 'exploration' | 'other';

export function categorizeTool(name: ToolName): ToolCategory {
  if (COMMAND_TOOLS.has(name)) return 'commands';
  if (EDIT_TOOLS.has(name)) return 'edits';
  if (EXPLORATION_TOOLS.has(name)) return 'exploration';
  return 'other';
}

/** Bookkeeping/planning tools that do NOT do work toward the deliverable and
 *  therefore must NOT reset the answer boundary. Without this, a trailing
 *  `todo_write` (e.g. marking the plan complete right after writing the final
 *  report) becomes the "last tool call" and demotes the preceding report text
 *  to narration — so the real deliverable isn't flagged as the answer. The
 *  answer phase begins after the last *work* tool (commands/edits/exploration
 *  + read-type others like directory_tree/memory). */
const BOOKKEEPING_TOOLS = new Set<string>([
  'todo_write',
  'ask_followup_question',
  'exit_plan_mode',
  'compact',
  'slash_command',
  'load_skill',
]);

/** True for tools that are planning/control-flow, not deliverable work. Such
 *  tools are ignored when finding the last-tool boundary for answer flagging. */
export function isBookkeepingTool(name: string | undefined | null): boolean {
  return !!name && BOOKKEEPING_TOOLS.has(name);
}

// ─── Followup mode derivation ───────────────────────────────────────────

/** Normalize a single option value to a display string. Handles plain
 *  strings, numbers, and {label, value} objects. */
function normalizeOption(o: unknown): string {
  if (typeof o === 'string') return o;
  if (typeof o === 'number') return String(o);
  if (o && typeof o === 'object') {
    const obj = o as Record<string, unknown>;
    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.value === 'string') return obj.value;
  }
  return String(o);
}

/** Derive a FollowupMode from ask_followup_question args (options / question / null). 'blank' mode is decided earlier by the reducer on tool_call_start; this runs only once args have landed. */
export function deriveFollowupMode(args: Record<string, unknown>): FollowupMode | null {
  if (Array.isArray(args.options) && args.options.length > 0) {
    return {
      kind: 'options',
      question: String(args.question ?? ''),
      options: args.options.map(normalizeOption),
      multiple: Boolean(args.multiple),
    };
  }
  if (args.question) {
    return { kind: 'question', question: String(args.question) };
  }
  return null;
}

// ─── Block finalization ─────────────────────────────────────────────────

const FAILED_STATUSES = new Set(['failed', 'rejected', 'timeout', 'aborted']);

export function isFailedStatus(status: string): boolean {
  return FAILED_STATUSES.has(status);
}

/** Build the summary line: "2 commands · 1 edit · 3 exploration · 14s".
 *  Empty categories are omitted. */
export function buildProcessSummary(totals: {
  commands: number; edits: number; exploration: number; other: number;
  failedCount: number; totalMs: number;
}): string {
  const parts: string[] = [];
  if (totals.commands) parts.push(`${totals.commands} ${totals.commands === 1 ? 'Command' : 'Commands'}`);
  if (totals.edits) parts.push(`${totals.edits} ${totals.edits === 1 ? 'Edit' : 'Edits'}`);
  if (totals.exploration) parts.push(`${totals.exploration} Exploration`);
  if (totals.other) parts.push(`${totals.other} Tool ${totals.other === 1 ? 'Call' : 'Calls'}`);
  const sum = parts.join(' · ');
  const ms = formatMs(totals.totalMs);
  let out = ms ? `${sum} · ${ms}` : sum;
  if (totals.failedCount > 0) out += ` · ${totals.failedCount} Failed`;
  return out;
}

export function formatMs(ms?: number): string {
  // Treat null/undefined/0/negative as "no duration" — returning '' (not
  // '0s') so callers that force totalMs:0 (e.g. ProcessList builds its
  // summary without time, then shows time separately via the clock) don't
  // append a bogus "· 0s".
  if (ms == null || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// ─── File-change summary ────────────────────────────────────────────────

/** One file touched by a turn's edit tool calls. Coalesces multiple edits to
 *  the same path (created wins; +/- sums). Deletions aren't detected. */
export interface FileChangeEntry {
  path: string;
  status: 'created' | 'edited';
  additions?: number;
  deletions?: number;
  toolName: ToolName;
  /** Diff hunks from the first edit-tool block for this file. Used to open a
   *  side-by-side diff when the user clicks the file in the summary. */
  hunks?: import('@/types').DiffHunk[];
}

/** Derive the per-file change list from a turn's blocks. Excludes failed edit
 *  calls. First-seen order. Empty when no edits → renderer shows nothing. */
export function summarizeFileChanges(blocks: import('@/types/block').Block[]): FileChangeEntry[] {
  const byPath = new Map<string, FileChangeEntry>();
  for (const b of blocks) {
    if (b.kind !== 'tool' || b.category !== 'edits' || isFailedStatus(b.status)) continue;
    const args = b.arguments as Record<string, unknown>;
    const path = typeof args.path === 'string' ? args.path
      : typeof args.file_path === 'string' ? args.file_path
      : undefined;
    if (!path) continue;

    // write_file's Created-vs-Overwrote is only in its output string.
    const created = b.toolName === 'write_file' &&
      typeof b.output === 'string' && b.output.startsWith('Created');

    let additions: number | undefined;
    let deletions: number | undefined;
    let hunks: import('@/types').DiffHunk[] | undefined;
    if (b.display?.kind === 'diff') {
      additions = b.display.additions;
      deletions = b.display.deletions;
      hunks = b.display.hunks;
    }

    const existing = byPath.get(path);
    if (!existing) {
      byPath.set(path, { path, status: created ? 'created' : 'edited', additions, deletions, toolName: b.toolName, hunks });
    } else {
      if (created) existing.status = 'created';
      existing.additions = (existing.additions ?? 0) + (additions ?? 0);
      existing.deletions = (existing.deletions ?? 0) + (deletions ?? 0);
      existing.toolName = b.toolName;
    }
  }
  return Array.from(byPath.values());
}
