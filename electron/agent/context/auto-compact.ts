/** Context autocompact: when a conversation nears the model's context window, summarize old messages and keep recent ones verbatim to avoid 413 errors. Runs between steps via the SDK's `prepareStep` hook; the forked summarizer uses the main-loop model. Three layers: char-based token estimate, threshold check (default 75%), forked generateText summarization. */
import { createLogger } from '../../logger.js';
import { generateSessionSummary } from './summarize.js';
import type { Provider } from '../../../src/types/index.js';
import type { ModelMessage } from 'ai';

const log = createLogger('auto-compact');

// ─── Types ──────────────────────────────────────────────────────────────

export interface CompactionResult {
  /** The summary message replacing old context. */
  summaryMessage: ModelMessage;
  /** Messages kept verbatim (recent turns). */
  keptMessages: ModelMessage[];
  /** Full message array after compaction: [summaryMessage, ...keptMessages]. */
  postCompactMessages: ModelMessage[];
  /** Token counts for telemetry / circuit-breaking. */
  preCompactTokens: number;
  postCompactTokens: number;
}

export interface AutoCompactConfig {
  /** Total context window for the model (tokens). */
  contextWindow: number;
  /** Max input tokens the provider accepts. Falls back to contextWindow.
   *  Some providers (Google) cap this below context − output. */
  maxInputTokens?: number;
  /** Max output tokens the model will request per response. Subtracted from
   *  the context window to compute the usable input budget — mirrors
   *  opencode: usable = (input || context) − maxOutputTokens. */
  maxOutputTokens: number;
  /** Compaction threshold as fraction of the usable input budget (default 0.75). */
  threshold: number;
  /** Recent turns to keep verbatim (default 3). A "turn" = user + assistant pair. */
  keepRecentTurns: number;
  /** What to do on compaction failure. */
  onFailure: 'truncate' | 'error';
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

/** Estimate token count via a char-based heuristic (~3.5 chars/token) — no tokenizer dependency; good enough for threshold checks since the API enforces the hard limit. */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          chars += String((part as { text: string }).text).length;
        }
      }
    }
    // Role + structural overhead — ~4 tokens per message boundary
    chars += 14;
  }
  return Math.ceil(chars / 3.5);
}

// ─── Threshold check ────────────────────────────────────────────────────

/** Usable input budget: how many input tokens the conversation can hold
 *  before the provider rejects it. Mirrors opencode's usable():
 *    usable = (maxInputTokens || contextWindow) − maxOutputTokens
 *  The provider subtracts max_tokens from the available input, so the real
 *  ceiling is context − maxOutputTokens, not context − 8000. */
export function usableInputBudget(config: AutoCompactConfig): number {
  const context = config.maxInputTokens ?? config.contextWindow;
  return Math.max(0, context - config.maxOutputTokens);
}

/** Should we compact? True when tokens exceed threshold fraction of the
 *  usable input budget ((input || context) − maxOutputTokens). Prefers
 *  `actualInputTokens` from the API response when available — the char
 *  heuristic underestimates code-heavy chats 2–5x. */
export function shouldCompact(
  messages: ModelMessage[],
  config: AutoCompactConfig,
  consecutiveFailures = 0,
  actualInputTokens?: number,
): boolean {
  // Circuit breaker — don't try again after repeated failures
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;

  const usable = usableInputBudget(config);
  if (usable <= 0) return false;
  const thresholdTokens = Math.floor(usable * config.threshold);

  // Use actual token count if available (from the last API response's usage).
  // Fall back to the character-based heuristic.
  const tokens = actualInputTokens && actualInputTokens > 0
    ? actualInputTokens
    : estimateTokens(messages);
  return tokens >= thresholdTokens;
}

// ─── Compaction ─────────────────────────────────────────────────────────

/** Compact the conversation: fork a generateText call to summarize old messages, keep the last `keepRecentTurns` user+assistant pairs verbatim, and prepend the summary as a system-tagged user message. */
export async function compactConversation(
  messages: ModelMessage[],
  config: AutoCompactConfig,
  ctx: { provider: Provider; modelId: string; signal: AbortSignal },
): Promise<CompactionResult> {
  const preCompactTokens = estimateTokens(messages);

  // Split: find the cutoff for recent turns. A "turn" is a user→assistant
  // pair. We keep the last `keepRecentTurns * 2` messages (plus any trailing
  // user message). Count from the end.
  const messagesPerTurn = 2; // user + assistant
  const keepCount = Math.min(
    config.keepRecentTurns * messagesPerTurn,
    messages.length - 1, // always summarize at least 1 message
  );
  const cutoff = messages.length - keepCount;
  const oldMessages = messages.slice(0, cutoff);
  const keptMessages = messages.slice(cutoff);

  if (oldMessages.length === 0) {
    // Nothing to summarize — return as-is
    return {
      summaryMessage: messages[0],
      keptMessages: messages.slice(1),
      postCompactMessages: messages,
      preCompactTokens,
      postCompactTokens: preCompactTokens,
    };
  }

  // Fork a summarizer call
  try {
    const summary = await generateSessionSummary(oldMessages, ctx);

    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[Compacted context — summary of ${oldMessages.length} earlier messages]\n\n${summary}`,
    };

    const postCompactMessages = [summaryMessage, ...keptMessages];
    const postCompactTokens = estimateTokens(postCompactMessages);

    log.info('autocompact', {
      messagesBefore: messages.length,
      messagesAfter: postCompactMessages.length,
      tokensBefore: preCompactTokens,
      tokensAfter: postCompactTokens,
    });

    return {
      summaryMessage,
      keptMessages,
      postCompactMessages,
      preCompactTokens,
      postCompactTokens,
    };
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    log.warn('autocompact failed', { error: errMsg });

    if (config.onFailure === 'truncate') {
      // Fallback: keep only recent messages, drop old ones entirely.
      // Better than crashing with a 413.
      const truncated = keptMessages;
      log.warn('autocompact truncating', { kept: truncated.length });
      return {
        summaryMessage: {
          role: 'user',
          content: `[Context truncated — ${oldMessages.length} earlier messages dropped due to compaction failure]`,
        },
        keptMessages: truncated,
        postCompactMessages: [
          {
            role: 'user',
            content: `[Context truncated — ${oldMessages.length} earlier messages dropped]`,
          },
          ...truncated,
        ],
        preCompactTokens,
        postCompactTokens: estimateTokens(truncated),
      };
    }
    throw e;
  }
}

// ─── Summarization ──────────────────────────────────────────────────────

// summarizeMessages + serializeForSummary extracted to ./summarize.ts (shared with session-fork).

// ─── Overflow detection ─────────────────────────────────────────────────

/** Patterns that indicate the provider rejected the request because the
 *  prompt exceeded the context window. These are NOT transient — retrying
 *  with the same payload will fail identically. The orchestrator should
 *  force-compaction instead of blind-retrying. */
const OVERFLOW_PATTERNS = [
  /prompt too long/i,
  /context.{0,20}length/i,
  /context.{0,20}exceed/i,
  /maximum.{0,20}context/i,
  /input.{0,20}token.{0,20}limit/i,
  /request.{0,20}too large/i,
  /token.{0,20}limit/i,
  /code["']?:\s*["']?1261/i, // z.ai "Prompt too long"
  /maximum.{0,20}tokens/i,
];

/** True when an error message indicates a context-overflow rejection. */
export function isContextOverflow(msg: string): boolean {
  if (!msg) return false;
  return OVERFLOW_PATTERNS.some((re) => re.test(msg));
}

