/** Anthropic-protocol call options: accepts a ReasoningInstruction (resolved
 *  by reasoning.ts) and translates it to the correct wire format:
 *  - budget_tokens → native `thinking: { type: 'enabled', budgetTokens }`
 *  - effort → adaptive thinking: `thinking: { type: 'adaptive' }, effort`
 *  - toggle → `thinking: { type: 'enabled', budgetTokens: 1024 }`
 *
 *  Non-native Anthropic endpoints (z.ai proxy, etc.) strip the native thinking
 *  block + cacheControl — detected via ctx.providerBaseUrl. */
import type { ProtocolCallOptions, ProtocolContext } from './types';
import type { ReasoningInstruction } from './reasoning';

const DEFAULT_MAX_TOKENS = 8192;

/** Minimum guaranteed output budget (answer tokens) when tools are present.
 *  Tool-call arguments — especially write_file/edit_file content — stream
 *  against the output budget, NOT the thinking budget. The default 8192
 *  starves large file writes: a 500-line file is ~15K tokens, well past 8192.
 *  When tools are present, raise the floor so the model has room to emit
 *  complete tool calls without mid-stream truncation. */
const TOOL_OUTPUT_FLOOR = 16_384;

/** Detect non-native Anthropic endpoints (z.ai proxy, OpenRouter, etc.) that
 *  don't support the native `thinking` block or `cacheControl`. */
function isNativeAnthropic(baseUrl?: string): boolean {
  if (!baseUrl) return true; // assume native when unknown
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.anthropic.com';
  } catch {
    return true;
  }
}

export function anthropicCallOptions(
  reasoning: ReasoningInstruction | null,
  ctx?: ProtocolContext,
): ProtocolCallOptions {
  let maxBase = ctx?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

  // When tools are present, guarantee a healthy output floor. The default
  // maxBase (8192) is the ANSWER budget that tool-call arguments stream
  // against — too small for large write_file/edit_file content. Raise it so
  // the model can complete tool calls without hitting the output cap mid-stream.
  if (ctx?.hasTools && maxBase < TOOL_OUTPUT_FLOOR) {
    maxBase = TOOL_OUTPUT_FLOOR;
  }

  if (!reasoning) {
    return { providerOptions: undefined, maxOutputTokens: maxBase, label: 'off' };
  }

  const native = isNativeAnthropic(ctx?.providerBaseUrl);

  // Non-native endpoint: strip the native thinking block entirely. These
  // proxies (z.ai, OpenRouter) reject `thinking` and `cacheControl` with 400.
  if (!native) {
    return {
      providerOptions: undefined,
      maxOutputTokens: maxBase,
      label: `${reasoning.label} (non-native, thinking stripped)`,
    };
  }

  if (reasoning.contract === 'budget_tokens') {
    const requestedBudget = reasoning.budgetTokens ?? 1024;
    // Clamp the thinking budget so it can't starve the output. The Anthropic
    // API requires max_tokens > budget_tokens. The wire max_tokens = maxBase +
    // budget (the SDK adds them), so budget can be up to the provider's hard
    // cap minus maxBase. Cap budget at 4× maxBase — generous for deep reasoning
    // while keeping output ≥ 20% of total.
    const budgetTokens = Math.min(requestedBudget, maxBase * 4);

    return {
      providerOptions: {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens },
          cacheControl: { type: 'ephemeral' },
        },
      },
      // `maxOutputTokens` is the ANSWER budget only — @ai-sdk/anthropic adds
      // `thinking.budgetTokens` on top for the wire `max_tokens`.
      maxOutputTokens: maxBase,
      label: budgetTokens < requestedBudget
        ? `thinking.budget_tokens=${requestedBudget}→${budgetTokens} (clamped)`
        : `thinking.budget_tokens=${budgetTokens}`,
    };
  }

  if (reasoning.contract === 'effort') {
    // Adaptive thinking: Claude 4.7+ accepts effort alongside adaptive thinking.
    return {
      providerOptions: {
        anthropic: {
          thinking: { type: 'adaptive' },
          effort: reasoning.effort,
          cacheControl: { type: 'ephemeral' },
        },
      },
      maxOutputTokens: maxBase,
      label: reasoning.label,
    };
  }

  // Toggle: just enable thinking with a minimal budget.
  return {
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 1024 },
        cacheControl: { type: 'ephemeral' },
      },
    },
    maxOutputTokens: maxBase,
    label: reasoning.label,
  };
}
