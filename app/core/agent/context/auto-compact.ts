/** Context autocompact — opencode-style multi-layer compaction.
 *
 *  Layer 1: Tool output pruning — free (no LLM call). Walks backwards through
 *           tool results, protects the last 40K tokens, erases older ones.
 *           Fires only if it can reclaim >= 20K tokens.
 *  Layer 2: Structured anchored summary — 8-section template. On subsequent
 *           compactions, passes the prior summary for an update rather than
 *           re-summarizing from scratch.
 *  Layer 3: Prior compaction hiding — removes old compaction-marker messages
 *           from the summarization input so the model doesn't summarize a summary.
 *  Layer 4: Token-budgeted tail — preserves recent turns by token budget
 *           (25% of usable, clamped 2K–8K), not a fixed turn count.
 *  Layer 5: Overflow replay — after forced compaction, the last user message
 *           is replayed so the model doesn't lose the user's request.
 *  Layer 6: Media stripping — handled in serializeForSummary (summarize.ts).
 */
import { createLogger } from '../../logger.js';
import { generateSessionSummary } from './summarize.js';
import type { Provider } from '../../../../src/types/index.js';
import type { ModelMessage } from 'ai';

const log = createLogger('auto-compact');

// ─── Pruning constants (Layer 1) ────────────────────────────────────────

/** Protect the most recent N tokens of tool output from pruning. */
const PRUNE_PROTECT = 40_000;
/** Only prune if we can reclaim at least this many tokens — otherwise
 *  the churn isn't worth it. */
const PRUNE_MINIMUM = 20_000;

// ─── Tail-budget constants (Layer 4) ────────────────────────────────────

/** Tail budget as a fraction of the usable input budget. */
const TAIL_BUDGET_RATIO = 0.25;
/** Clamp the tail budget to this range so it works across all model sizes. */
const TAIL_BUDGET_MIN = 2_000;
const TAIL_BUDGET_MAX = 8_000;

// ─── Types ──────────────────────────────────────────────────────────────

export interface CompactionResult {
  /** The summary message replacing old context (null if pruning-only). */
  summaryMessage: ModelMessage;
  /** Messages kept verbatim (recent turns). */
  keptMessages: ModelMessage[];
  /** Full message array after compaction: [summaryMessage?, ...keptMessages]. */
  postCompactMessages: ModelMessage[];
  /** Token counts for telemetry / circuit-breaking. */
  preCompactTokens: number;
  postCompactTokens: number;
  /** Layer 1: number of tool outputs pruned (0 if pruning didn't fire). */
  prunedToolOutputs: number;
  /** True when pruning alone was sufficient (no LLM summarization needed). */
  pruningSufficient: boolean;
  /** Layer 5: last user message to replay after overflow compaction. */
  replayMessage: ModelMessage | null;
}

export interface AutoCompactConfig {
  /** Total context window for the model (tokens). */
  contextWindow: number;
  /** Max input tokens the provider accepts. Falls back to contextWindow. */
  maxInputTokens?: number;
  /** Max output tokens the model will request per response. */
  maxOutputTokens: number;
  /** Compaction threshold as fraction of the usable input budget (default 0.75). */
  threshold: number;
  /** Recent turns to keep verbatim (default 3). Used as a fallback when
   *  the token-budgeted tail can't be computed. */
  keepRecentTurns: number;
  /** What to do on compaction failure. */
  onFailure?: 'truncate' | 'error';
}

export const DEFAULT_AUTO_COMPACT_CONFIG: AutoCompactConfig = {
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  threshold: 0.75,
  keepRecentTurns: 3,
  onFailure: 'truncate',
};

/** Circuit breaker — stop trying after this many consecutive failures. */
const MAX_CONSECUTIVE_FAILURES = 3;

// ─── Token estimation ───────────────────────────────────────────────────

/** Estimate token count via a char-based heuristic (~3.5 chars/token). */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null) {
          const p = part as Record<string, unknown>;
          if ('text' in p && typeof p.text === 'string') {
            chars += p.text.length;
          } else if (p.type === 'tool-result' && 'output' in p) {
            const out = p.output;
            if (typeof out === 'string') chars += out.length;
            else if (typeof out === 'object' && out !== null && 'value' in out) {
              chars += String((out as Record<string, unknown>).value).length;
            }
          }
        }
      }
    }
    // Role + structural overhead — ~4 tokens per message boundary
    chars += 14;
  }
  return Math.ceil(chars / 3.5);
}

// ─── Threshold check ────────────────────────────────────────────────────

export function usableInputBudget(config: AutoCompactConfig): number {
  const context = config.maxInputTokens ?? config.contextWindow;
  return Math.max(0, context - config.maxOutputTokens);
}

export function shouldCompact(
  messages: ModelMessage[],
  config: AutoCompactConfig,
  consecutiveFailures = 0,
  actualInputTokens?: number,
): boolean {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;

  const usable = usableInputBudget(config);
  if (usable <= 0) return false;
  const thresholdTokens = Math.floor(usable * config.threshold);

  const tokens = actualInputTokens && actualInputTokens > 0
    ? actualInputTokens
    : estimateTokens(messages);
  return tokens >= thresholdTokens;
}

// ─── Layer 1: Tool output pruning ───────────────────────────────────────

/** Walk backwards through tool-result messages, protect the last PRUNE_PROTECT
 *  tokens of output, and replace older outputs with a short marker. Returns
 *  the modified messages, count of pruned outputs, and estimated tokens
 *  reclaimed. No LLM call — pure local operation. */
export function pruneToolOutputs(
  messages: ModelMessage[],
): { messages: ModelMessage[]; prunedCount: number; tokensReclaimed: number } {
  type PruneTarget = { index: number; tokens: number };
  const targets: PruneTarget[] = [];
  let protectedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;

    const tokens = estimateTokens([msg]);

    if (protectedTokens + tokens <= PRUNE_PROTECT) {
      protectedTokens += tokens;
      continue;
    }

    targets.push({ index: i, tokens });
  }

  if (targets.length === 0) {
    return { messages, prunedCount: 0, tokensReclaimed: 0 };
  }

  const tokensReclaimed = targets.reduce((sum, t) => sum + t.tokens, 0);
  if (tokensReclaimed < PRUNE_MINIMUM) {
    return { messages, prunedCount: 0, tokensReclaimed: 0 };
  }

  // Build new array with pruned tool outputs replaced
  const result = [...messages];

  for (const target of targets) {
    const original = result[target.index];
    const marker = `[pruned tool output — ~${target.tokens} tokens elided to reclaim context]`;
    result[target.index] = replaceToolOutput(original, marker);
  }

  return { messages: result, prunedCount: targets.length, tokensReclaimed };
}

/** Replace a tool message's output content with a marker string,
 *  preserving the message structure (role, toolCallId references). */
function replaceToolOutput(msg: ModelMessage, marker: string): ModelMessage {
  if (typeof msg.content === 'string') {
    return { ...msg, content: marker } as ModelMessage;
  }
  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'tool-result') {
          return { ...part, output: marker };
        }
        return part;
      }) as unknown as typeof msg.content,
    } as ModelMessage;
  }
  return msg;
}

// ─── Layer 3: Prior compaction extraction ───────────────────────────────

/** Detect and extract a prior compaction summary from the message list.
 *  Returns the summary text and a filtered message array with the compaction
 *  marker removed — so the summarizer doesn't waste tokens summarizing a
 *  summary. */
function extractPriorSummary(
  messages: ModelMessage[],
): { summary: string; messages: ModelMessage[] } | null {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((p) => (typeof p === 'object' && p !== null && 'text' in p ? String((p as unknown as Record<string, unknown>).text) : '')).join('')
        : '';
    // Match both old format "[Compacted context...]" and truncated "[Context truncated...]"
    const match = text.match(/^\[(?:Compacted context|Context truncated)[^\]]*\]\s*\n\n([\s\S]*)$/);
    if (match) {
      return {
        summary: match[1].trim(),
        messages: [...messages.slice(0, i), ...messages.slice(i + 1)],
      };
    }
  }
  return null;
}

// ─── Layer 4: Token-budgeted tail selection ─────────────────────────────

/** Select the recent-message tail by token budget instead of a fixed count.
 *  Budget = 25% of usable, clamped to [2K, 8K]. Walks backwards accumulating
 *  tokens, then snaps forward to the next user-message boundary so the tail
 *  doesn't start with an orphaned assistant message. */
function selectTailByBudget(
  messages: ModelMessage[],
  usableBudget: number,
): { head: ModelMessage[]; tail: ModelMessage[] } {
  const budget = Math.min(
    TAIL_BUDGET_MAX,
    Math.max(TAIL_BUDGET_MIN, Math.floor(usableBudget * TAIL_BUDGET_RATIO)),
  );

  let accumulated = 0;
  let cutoff = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens([messages[i]]);
    if (accumulated + msgTokens > budget && i < messages.length - 1) {
      cutoff = i + 1;
      break;
    }
    accumulated += msgTokens;
    cutoff = i;
  }

  // Snap forward past any leading assistant/tool messages — the tail should
  // start at a user message boundary (or system, if that's all there is).
  while (
    cutoff < messages.length - 1 &&
    messages[cutoff].role !== 'user' &&
    messages[cutoff].role !== 'system'
  ) {
    cutoff++;
  }

  return {
    head: messages.slice(0, cutoff),
    tail: messages.slice(cutoff),
  };
}

// ─── Layer 5: Last user message extraction ──────────────────────────────

/** Find the most recent real user message (not a compaction marker or
 *  resume instruction). Used to replay it after overflow compaction so
 *  the model doesn't lose the user's request. */
function findLastUserMessage(messages: ModelMessage[]): ModelMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((p) => (typeof p === 'object' && p !== null && 'text' in p ? String((p as unknown as Record<string, unknown>).text) : '')).join('')
        : '';
    // Skip compaction markers and system-injected messages
    if (text.startsWith('[Compacted context') || text.startsWith('[Context truncated')) continue;
    return msg;
  }
  return null;
}

// ─── Compaction ─────────────────────────────────────────────────────────

/** Multi-layer compaction. Orchestrates:
 *  1. Tool output pruning (free, no LLM)
 *  2. Prior compaction extraction + hiding
 *  3. Token-budgeted tail selection
 *  4. Structured anchored summary (LLM call)
 *  5. Reassembly: [summaryMessage, ...tail]
 *  6. Fallback: truncation on failure */
export async function compactConversation(
  messages: ModelMessage[],
  config: AutoCompactConfig,
  ctx: { provider: Provider; modelId: string; signal: AbortSignal },
): Promise<CompactionResult> {
  const preCompactTokens = estimateTokens(messages);
  const usable = usableInputBudget(config);
  const replayMessage = findLastUserMessage(messages);

  // ── Layer 1: Prune tool outputs (free, no LLM call) ────────────────
  const pruned = pruneToolOutputs(messages);
  let working = pruned.messages;

  if (pruned.prunedCount > 0) {
    const afterPruning = estimateTokens(working);
    log.info('tool output pruning', {
      pruned: pruned.prunedCount,
      reclaimed: preCompactTokens - afterPruning,
    });

    // If pruning alone brought us under threshold, skip the LLM summarizer.
    if (!shouldCompact(working, config, 0)) {
      const postCompactTokens = afterPruning;
      return {
        summaryMessage: {
          role: 'user',
          content: `[Context pruned — ${pruned.prunedCount} tool outputs elided, no summary needed]`,
        },
        keptMessages: working,
        postCompactMessages: working,
        preCompactTokens,
        postCompactTokens,
        prunedToolOutputs: pruned.prunedCount,
        pruningSufficient: true,
        replayMessage,
      };
    }
  }

  // ── Layer 3: Extract & hide prior compaction ───────────────────────
  const priorCompaction = extractPriorSummary(working);
  if (priorCompaction) {
    working = priorCompaction.messages;
  }

  // ── Layer 4: Token-budgeted tail selection ─────────────────────────
  const { head, tail } = selectTailByBudget(working, usable);

  if (head.length === 0) {
    return {
      summaryMessage: messages[0],
      keptMessages: messages.slice(1),
      postCompactMessages: messages,
      preCompactTokens,
      postCompactTokens: preCompactTokens,
      prunedToolOutputs: pruned.prunedCount,
      pruningSufficient: false,
      replayMessage,
    };
  }

  // ── Layer 2: Structured anchored summary ───────────────────────────
  try {
    const summary = await generateSessionSummary(head, {
      ...ctx,
      priorSummary: priorCompaction?.summary ?? null,
    });

    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[Compacted context — structured summary of ${head.length} earlier messages]\n\n${summary}`,
    };

    const postCompactMessages = [summaryMessage, ...tail];
    const postCompactTokens = estimateTokens(postCompactMessages);

    log.info('autocompact', {
      messagesBefore: messages.length,
      messagesAfter: postCompactMessages.length,
      tokensBefore: preCompactTokens,
      tokensAfter: postCompactTokens,
      prunedToolOutputs: pruned.prunedCount,
      anchored: !!priorCompaction,
    });

    return {
      summaryMessage,
      keptMessages: tail,
      postCompactMessages,
      preCompactTokens,
      postCompactTokens,
      prunedToolOutputs: pruned.prunedCount,
      pruningSufficient: false,
      replayMessage,
    };
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    log.warn('autocompact failed', { error: errMsg });

    if (config.onFailure === 'truncate') {
      const truncated = tail;
      log.warn('autocompact truncating', { kept: truncated.length });
      return {
        summaryMessage: {
          role: 'user',
          content: `[Context truncated — ${head.length} earlier messages dropped due to compaction failure]`,
        },
        keptMessages: truncated,
        postCompactMessages: [
          {
            role: 'user',
            content: `[Context truncated — ${head.length} earlier messages dropped]`,
          },
          ...truncated,
        ],
        preCompactTokens,
        postCompactTokens: estimateTokens(truncated),
        prunedToolOutputs: pruned.prunedCount,
        pruningSufficient: false,
        replayMessage,
      };
    }
    throw e;
  }
}

// ─── Overflow detection ─────────────────────────────────────────────────

const OVERFLOW_PATTERNS = [
  /prompt too long/i,
  /context.{0,20}length/i,
  /context.{0,20}exceed/i,
  /maximum.{0,20}context/i,
  /input.{0,20}token.{0,20}limit/i,
  /request.{0,20}too large/i,
  /token.{0,20}limit/i,
  /code["']?:\s*["']?1261/i,
  /maximum.{0,20}tokens/i,
];

export function isContextOverflow(msg: string): boolean {
  if (!msg) return false;
  return OVERFLOW_PATTERNS.some((re) => re.test(msg));
}
