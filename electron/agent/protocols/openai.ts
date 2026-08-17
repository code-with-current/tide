/** OpenAI-protocol call options (z.ai, OpenRouter, OpenAI, …): accepts a
 *  ReasoningInstruction (resolved by reasoning.ts) and translates it to the
 *  correct wire format:
 *  - effort → `reasoningEffort` string sent directly (no precision loss!)
 *  - budget_tokens → derives effort via budgetToEffort (lossy but correct)
 *  - toggle → `reasoningEffort: 'medium'` (just enable thinking)
 *
 *  The key improvement over the old code: effort strings are sent directly */
import type { ProtocolCallOptions, ProtocolContext } from './types';
import type { ReasoningInstruction } from './reasoning';
import { budgetToEffort } from './reasoning';

const DEFAULT_MAX_TOKENS = 8192;
/** Gemini-backed endpoints cap `max_tokens` (maxOutputTokens) at 65535 (2^16−1); requests above return 400 INVALID_ARGUMENT. Cap here so the thinking budget + base doesn't exceed the provider limit. */
const MAX_OUTPUT_TOKENS_CAP = 65_535;

/** Minimum guaranteed output budget (answer tokens) when tools are present.
 *  Tool-call arguments — especially write_file/edit_file content — count
 *  toward the output budget. The default 8192 starves large file writes:
 *  a 500-line file is ~15K tokens. When tools are present, raise the floor
 *  so the model has room to emit complete tool calls. */
const TOOL_OUTPUT_FLOOR = 16_384;

export function openaiCallOptions(
  reasoning: ReasoningInstruction | null,
  ctx?: ProtocolContext,
): ProtocolCallOptions {
  let maxBase = ctx?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

  // When tools are present, guarantee a healthy output floor for tool-call
  // arguments (write_file content, edit_file replacements). The default maxBase
  // (8192) is too small for large file writes — they truncate mid-stream.
  if (ctx?.hasTools && maxBase < TOOL_OUTPUT_FLOOR) {
    maxBase = TOOL_OUTPUT_FLOOR;
  }

  if (!reasoning) {
    return { providerOptions: undefined, maxOutputTokens: maxBase, label: 'off' };
  }

  // Some Gemini-backed OpenAI-compatible endpoints reject `reasoning_effort`
  // combined with tools (400 INVALID_ARGUMENT). Detect Gemini by model ID —
  // only suppress reasoning_effort for those models. All other providers
  // (z.ai GLM, OpenRouter, OpenAI, Ollama, etc.) get the full effort level.
  const isGemini = ctx?.modelId?.includes('gemini') ?? false;
  if (isGemini && ctx?.hasTools) {
    const budgetForCap = reasoning.budgetTokens ?? 8192;
    return {
      providerOptions: undefined,
      maxOutputTokens: Math.min(budgetForCap + maxBase, MAX_OUTPUT_TOKENS_CAP),
      label: `reasoning_effort=off (gemini + tools)`,
    };
  }

  // Resolve the effort string from the instruction.
  let effort: string;
  if (reasoning.contract === 'effort') {
    effort = reasoning.effort ?? 'high';
  } else if (reasoning.contract === 'budget_tokens') {
    // Budget contract on OpenAI protocol: derive effort (lossy).
    effort = budgetToEffort(reasoning.budgetTokens ?? 8192);
  } else {
    // Toggle: just enable thinking at a medium level.
    effort = 'medium';
  }

  // Compute maxOutputTokens. For effort-based reasoning, we no longer add
  // a budget to maxBase — the effort string controls thinking depth, and
  // maxOutputTokens is the total output pool. For budget-derived effort,
  // preserve the old behavior of budget + maxBase (capped).
  const computed = reasoning.budgetTokens != null
    ? Math.min(reasoning.budgetTokens + maxBase, MAX_OUTPUT_TOKENS_CAP)
    : Math.min(maxBase, MAX_OUTPUT_TOKENS_CAP);

  return {
    providerOptions: {
      openaiCompatible: { reasoningEffort: effort },
    },
    maxOutputTokens: computed,
    label: reasoning.contract === 'budget_tokens'
      ? `reasoning_effort=${effort} (derived from budget=${reasoning.budgetTokens}, max_tokens=${computed})`
      : `reasoning_effort=${effort} (max_tokens=${computed})`,
  };
}
