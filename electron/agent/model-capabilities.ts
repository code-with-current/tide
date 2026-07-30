/**
 * Model capability detection — delegates to the catalog resolver when a match
 * exists, falling back to heuristic prefix tables for models the catalog
 * doesn't know (custom, fine-tuned, private deployments).
 *
 * The catalog resolver is the source of truth; the prefix tables here are the
 * conservative fallback. Existing callers (orchestrator-sdk, ModelSelector,
 * ChatComposer) keep their signatures.
 */
import { resolveModelMeta } from './model-catalog.js';
import type { CatalogMap, ModelRef } from './model-catalog.js';

// Set once at app start by the IPC layer. null until then.
let activeCatalog: CatalogMap | null = null;

/** Inject the loaded catalog so subsequent capability lookups use it. */
export function setCatalog(map: CatalogMap | null) {
  activeCatalog = map;
}

// ─── Heuristic fallback tables (kept for uncatalogued models) ──────────

/**
 * Model id prefixes that indicate thinking/reasoning support.
 * Checked via `modelId.startsWith(prefix)` (case-insensitive) as a FALLBACK
 * when the catalog has no match. Maintained against the July 2026 landscape.
 *
 * Sources: provider docs, July 2026.
 *   - Anthropic: claude-sonnet, claude-opus, claude-haiku, claude-fable,
 *     claude-mythos, claude-3-7
 *   - OpenAI: o1, o3, o4, gpt-5 (includes 5.1, 5.2, 5.6 variants), gpt-oss
 *   - Google: gemini-2, gemini-3 (includes Flash Thinking)
 *   - xAI: grok-3, grok-4
 *   - DeepSeek: deepseek-r
 *   - Alibaba: qwq, qwen3
 *   - Moonshot: kimi-k2, kimi-k3
 *   - Z.ai: glm-4, glm-5 (GLM 4.5+ supports extended thinking)
 */
export const REASONING_MODEL_PREFIXES = [
  // Anthropic
  'claude-sonnet',
  'claude-opus',
  'claude-haiku',
  'claude-fable',
  'claude-mythos',
  'claude-3-7',
  // OpenAI
  'o1',
  'o3',
  'o4',
  'gpt-5',
  'gpt-oss',
  // Google
  'gemini-2',
  'gemini-3',
  // xAI
  'grok-3',
  'grok-4',
  // DeepSeek
  'deepseek-r',
  // Alibaba
  'qwq',
  'qwen3',
  // Moonshot
  'kimi-k2',
  'kimi-k3',
  // Z.ai / Zhipu
  'glm-4',
  'glm-5',
];

/**
 * Context window size lookup by model family, used as a FALLBACK when the
 * catalog has no match. Returns the context window in tokens, or undefined if
 * unknown (falls back to the model's configured contextWindow from settings).
 *
 * Values from provider docs, July 2026. Where providers list "up to N" or
 * experimental figures, the max is used.
 */
const CONTEXT_WINDOWS: Array<{ prefix: string; tokens: number }> = [
  // Anthropic — specific models first (longer prefixes)
  { prefix: 'claude-opus-4', tokens: 1_000_000 },
  { prefix: 'claude-3-7', tokens: 128_000 },
  { prefix: 'claude-sonnet-5', tokens: 200_000 },
  { prefix: 'claude-sonnet', tokens: 200_000 },
  { prefix: 'claude-opus', tokens: 200_000 },
  { prefix: 'claude-haiku', tokens: 200_000 },
  // Z.ai / GLM
  { prefix: 'glm-5.2[1m]', tokens: 1_000_000 },
  { prefix: 'glm-5.2', tokens: 200_000 },
  { prefix: 'glm-5.1', tokens: 200_000 },
  { prefix: 'glm-4.6', tokens: 200_000 },
  { prefix: 'glm-4', tokens: 128_000 },
  { prefix: 'glm-5', tokens: 200_000 },
  // OpenAI
  { prefix: 'o3', tokens: 200_000 },
  { prefix: 'o4', tokens: 200_000 },
  { prefix: 'o1', tokens: 200_000 },
  { prefix: 'gpt-5', tokens: 200_000 },
  // Google
  { prefix: 'gemini-2.5-pro', tokens: 1_000_000 },
  { prefix: 'gemini-2', tokens: 1_000_000 },
  { prefix: 'gemini-3', tokens: 1_000_000 },
  // xAI
  { prefix: 'grok-4', tokens: 1_000_000 },
  { prefix: 'grok-3', tokens: 131_072 },
  // Alibaba
  { prefix: 'qwen3-235b', tokens: 256_000 },
  { prefix: 'qwen3', tokens: 128_000 },
  { prefix: 'qwq', tokens: 128_000 },
  // Moonshot
  { prefix: 'kimi-k3', tokens: 1_000_000 },
  { prefix: 'kimi-k2', tokens: 256_000 },
  // DeepSeek
  { prefix: 'deepseek-r', tokens: 128_000 },
];

function heuristicReasoning(modelId: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return REASONING_MODEL_PREFIXES.some((p) => lower.startsWith(p));
}

function heuristicContextWindow(modelId: string): number | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  for (const { prefix, tokens } of CONTEXT_WINDOWS) {
    if (lower.startsWith(prefix)) return tokens;
  }
  return undefined;
}

// ─── Public API (signatures unchanged) ─────────────────────────────────

/**
 * Does this model support extended thinking / reasoning?
 * Uses the catalog when available; falls back to prefix heuristics otherwise.
 */
export function supportsThinking(modelId: string): boolean {
  if (activeCatalog) {
    const ref: ModelRef = { modelId, contextWindow: 0 };
    const meta = resolveModelMeta(ref, activeCatalog);
    if (meta.resolvedCatalogId) return meta.supportsReasoning;
  }
  return heuristicReasoning(modelId);
}

/**
 * Get the context window size for a model by its modelId.
 * Uses the catalog when available; falls back to prefix heuristics otherwise.
 * Returns undefined when unknown.
 */
export function contextWindowSize(modelId: string): number | undefined {
  if (activeCatalog) {
    const ref: ModelRef = { modelId, contextWindow: 0 };
    const meta = resolveModelMeta(ref, activeCatalog);
    if (meta.resolvedCatalogId) return meta.contextWindow;
  }
  return heuristicContextWindow(modelId);
}

/**
 * Resolve max output tokens for a modelId using the active catalog (or
 * conservative 8192 default). Convenience wrapper so callers (e.g. the
 * protocol-context builders in the orchestrator) don't need direct catalog
 * access — they just thread the result into `ProtocolContext.maxOutputTokens`.
 */
export function resolveMaxOutputTokens(modelId: string): number {
  if (activeCatalog) {
    const meta = resolveModelMeta({ modelId, contextWindow: 0 }, activeCatalog);
    return meta.maxOutputTokens;
  }
  return 8192; // conservative default before catalog loads
}

// Re-export the resolver + formatter for callers that want full metadata.
export { resolveModelMeta, formatPriceRate } from './model-catalog.js';
export type { ModelMeta } from './model-catalog.js';
