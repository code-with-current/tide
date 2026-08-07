/** Model capability resolution — reads directly from the provider-config Model entry. No heuristic prefix tables. */
import type { Model } from '../../src/types/index.js';
import { resolveModelMeta } from './model-catalog.js';
import type { CatalogMap, ModelRef } from './model-catalog.js';

// Catalog still used for enrichment when the provider config lacks fields.
let activeCatalog: CatalogMap | null = null;

/** Inject the loaded catalog so capability lookups can fall back to it. */
export function setCatalog(map: CatalogMap | null) {
  activeCatalog = map;
}

/** Does this model support extended thinking / reasoning? Reads `model.reasoning` from provider config; falls back to catalog; defaults false. */
export function supportsThinking(modelId: string, modelEntry?: Model): boolean {
  if (modelEntry?.reasoning !== undefined) return modelEntry.reasoning;
  if (activeCatalog) {
    const ref: ModelRef = { modelId, contextWindow: 0 };
    const meta = resolveModelMeta(ref, activeCatalog);
    if (meta.resolvedCatalogId) return meta.supportsReasoning;
  }
  return false;
}

/** Context window size from provider config (`model.contextWindow`); falls back to catalog; undefined when unknown. */
export function contextWindowSize(modelId: string, modelEntry?: Model): number | undefined {
  if (modelEntry?.contextWindow) return modelEntry.contextWindow;
  if (activeCatalog) {
    const ref: ModelRef = { modelId, contextWindow: 0 };
    const meta = resolveModelMeta(ref, activeCatalog);
    if (meta.resolvedCatalogId) return meta.contextWindow;
  }
  return undefined;
}

/** Max output tokens from provider config (`model.max_completion_tokens`); falls back to catalog; defaults 8192. */
export function resolveMaxOutputTokens(modelId: string, modelEntry?: Model): number {
  if (modelEntry?.max_completion_tokens) return modelEntry.max_completion_tokens;
  if (activeCatalog) {
    const meta = resolveModelMeta({ modelId, contextWindow: 0 }, activeCatalog);
    if (meta.maxOutputTokens) return meta.maxOutputTokens;
  }
  return 8192;
}

// Re-export for callers that want full metadata.
export { resolveModelMeta, formatPriceRate } from './model-catalog.js';
export type { ModelMeta } from './model-catalog.js';
