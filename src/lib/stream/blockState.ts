/**
 * Pure helpers for the block-stream model. Shared by the orchestrator
 * (electron/) and the streamReducer (renderer/). No React, no Zustand —
 * safe to import from anywhere.
 */

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

/**
 * Derive a FollowupMode from a parsed `ask_followup_question` arguments
 * object. Returns null if args don't match the expected shape.
 *
 * Three modes (see spec §10):
 *   - options:  { question, options: [...], multiple? }
 *   - question: { question }
 *   - null:     anything else (caller decides what to do — usually skip)
 *
 * Note: 'blank' mode is decided by the reducer when the tool_call_start
 * arrives but args haven't landed yet. This function only runs once args
 * are present.
 */
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
  if (totals.commands) parts.push(`${totals.commands} ${totals.commands === 1 ? 'command' : 'commands'}`);
  if (totals.edits) parts.push(`${totals.edits} ${totals.edits === 1 ? 'edit' : 'edits'}`);
  if (totals.exploration) parts.push(`${totals.exploration} exploration`);
  if (totals.other) parts.push(`${totals.other} tool ${totals.other === 1 ? 'call' : 'calls'}`);
  const sum = parts.join(' · ');
  const ms = formatMs(totals.totalMs);
  let out = ms ? `${sum} · ${ms}` : sum;
  if (totals.failedCount > 0) out += ` · ${totals.failedCount} failed`;
  return out;
}

export function formatMs(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}
