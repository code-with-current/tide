/** OpenAI-protocol call options (z.ai, OpenRouter, OpenAI, …): thinking is expressed as `reasoning_effort` (high/max) via providerOptions.openaiCompatible, since the Anthropic thinking block is dropped by the openai-compatible provider. */
import type { ProtocolCallOptions, ProtocolContext, ThinkingConfig } from './types';

const DEFAULT_MAX_TOKENS = 8192;
/** Gemini-backed endpoints cap `max_tokens` (maxOutputTokens) at 65535 (2^16−1); requests above return 400 INVALID_ARGUMENT. Cap here so the thinking budget + base doesn't exceed the provider limit. */
const MAX_OUTPUT_TOKENS_CAP = 65_535;

/** Map Tide's thinking budget onto GLM-5.2's discrete effort tiers: extra/max (≥48000) → `max` (z.ai's recommendation for coding), lower levels → `high`. */
function effortFromBudget(budgetTokens: number): 'high' | 'max' {
  return budgetTokens >= 48_000 ? 'max' : 'high';
}

export function openaiCallOptions(
  thinking: ThinkingConfig | null,
  ctx?: ProtocolContext,
): ProtocolCallOptions {
  const maxBase = ctx?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  if (!thinking) {
    return { providerOptions: undefined, maxOutputTokens: maxBase, label: 'off' };
  }
  const effort = effortFromBudget(thinking.budgetTokens);

  // Some Gemini-backed OpenAI-compatible endpoints reject `reasoning_effort`
  // combined with tools (400 INVALID_ARGUMENT). Detect Gemini by model ID —
  // only suppress reasoning_effort for those models. All other providers
  // (z.ai GLM, OpenRouter, OpenAI, Ollama, etc.) get the full effort level.
  const isGemini = ctx?.modelId?.includes('gemini') ?? false;
  if (isGemini && ctx?.hasTools) {
    return {
      providerOptions: undefined,
      maxOutputTokens: Math.min(thinking.budgetTokens + maxBase, MAX_OUTPUT_TOKENS_CAP),
      label: `reasoning_effort=off (gemini + tools)`,
    };
  }

  return {
    providerOptions: {
      openaiCompatible: { reasoningEffort: effort },
    },
    // GLM-5.2's output cap (~85k at max effort) comfortably fits budget+8192.
    // Keep it generous so long reasoning chains have room. Capped at 65535
    // for Gemini-backed endpoints that reject values above 2^16−1.
    maxOutputTokens: Math.min(thinking.budgetTokens + maxBase, MAX_OUTPUT_TOKENS_CAP),
    label: `reasoning_effort=${effort}`,
  };
}
