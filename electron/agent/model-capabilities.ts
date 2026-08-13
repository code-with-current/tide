/** Model capability resolution — reads directly from the provider-config Model entry, falling back to the models.dev catalog when the entry lacks a field. No heuristic prefix tables. */
import type { Model } from '../../src/types/index.js';
import { resolveModelMeta } from './model-catalog.js';
import type { CatalogMap, ModelRef } from './model-catalog.js';
import { createModelPricesLoader } from './model-prices.js';
import type { LoaderConfig } from './model-prices.js';
import { createLogger } from '../logger.js';

const log = createLogger('model-catalog');

// The loaded models.dev catalog — used for enrichment when the provider config
// lacks a field (context window, max output, reasoning, …). null until
// initModelCatalog() runs at app start.
let activeCatalog: CatalogMap | null = null;
let loader: ReturnType<typeof createModelPricesLoader> | null = null;

/** Inject the loaded catalog so capability lookups can fall back to it. */
export function setCatalog(map: CatalogMap | null) {
  activeCatalog = map;
}

/** The currently loaded catalog map (null if not yet initialized). */
export function getActiveCatalog(): CatalogMap | null {
  return activeCatalog;
}

/** Load the models.dev catalog once at app start, inject it via setCatalog,
 *  and refresh it in the background when stale. Never throws — on any failure
 *  activeCatalog stays null and capability lookups fall back to provider config
 *  + conservative defaults. */
export async function initModelCatalog(config: LoaderConfig): Promise<void> {
  if (loader) return; // idempotent
  loader = createModelPricesLoader(config);
  try {
    const { entries, version } = await loader.load();
    setCatalog(entries.size ? entries : null);
    log.info('catalog loaded', { count: entries.size, fetchedAt: version?.fetchedAt ?? 'unknown' });
    if (loader.isStale()) {
      void loader.refresh().then((fresh) => {
        if (fresh && fresh.entries.size) {
          setCatalog(fresh.entries);
          log.info('catalog refreshed', { count: fresh.entries.size });
        }
      });
    }
  } catch (e) {
    log.warn('catalog load failed', { err: e instanceof Error ? e.message : String(e) });
  }
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

/** Max input tokens the provider accepts. Most providers set this equal to
 *  the context window, but some (Google, etc.) cap input below context − output.
 *  Falls back to contextWindowSize when the provider doesn't specify it. */
export function resolveMaxInputTokens(modelId: string, modelEntry?: Model): number | undefined {
  if (modelEntry?.maxInputTokens) return modelEntry.maxInputTokens;
  if (activeCatalog) {
    const ref: ModelRef = { modelId, contextWindow: 0 };
    const meta = resolveModelMeta(ref, activeCatalog);
    if (meta.resolvedCatalogId) return meta.maxInputTokens;
  }
  return contextWindowSize(modelId, modelEntry);
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

/** Enrich a provider-config model with authoritative values from the catalog.
 *  One-time migration: sets catalogId + fills contextWindow, max output,
 *  maxInputTokens, reasoning, and pricing from the catalog when the stored
 *  entry lacks them. Returns null (no change) when the model already has a
 *  catalogId (already enriched — preserves user edits) or doesn't match. */
export function enrichModelFromCatalog(model: Model, catalog: CatalogMap): Model | null {
  if (model.catalogId) return null;

  const meta = resolveModelMeta(
    { modelId: model.modelId, contextWindow: model.contextWindow },
    catalog,
  );
  if (!meta.resolvedCatalogId) return null;

  return {
    ...model,
    catalogId: meta.resolvedCatalogId,
    contextWindow: meta.contextWindow,
    max_completion_tokens: model.max_completion_tokens ?? meta.maxOutputTokens,
    maxInputTokens: model.maxInputTokens ?? meta.maxInputTokens,
    reasoning: model.reasoning ?? meta.supportsReasoning,
    inputCostPerToken: model.inputCostPerToken ?? meta.pricing?.inputPerToken,
    outputCostPerToken: model.outputCostPerToken ?? meta.pricing?.outputPerToken,
  };
}

// Re-export for callers that want full metadata.
export { resolveModelMeta, formatPriceRate } from './model-catalog.js';
export type { ModelMeta } from './model-catalog.js';
