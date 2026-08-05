import type { ToolCall, ToolName, FollowupMode, Turn } from '@/types';

/** Tool names grouped by category. The category drives which section of
 *  the turn-block a call renders in, and the summary line counts.
 *  Edits get their own always-visible section; everything else collapses. */
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

export interface CategorizedTools {
  commands: ToolCall[];
  edits: ToolCall[];
  exploration: ToolCall[];
  other: ToolCall[];
  failedCount: number;
  /** Sum of all tool durations (ms). Tools without durationMs are skipped. */
  totalMs: number;
}

/** Categorize a flat list of tool calls. Pure — safe to call during render. */
export function categorizeTools(calls: ToolCall[]): CategorizedTools {
  const out: CategorizedTools = {
    commands: [], edits: [], exploration: [], other: [],
    failedCount: 0, totalMs: 0,
  };
  for (const c of calls) {
    const cat = categorizeTool(c.toolName);
    out[cat].push(c);
    if (c.status === 'failed' || c.status === 'rejected' || c.status === 'timeout' || c.status === 'aborted') {
      out.failedCount += 1;
    }
    if (c.durationMs != null) out.totalMs += c.durationMs;
  }
  return out;
}

/** Normalize a single option value to a display string (string/{label,description}/{value,text}/primitive/object), mirroring OptionsPicker.parseOptionsBlock for parity across legacy and new paths. */
export function normalizeOption(o: unknown): string {
  if (typeof o === 'string') return o;
  if (typeof o === 'number' || typeof o === 'boolean') return String(o);
  if (o && typeof o === 'object') {
    const obj = o as Record<string, unknown>;
    const label = obj.label ?? obj.text ?? obj.value ?? obj.name;
    const desc = obj.description ?? obj.desc ?? obj.detail;
    if (typeof label === 'string') {
      return typeof desc === 'string' && desc ? `${label} — ${desc}` : label;
    }
  }
  return JSON.stringify(o);
}

/** Derive the FollowupMode from the LAST ask_followup_question call, falling back to a JSON options block in the answer text (caller must strip it). */
export function deriveFollowup(calls: ToolCall[], text?: string): FollowupMode | null {
  // 1) Check for an actual ask_followup_question tool call first.
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].toolName !== 'ask_followup_question') continue;
    const c = calls[i];
    // Blank mode — tool_call_start fired but args haven't arrived yet.
    if (c.status === 'pending' && !c.arguments?.question && !c.arguments?.options) {
      return { kind: 'blank' };
    }
    const args = c.arguments ?? {};
    if (Array.isArray(args.options) && args.options.length > 0) {
      return {
        kind: 'options',
        question: String(args.question ?? ''),
        options: args.options.map((o) => normalizeOption(o)),
        multiple: Boolean(args.multiple),
      };
    }
    if (args.question) {
      return { kind: 'question', question: String(args.question) };
    }
    return null;
  }

  // 2) Fallback: scan the answer text for a JSON block that looks like an ask_followup_question payload (models sometimes emit this as text instead of calling the tool). Recognized: `{ "question":"…","options":["A","B"] }` or fenced ```json blocks.
  if (text) {
    const parsed = parseFollowupFromText(text);
    if (parsed) return parsed;
  }

  return null;
}

/** Scan text for a bare or fenced JSON block matching the ask_followup_question schema; requires a `question` field, `options` makes it options-mode. */
function parseFollowupFromText(text: string): FollowupMode | null {
  // Try fenced ```json block first, then bare JSON object.
  const patterns = [
    /```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/,
    /(\{"question"\s*:[\s\S]*?"(?:options"|multiple")\s*:[\s\S]*?\})/,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]);
      if (typeof obj.question !== 'string') continue;
      if (Array.isArray(obj.options) && obj.options.length > 0 && obj.options.length <= 6) {
        return {
          kind: 'options',
          question: obj.question,
          options: obj.options.map((o: unknown) => normalizeOption(o)),
          multiple: Boolean(obj.multiple),
        };
      }
      return { kind: 'question', question: obj.question };
    } catch {
      // Not valid JSON — try the next pattern.
    }
  }
  return null;
}

/** Strip a recognized followup JSON block (fenced or bare) from answer text so raw JSON isn't rendered as prose. */
export function stripFollowupFromText(text: string): string {
  // Remove fenced ```json blocks containing a question field.
  let result = text.replace(/```(?:json)?\s*\n\{[\s\S]*?"question"[\s\S]*?\}\s*\n```/g, '');
  // Remove bare JSON objects that look like followup payloads.
  result = result.replace(/\{"question"\s*:[\s\S]*?"(?:options"|multiple")\s*:[\s\S]*?\}/g, '');
  // Clean up extra blank lines left behind.
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** Split a timeline into narration (text before/between tools) and answer (text at/after the last tool); with no tools, all text is the answer; empty segments dropped. */
function splitNarration(timeline: Turn['timeline']): {
  narration: string[];
  answer: string;
} {
  if (timeline.length === 0) return { narration: [], answer: '' };

  // Find the index of the LAST tool entry. Text after it is the answer.
  let lastToolIdx = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].type === 'tool') {
      lastToolIdx = i;
      break;
    }
  }

  // No tools at all → everything is the answer.
  if (lastToolIdx === -1) {
    const answer = timeline
      .filter((e): e is { type: 'text'; text: string } => e.type === 'text')
      .map((e) => e.text)
      .join('');
    return { narration: [], answer };
  }

  const narration: string[] = [];
  const answerParts: string[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    if (e.type !== 'text') continue;
    if (!e.text.trim()) continue;
    if (i < lastToolIdx) narration.push(e.text.trim());
    else answerParts.push(e.text);
  }
  return { narration, answer: answerParts.join('') };
}

/** Build a Turn from raw streaming fields for useChatStream; applies the narration/answer split at all times so lead-in text before tools lands in the process block while live post-tool text stays in the answer. */
export function buildTurn(input: {
  toolCalls: ToolCall[];
  timeline: Turn['timeline'];
  text: string;
  reasoning?: string;
  reasoningTokens?: number;
  reasoningMs?: number;
}): Turn {
  const cats = categorizeTools(input.toolCalls);
  const { narration, answer } = splitNarration(input.timeline);

  // Derive followup from tool calls first, then fall back to scanning the
  // answer text for a JSON options block (models sometimes emit the question
  // as text instead of calling the tool).
  const followup = deriveFollowup(input.toolCalls, answer);

  // If the followup came from text (not a tool call), strip the JSON block
  // from the answer so the user doesn't see raw JSON rendered as prose.
  const hasToolFollowup = input.toolCalls.some((t) => t.toolName === 'ask_followup_question');
  const cleanAnswer = !hasToolFollowup && followup
    ? stripFollowupFromText(answer)
    : answer;

  return {
    thinking: input.reasoning
      ? { text: input.reasoning, tokens: input.reasoningTokens, ms: input.reasoningMs }
      : undefined,
    commands: cats.commands,
    edits: cats.edits,
    exploration: cats.exploration,
    other: cats.other,
    timeline: input.timeline,
    narration,
    answer: cleanAnswer,
    followup,
    totalMs: cats.totalMs || undefined,
    anyFailed: cats.failedCount > 0,
  };
}
