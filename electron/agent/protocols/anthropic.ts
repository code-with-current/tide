/** Anthropic-protocol call options: thinking = native `thinking` block with budget_tokens (max_tokens must exceed budget_tokens), and prompt caching rides along via cacheControl (no-op on providers that lack it). */
import type { ProtocolCallOptions, ProtocolContext, ThinkingConfig } from './types';

const DEFAULT_MAX_TOKENS = 8192;

/** Minimum guaranteed output budget (answer tokens) when tools are present.
 *  Tool-call arguments — especially write_file/edit_file content — stream
 *  against the output budget, NOT the thinking budget. The default 8192
 *  starves large file writes: a 500-line file is ~15K tokens, well past 8192.
 *  When tools are present, raise the floor so the model has room to emit
 *  complete tool calls without mid-stream truncation. */
const TOOL_OUTPUT_FLOOR = 16_384;

export function anthropicCallOptions(
  thinking: ThinkingConfig | null,
  ctx?: ProtocolContext,
): ProtocolCallOptions {
  let maxBase = ctx?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

  // When tools are present, guarantee a healthy output floor. The default
  // maxBase (8192) is the ANSWER budget that tool-call arguments stream
  // against — too small for large write_file/edit_file content. Raise it so
  // the model can complete tool calls without hitting the output cap mid-stream.
  // (The thinking budget is separate; it does NOT consume this space.)
  if (ctx?.hasTools && maxBase < TOOL_OUTPUT_FLOOR) {
    maxBase = TOOL_OUTPUT_FLOOR;
  }

  if (!thinking) {
    return { providerOptions: undefined, maxOutputTokens: maxBase, label: 'off' };
  }

  // Clamp the thinking budget so it can't starve the output. The Anthropic API
  // requires max_tokens > budget_tokens. The wire max_tokens = maxBase + budget
  // (the SDK adds them), so budget can be up to the provider's hard cap minus
  // maxBase. But if the user picked a huge thinking level (e.g. 64K) on a model
  // with a small total output cap, the combination can blow past the provider
  // limit or leave the model no room to finish after thinking. Cap budget at
  // 4× maxBase — generous for deep reasoning while keeping output ≥ 20% of total.
  const budgetTokens = Math.min(thinking.budgetTokens, maxBase * 4);

  return {
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens },
        cacheControl: { type: 'ephemeral' },
      },
    },
    // `maxOutputTokens` is the ANSWER budget only — @ai-sdk/anthropic adds
    // `thinking.budgetTokens` on top for the wire `max_tokens`
    // (total = maxBase + budgetTokens).
    maxOutputTokens: maxBase,
    label: budgetTokens < thinking.budgetTokens
      ? `thinking.budget_tokens=${thinking.budgetTokens}→${budgetTokens} (clamped)`
      : `thinking.budget_tokens=${budgetTokens}`,
  };
}
