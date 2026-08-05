/** Anthropic-protocol call options: thinking = native `thinking` block with budget_tokens (max_tokens must exceed budget_tokens), and prompt caching rides along via cacheControl (no-op on providers that lack it). */
import type { ProtocolCallOptions, ProtocolContext, ThinkingConfig } from './types';

const DEFAULT_MAX_TOKENS = 8192;

export function anthropicCallOptions(
  thinking: ThinkingConfig | null,
  _ctx?: ProtocolContext,
): ProtocolCallOptions {
  const maxBase = _ctx?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  if (!thinking) {
    return { providerOptions: undefined, maxOutputTokens: maxBase, label: 'off' };
  }
  return {
    providerOptions: {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: thinking.budgetTokens },
        cacheControl: { type: 'ephemeral' },
      },
    },
    // `maxOutputTokens` is the ANSWER budget only — @ai-sdk/anthropic adds `thinking.budgetTokens` on top for the wire `max_tokens` (total = maxBase + budgetTokens). Passing `budget + 8192` here used to double-count (`2×budget + 8192`), blowing past provider output caps (z.ai: 131072) at extra/max tiers. Anthropic's `max_tokens > budget_tokens` rule holds since maxBase > 0.
    maxOutputTokens: maxBase,
    label: `thinking.budget_tokens=${thinking.budgetTokens}`,
  };
}
