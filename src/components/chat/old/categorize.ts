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

/**
 * Normalize a single option value to a display string. Handles:
 *   - plain string: use as-is
 *   - {label, description}: "label — description" (or just label)
 *   - {value, text}: same pattern, value as label
 *   - other primitives: stringify
 *   - unknown shape: JSON-stringify as last resort
 *
 * Mirrors the normalization in OptionsPicker.parseOptionsBlock so options
 * look identical whether they came from text-parsing (legacy) or from
 * ask_followup_question args (new path).
 */
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

/** Derive the FollowupMode from the LAST ask_followup_question call.
 *  Returns null if there is no such call, or the args are missing.
 *
 *  Also checks the answer text for a JSON options block as a fallback —
 *  some models emit the question as text instead of calling the tool.
 *  If found, the JSON block is parsed into a followup mode and should be
 *  stripped from the answer by the caller. */
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

  // 2) Fallback: scan the answer text for a JSON block that looks like an
  //    ask_followup_question payload. Models sometimes emit this as text
  //    instead of calling the tool. Recognized patterns:
  //      { "question": "...", "options": ["A", "B"] }
  //      ```json\n{ "question": "...", "options": [...] }\n```
  if (text) {
    const parsed = parseFollowupFromText(text);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Scan text for a JSON block matching the ask_followup_question schema.
 * Returns a FollowupMode if found, null otherwise. Recognizes both bare
 * JSON and fenced ```json blocks. Requires at least a `question` field;
 * `options` makes it Mode 1 (options), without options it's Mode 2 (question).
 */
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

/**
 * Strip a followup JSON block from answer text so the user doesn't see
 * the raw JSON in the rendered answer. If the text contains a JSON block
 * that parseFollowupFromText recognized, remove it.
 */
export function stripFollowupFromText(text: string): string {
  // Remove fenced ```json blocks containing a question field.
  let result = text.replace(/```(?:json)?\s*\n\{[\s\S]*?"question"[\s\S]*?\}\s*\n```/g, '');
  // Remove bare JSON objects that look like followup payloads.
  result = result.replace(/\{"question"\s*:[\s\S]*?"(?:options"|multiple")\s*:[\s\S]*?\}/g, '');
  // Clean up extra blank lines left behind.
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split a timeline into narration (text before/between tools) and answer
 * (text after the last tool). The model often emits process narration like
 * "I'll proceed with a broad analysis..." before launching dispatch_agent
 * calls, then summarizes after — those lead-in segments belong to the
 * process block, not the conclusion.
 *
 * - If there are no tool entries: all text is the answer.
 * - Otherwise: text entries BEFORE the last tool entry are narration;
 *   text entries AT or AFTER the last tool entry are the answer.
 *
 * Empty / whitespace-only segments are dropped.
 */
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

/**
 * Build a Turn from the raw streaming fields. Used by useChatStream on
 * every state update so the renderer can read a single structured object
 * instead of re-deriving categorization on each render.
 *
 * Pure — takes inputs, returns Turn. Caller stores the result.
 *
 * Narration/answer split applies at all times (streaming or completed):
 * text the model emitted before/between tool calls is narration and lives
 * in the process block; only text AFTER the last tool call is the answer.
 * During streaming, the currently-growing text segment counts as "after
 * the last tool" if no tool has fired since it started — so the user
 * still sees live text growing in the answer position when no tools are
 * mid-flight, but lead-in narration before tools immediately moves to
 * the process block as soon as a tool lands.
 */
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
