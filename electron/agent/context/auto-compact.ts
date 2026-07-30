/**
 * Context management — autocompact.
 *
 * When a conversation approaches the model's context window, summarize old
 * messages and keep recent ones verbatim. This prevents 413 (prompt-too-long)
 * errors on long sessions without losing essential context.
 *
 * Compaction runs between steps via the SDK's `prepareStep` hook (which
 * supports async returns). The forked summarizer call uses the same
 * provider/model as the main turn, matching Claude Code's approach of
 * summarizing on the main-loop model (not a small/cheap model).
 *
 * Three layers (matching Claude Code's architecture, simplified):
 *   1. Token estimation (character-based heuristic — no tokenizer dependency)
 *   2. Threshold check (configurable, default 75% of context window)
 *   3. Forked summarization (generateText with a compact-prompt system message)
 */
import { generateText } from 'ai';
import { resolveModel } from '../provider-factory.js';
import { resolveProtocolOptions } from '../protocols/index.js';
import { resolveMaxOutputTokens } from '../model-capabilities.js';
import { createLogger } from '../../logger.js';
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
  /** Context window size for the model (tokens). */
  contextWindow: number;
  /** Compaction threshold as fraction of contextWindow (default 0.75). */
  threshold: number;
  /** Recent turns to keep verbatim (default 3). A "turn" = user + assistant pair. */
  keepRecentTurns: number;
  /** What to do on compaction failure. */
  onFailure: 'truncate' | 'error';
}

export const DEFAULT_AUTO_COMPACT_CONFIG: AutoCompactConfig = {
  contextWindow: 128_000,
  threshold: 0.75,
  keepRecentTurns: 3,
  onFailure: 'truncate',
};

/** Circuit breaker — stop trying after this many consecutive failures. */
const MAX_CONSECUTIVE_FAILURES = 3;

// ─── Token estimation ───────────────────────────────────────────────────

/**
 * Estimate token count from message array. Uses a character-based heuristic
 * (~3.5 chars/token for mixed English/code) — no tokenizer dependency. Good
 * enough for threshold checks; the actual API enforces the hard limit.
 */
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

/**
 * Should we compact? True when estimated tokens exceed threshold fraction of
 * the context window, minus a safety buffer for the model's output.
 */
export function shouldCompact(
  messages: ModelMessage[],
  config: AutoCompactConfig,
  consecutiveFailures = 0,
): boolean {
  // Circuit breaker — don't try again after repeated failures
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;

  const effectiveWindow = config.contextWindow - 8_000; // reserve for output
  const thresholdTokens = Math.floor(effectiveWindow * config.threshold);
  const tokens = estimateTokens(messages);
  return tokens >= thresholdTokens;
}

// ─── Compaction ─────────────────────────────────────────────────────────

/**
 * Compact the conversation: summarize old messages, keep recent ones.
 *
 * Splits messages into:
 *   - Old messages (summarized via a forked generateText call)
 *   - Recent turns (kept verbatim — `keepRecentTurns` user+assistant pairs)
 *
 * The summary becomes a system-tagged user message at the start of the
 * compacted array, followed by the kept messages.
 */
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
    const summary = await summarizeMessages(oldMessages, ctx);

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

/**
 * Fork a generateText call to summarize old conversation messages.
 * Uses the same provider/model/protocol as the main turn.
 */
async function summarizeMessages(
  messages: ModelMessage[],
  ctx: { provider: Provider; modelId: string; signal: AbortSignal },
): Promise<string> {
  if (!ctx.provider.apiKey) {
    throw new Error('Cannot compact: provider has no API key');
  }

  const model = resolveModel(ctx.provider, { modelId: ctx.modelId, contextWindow: 0 } as any);
  const proto = resolveProtocolOptions(
    ctx.provider.apiStyle,
    { budgetTokens: 4096 },
    { hasTools: false, modelId: ctx.modelId, maxOutputTokens: resolveMaxOutputTokens(ctx.modelId) },
  );

  // Serialize old messages into a single text block for the summarizer
  const serialized = serializeForSummary(messages);

  const result = await generateText({
    model,
    system:
      'You are a conversation summarizer. Create a concise, information-dense summary ' +
      'of the conversation below. Preserve: decisions made, files created/edited, ' +
      'errors encountered and their resolutions, the current task state, and any ' +
      'important context the model needs to continue. Drop pleasantries, redundant ' +
      'tool outputs, and anything not essential for continuing the work. ' +
      'Format as bullet points under a "## Prior Context" heading.',
    prompt: serialized,
    providerOptions: proto.providerOptions,
    maxOutputTokens: Math.min(proto.maxOutputTokens, 4096),
    abortSignal: ctx.signal,
  });

  return (result.text ?? '').trim() || '(Summary generation returned empty content)';
}

/**
 * Serialize messages into a text block suitable for summarization.
 * Strips tool result bodies (replaces with a placeholder) to keep the
 * summarizer input manageable.
 */
function serializeForSummary(messages: ModelMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    if (typeof msg.content === 'string') {
      parts.push(`[${role}]\n${msg.content.slice(0, 2000)}`);
    } else if (Array.isArray(msg.content)) {
      const texts: string[] = [];
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          texts.push(String((part as { text: string }).text).slice(0, 2000));
        }
      }
      if (texts.length > 0) {
        parts.push(`[${role}]\n${texts.join('\n')}`);
      }
    }
  }
  return parts.join('\n\n---\n\n');
}
