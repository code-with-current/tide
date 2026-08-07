/** Renderer-side model capability resolution — reads from provider config (ModelOption) + catalog fallback. No heuristic prefix tables. */
import { resolveModelMeta } from './model-catalog';
import type { CatalogMap, ModelRef } from './model-catalog';

let activeCatalog: CatalogMap | null = null;

export function setCatalog(map: CatalogMap | null) {
  activeCatalog = map;
}

interface ModelLike {
  contextWindow?: number;
  reasoning?: boolean;
}

/** Does this model support reasoning? Reads from the provider config entry; falls back to catalog; defaults false. */
export function supportsThinking(modelId: string, modelEntry?: ModelLike): boolean {
  if (modelEntry?.reasoning !== undefined) return modelEntry.reasoning;
  if (activeCatalog) {
    const ref: ModelRef = { modelId, contextWindow: 0 };
    const meta = resolveModelMeta(ref, activeCatalog);
    if (meta.resolvedCatalogId) return meta.supportsReasoning;
  }
  return false;
}

/** Context window from provider config entry; falls back to catalog; undefined when unknown. */
export function contextWindowSize(modelId: string, modelEntry?: ModelLike): number | undefined {
  if (modelEntry?.contextWindow) return modelEntry.contextWindow;
  if (activeCatalog) {
    const ref: ModelRef = { modelId, contextWindow: 0 };
    const meta = resolveModelMeta(ref, activeCatalog);
    if (meta.resolvedCatalogId) return meta.contextWindow;
  }
  return undefined;
}

// Re-export for callers that want full metadata.
export { resolveModelMeta, formatPriceRate } from './model-catalog';
export type { ModelMeta } from './model-catalog';
