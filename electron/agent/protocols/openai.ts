/** OpenAI-protocol call options (z.ai, OpenRouter, OpenAI, …): thinking is expressed as `reasoning_effort` (high/max) via providerOptions.openaiCompatible, since the Anthropic thinking block is dropped by the openai-compatible provider. */
import type { ProtocolCallOptions, ProtocolContext, ThinkingConfig } from './types';

const DEFAULT_MAX_TOKENS = 8192;
/** Gemini-backed endpoints cap `max_tokens` (maxOutputTokens) at 65535 (2^16−1); requests above return 400 INVALID_ARGUMENT. Cap here so the thinking budget + base doesn't exceed the provider limit. */
const MAX_OUTPUT_TOKENS_CAP = 65_535;

/** Minimum guaranteed output budget (answer tokens) when tools are present.
 *  Tool-call arguments — especially write_file/edit_file content — count
 *  toward the output budget. The default 8192 starves large file writes:
 *  a 500-line file is ~15K tokens. When tools are present, raise the floor
 *  so the model has room to emit complete tool calls. */
const TOOL_OUTPUT_FLOOR = 16_384;

/** Map Tide's thinking budget onto GLM-5.2's discrete effort tiers: extra/max (≥48000) → `max` (z.ai's recommendation for coding), lower levels → `high`. */
function effortFromBudget(budgetTokens: number): 'high' | 'max' {
  return budgetTokens >= 48_000 ? 'max' : 'high';
}

export function openaiCallOptions(
  thinking: ThinkingConfig | null,
  ctx?: ProtocolContext,
): ProtocolCallOptions {
  let maxBase = ctx?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

  // When tools are present, guarantee a healthy output floor for tool-call
  // arguments (write_file content, edit_file replacements). The default maxBase
  // (8192) is too small for large file writes — they truncate mid-stream.
  if (ctx?.hasTools && maxBase < TOOL_OUTPUT_FLOOR) {
    maxBase = TOOL_OUTPUT_FLOOR;
  }

  if (!thinking) {
    return { providerOptions: undefined, maxOutputTokens: maxBase, label: 'off' };
  }

  // Clamp the thinking budget so the output isn't starved. On OpenAI-protocol
  // providers, maxOutputTokens = thinking + answer (a single pool). At `max`
  // thinking (64K) capped at 65535 total, the model is left with only ~1535
  // output tokens — not enough to complete even a moderate tool call. Cap the
  // thinking portion at 75% of the total so output always gets ≥25%.
  const totalCap = MAX_OUTPUT_TOKENS_CAP;
  const maxThinking = Math.floor(totalCap * 0.75);
  const budgetTokens = Math.min(thinking.budgetTokens, maxThinking);
  const effort = effortFromBudget(budgetTokens);

  // Some Gemini-backed OpenAI-compatible endpoints reject `reasoning_effort`
  // combined with tools (400 INVALID_ARGUMENT). Detect Gemini by model ID —
  // only suppress reasoning_effort for those models. All other providers
  // (z.ai GLM, OpenRouter, OpenAI, Ollama, etc.) get the full effort level.
  const isGemini = ctx?.modelId?.includes('gemini') ?? false;
  if (isGemini && ctx?.hasTools) {
    return {
      providerOptions: undefined,
      maxOutputTokens: Math.min(budgetTokens + maxBase, totalCap),
      label: `reasoning_effort=off (gemini + tools)`,
    };
  }

  const computed = Math.min(budgetTokens + maxBase, totalCap);
  return {
    providerOptions: {
      openaiCompatible: { reasoningEffort: effort },
    },
    maxOutputTokens: computed,
    label: budgetTokens < thinking.budgetTokens
      ? `reasoning_effort=${effort} (budget ${thinking.budgetTokens}→${budgetTokens} clamped, max_tokens=${computed})`
      : `reasoning_effort=${effort} (max_tokens=${computed})`,
  };
}
