/** Anthropic-protocol call options: accepts a ReasoningInstruction (resolved
 *  by reasoning.ts) and translates it to the correct wire format:
 *  - budget_tokens → native `thinking: { type: 'enabled', budgetTokens }`
 *  - effort → adaptive thinking: `thinking: { type: 'adaptive' }, effort`
 *  - toggle → `thinking: { type: 'enabled', budgetTokens: 1024 }`
 *
 *  Non-allowlisted endpoints (OpenRouter-style aggregators) strip the native
 *  thinking block + cacheControl — detected via ctx.providerBaseUrl.
 */
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

/** Hosts that accept the native Anthropic thinking block. api.z.ai's
 *  Anthropic-compatible endpoint accepts `thinking` + `budget_tokens`
 *  (verified empirically: its 400s cite only the max_tokens range, never
 *  the thinking field). Aggregators like OpenRouter reject it. */
const THINKING_CAPABLE_HOSTS = new Set(['api.anthropic.com', 'api.z.ai']);

/** Detect endpoints that accept the native Anthropic thinking block. */
function isNativeAnthropic(baseUrl?: string): boolean {
  if (!baseUrl) return true; // assume native when unknown
  try {
    return THINKING_CAPABLE_HOSTS.has(new URL(baseUrl).hostname);
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

  // Endpoint outside the allowlist (OpenRouter-style aggregators): strip the
  // native thinking block — these reject `thinking` and `cacheControl` with 400.
  if (!native) {
    return {
      providerOptions: undefined,
      maxOutputTokens: maxBase,
      label: `${reasoning.label} (non-native, thinking stripped)`,
    };
  }

  if (reasoning.contract === 'budget_tokens') {
    const requestedBudget = reasoning.budgetTokens ?? 1024;
    // @ai-sdk/anthropic stacks budgetTokens ON TOP of maxOutputTokens for
    // the wire max_tokens, and providers cap the wire total — often at the
    // same value as our maxBase (z.ai: 131072). Stacking anything would
    // blow the cap (128k + 121k = 249k → 400), so carve the budget out of
    // a fixed total instead: budget ≤ 80% keeps the answer pool usable at
    // every level, and the −1024 reserves output room per the API rule
    // max_tokens > budget_tokens.
    const budgetTokens = Math.max(1024, Math.min(requestedBudget, Math.floor(maxBase * 0.8), maxBase - 1024));

    return {
      providerOptions: {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens },
          cacheControl: { type: 'ephemeral' },
        },
      },
      maxOutputTokens: maxBase - budgetTokens,
      label: budgetTokens < requestedBudget
        ? `thinking.budget_tokens=${requestedBudget}→${budgetTokens} (carved from ${maxBase}, output=${maxBase - budgetTokens})`
        : `thinking.budget_tokens=${budgetTokens}, output=${maxBase - budgetTokens}`,
    };
  }

  if (reasoning.contract === 'effort') {
    // Adaptive thinking: Claude 4.7+ accepts effort alongside adaptive thinking.
    // No budgetTokens → the SDK doesn't stack anything; maxBase is the total.
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
    // The SDK stacks this 1024 on top — carve it so the wire total stays maxBase.
    maxOutputTokens: maxBase - 1024,
    label: reasoning.label,
  };
}
