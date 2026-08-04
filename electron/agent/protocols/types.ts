/**
 * Shared types for per-protocol call-option resolution.
 *
 * Each protocol expresses "thinking" differently and may grow its own
 * provider-specific knobs (cache headers, telemetry, model quirts). The
 * ProtocolCallOptions shape is what every protocol builder returns, so the
 * orchestrator can consume it uniformly without knowing which protocol
 * produced it.
 */

/** Resolved thinking config (from Tide's thinkingLevel). */
export interface ThinkingConfig {
  /** Anthropic budget_tokens / the level's token budget. */
  budgetTokens: number;
}

/** What a protocol builder hands back to the orchestrator. */
export interface ProtocolCallOptions {
  /** Passed straight to `streamText({ providerOptions })`. */
  providerOptions: Record<string, unknown> | undefined;
  /** Output cap. Anthropic requires this > budget_tokens when thinking is on;
   *  OpenAI-protocol providers are lenient but benefit from a generous cap. */
  maxOutputTokens: number;
  /** Human-readable for the `[agent-sdk]` diagnostic log. */
  label: string;
}

/**
 * Context passed to protocol builders so they can make decisions based on
 * what else is in the request (e.g. some providers reject `reasoning_effort`
 * when tools are present).
 */
export interface ProtocolContext {
  /** Whether the current step has tool definitions. Some Gemini endpoints
   *  reject `reasoning_effort` + tools with a 400 INVALID_ARGUMENT. */
  hasTools: boolean;
  /** The model ID being called — used to detect provider-specific quirks
   *  (e.g. Gemini models need reasoning_effort suppressed when tools are
   *  present, but other OpenAI-compatible models don't). */
  modelId?: string;
  /** The model's max output tokens, resolved from the catalog (or a
   *  conservative default). When present, protocol builders use this as the
   *  base output cap instead of the hardcoded 8192. */
  maxOutputTokens?: number;
  /** The provider's base URL. Used to detect non-native Anthropic endpoints
   *  (e.g. z.ai's Anthropic-compatible proxy) that don't support the native
   *  `thinking` block or `cacheControl`. When the host is NOT api.anthropic.com,
   *  these fields are stripped to avoid provider 400/404 errors. */
  providerBaseUrl?: string;
}
