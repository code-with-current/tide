/** Model catalog resolver: single source of truth for model metadata via deterministic lookup (catalogId → auto-match → conservative fallback). Pure, no I/O. */
import type { CatalogEntry } from './model-prices.js';

export type CatalogMap = Map<string, CatalogEntry>;

export interface ModelRef {
  catalogId?: string;
  modelId: string;
  contextWindow: number;
}

export interface MatchResult {
  state: 'matched' | 'ambiguous' | 'none';
  matches: CatalogEntry[];
}

/** Normalize a model id: lowercase, trim, drop the provider prefix segment so 'claude-sonnet-4-5' and 'anthropic/claude-sonnet-4-5' compare equal. */
function normalize(id: string): string {
  const trimmed = id.trim().toLowerCase();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Match a modelId against the catalog; returns 'matched', 'ambiguous', or 'none'. Identical cross-provider entries collapse to 'matched'; only genuinely conflicting matches stay 'ambiguous'. */
export function matchModelToCatalog(modelId: string, catalog: CatalogMap): MatchResult {
  if (!modelId?.trim()) return { state: 'none', matches: [] };
  const lower = modelId.trim().toLowerCase();

  // 1. Exact key match (modelId IS the full canonical id).
  const exact = catalog.get(lower) ?? catalog.get(modelId.trim());
  if (exact) return { state: 'matched', matches: [exact] };

  // 2. Suffix match: catalog key's normalized tail equals the modelId's tail.
  const target = normalize(modelId);
  const suffixMatches: CatalogEntry[] = [];
  for (const [key, value] of catalog) {
    if (normalize(key) === target) suffixMatches.push(value);
  }

  if (suffixMatches.length === 1) return { state: 'matched', matches: suffixMatches };
  if (suffixMatches.length > 1) {
    const picked = disambiguate(suffixMatches, catalog, target);
    if (picked) return { state: 'matched', matches: [picked] };
    return { state: 'ambiguous', matches: suffixMatches };
  }

  // 3. Loose fallback: modelId is a substring (>=4 chars) of a catalog tail.
  //    e.g. 'sonnet-4' is contained in 'claude-sonnet-4-5'. Treat as ambiguous.
  const loose: CatalogEntry[] = [];
  for (const [key, value] of catalog) {
    if (target.length >= 4 && normalize(key).includes(target)) {
      loose.push(value);
    }
  }

  if (loose.length === 1) return { state: 'matched', matches: loose };
  if (loose.length > 1) {
    const picked = disambiguate(loose, catalog, target);
    if (picked) return { state: 'matched', matches: [picked] };
    return { state: 'ambiguous', matches: loose };
  }

  return { state: 'none', matches: [] };
}

/** Collapse an ambiguous match set to one entry when hits are the same model (bare canonical key, or all agree on price + context); returns null on genuine conflict. */
function disambiguate(
  hits: CatalogEntry[],
  catalog: CatalogMap,
  target: string,
): CatalogEntry | null {
  // (a) Bare key = the model's canonical home entry.
  for (const h of hits) {
    const key = h.catalogId;
    if (!key.includes('/')) return h;
  }
  // Also accept a key whose normalized tail equals the full key (no provider segment).
  // (b) Agreement check on price + context.
  const first = hits[0];
  const agree = hits.every((h) =>
    h.inputCostPerToken === first.inputCostPerToken &&
    h.outputCostPerToken === first.outputCostPerToken &&
    h.maxInputTokens === first.maxInputTokens,
  );
  if (agree) return first;
  // `target` and `catalog` are referenced for future provider-aware picking;
  // kept in the signature so the contract is stable as disambiguation grows.
  void target; void catalog;
  return null;
}

export interface ModelMeta {
  contextWindow: number;
  maxOutputTokens: number;
  supportsReasoning: boolean;
  supportsFunctionCalling: boolean;
  supportsPromptCaching: boolean;
  supportsVision: boolean;
  mode: string;
  isValidForMainRole: boolean; // false when mode is embedding/image/etc.
  pricing: { inputPerToken: number; outputPerToken: number } | null;
  /** The catalogId this meta was resolved from, if any. */
  resolvedCatalogId: string | null;
}

const CONSERVATIVE_MAX_OUTPUT = 8192;

/**
 * Resolve full metadata for a model. Deterministic, no I/O.
 * Resolution order: catalogId → auto-match → conservative fallback.
 */
export function resolveModelMeta(model: ModelRef, catalog: CatalogMap): ModelMeta {
  let entry: CatalogEntry | null = null;

  // 1. Exact catalogId lookup.
  if (model.catalogId) {
    const direct = catalog.get(model.catalogId) ?? catalog.get(model.catalogId.toLowerCase());
    if (direct) entry = direct;
  }

  // 2. Auto-match by modelId (only confident single hits; ambiguous falls through).
  if (!entry) {
    const m = matchModelToCatalog(model.modelId, catalog);
    if (m.state === 'matched') entry = m.matches[0] ?? null;
  }

  // 3. Fallback: user-entered fields + conservative defaults.
  if (!entry) {
    return {
      contextWindow: model.contextWindow || 200000,
      maxOutputTokens: CONSERVATIVE_MAX_OUTPUT,
      supportsReasoning: false,
      supportsFunctionCalling: true, // assume capable; callers guard separately
      supportsPromptCaching: false,
      supportsVision: false,
      mode: 'chat',
      isValidForMainRole: true,
      pricing: null,
      resolvedCatalogId: null,
    };
  }

  const validForMain = entry.mode === 'chat' || entry.mode === 'completion';
  return {
    contextWindow: entry.maxInputTokens || model.contextWindow || 200000,
    maxOutputTokens: entry.maxOutputTokens || CONSERVATIVE_MAX_OUTPUT,
    supportsReasoning: entry.supportsReasoning,
    supportsFunctionCalling: entry.supportsFunctionCalling,
    supportsPromptCaching: entry.supportsPromptCaching,
    supportsVision: entry.supportsVision,
    mode: entry.mode,
    isValidForMainRole: validForMain,
    pricing: entry.inputCostPerToken || entry.outputCostPerToken
      ? { inputPerToken: entry.inputCostPerToken, outputPerToken: entry.outputCostPerToken }
      : null,
    resolvedCatalogId: entry.catalogId,
  };
}

/** Format pricing for display: "$3 / $15 per Mtok". Empty string if null. */
export function formatPriceRate(
  pricing: { inputPerToken: number; outputPerToken: number } | null,
): string {
  if (!pricing) return '';
  const fmt = (perToken: number) => {
    const perMtok = perToken * 1_000_000;
    return perMtok >= 1
      ? `$${perMtok.toFixed(perMtok % 1 === 0 ? 0 : 2)}`
      : `$${perMtok.toFixed(2)}`;
  };
  return `${fmt(pricing.inputPerToken)} / ${fmt(pricing.outputPerToken)} per Mtok`;
}
