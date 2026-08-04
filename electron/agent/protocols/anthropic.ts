/**
 * Anthropic-protocol call options.
 *
 * Thinking = the native `thinking` block with `budget_tokens`. Anthropic
 * requires `max_tokens > budget_tokens` when thinking is on, so the output
 * cap tracks the budget. Prompt caching rides along via `cacheControl` — it's
 * a no-op on providers that don't support it.
 */
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
    // `maxOutputTokens` is the ANSWER budget only — @ai-sdk/anthropic adds
    // `thinking.budgetTokens` on top to produce the wire `max_tokens`. So the
    // on-the-wire total is `maxBase + budgetTokens` (e.g. 72192 at the
    // max tier with the default 8192 base). Passing `budget + 8192` here used
    // to double-count the budget (`2×budget + 8192`), which blew past provider
    // output caps (z.ai: 131072) at the extra/max tiers. Anthropic's
    // `max_tokens > budget_tokens` rule is satisfied because maxBase > 0 and
    // the SDK adds the full budget.
    maxOutputTokens: maxBase,
    label: `thinking.budget_tokens=${thinking.budgetTokens}`,
  };
}
