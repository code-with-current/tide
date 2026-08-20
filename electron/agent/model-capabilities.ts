/** Model capability resolution — reads directly from the provider-config Model entry, falling back to the models.dev catalog when the entry lacks a field. No heuristic prefix tables. */
import type { Model, ReasoningOption } from '../../src/types/index.js';
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
let refreshInFlight: Promise<boolean> | null = null;
let refreshedThisSession = false;

/** Inject the loaded catalog so capability lookups can fall back to it. */
export function setCatalog(map: CatalogMap | null) {
  activeCatalog = map;
}

/** The currently loaded catalog map (null if not yet initialized). */
export function getActiveCatalog(): CatalogMap | null {
  return activeCatalog;
}

/** Load the models.dev catalog once at app start, inject it via setCatalog,
 *  and kick off a background refresh via refreshModelCatalog() when stale.
 *  Never throws — on any failure activeCatalog stays null and capability
 *  lookups fall back to provider config + conservative defaults. */
export async function initModelCatalog(config: LoaderConfig): Promise<void> {
  if (loader) return; // idempotent
  loader = createModelPricesLoader(config);
  try {
    const { entries, version } = await loader.load();
    setCatalog(entries.size ? entries : null);
    log.info('catalog loaded', { count: entries.size, fetchedAt: version?.fetchedAt ?? 'unknown' });
    // Boot-time fallback for the rare launch where the renderer never fires
    // the splash refresh; shares the dedupe with refreshModelCatalog().
    if (loader.isStale()) void refreshModelCatalog();
  } catch (e) {
    log.warn('catalog load failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/** Pull a fresh models.dev catalog and re-inject it. The splash screen fires
 *  this at every app open (tide:modelCatalog:refresh) so the fetch runs in the
 *  background while the user is still on splash. Deduped: concurrent callers
 *  join the in-flight fetch, and at most one refresh runs per session.
 *  Returns true when the catalog was replaced. */
export function refreshModelCatalog(): Promise<boolean> {
  // In-flight join must be checked before the session guard — a caller that
  // arrives mid-refresh (boot stale-refresh vs splash IPC race) gets the
  // pending result, not a false "already done".
  if (refreshInFlight) return refreshInFlight;
  if (refreshedThisSession) return Promise.resolve(false);
  const active = loader;
  if (!active) return Promise.resolve(false); // not initialized — boot init handles loading
  refreshedThisSession = true;
  refreshInFlight = (async () => {
    try {
      const fresh = await active.refresh();
      if (!fresh || !fresh.entries.size) return false;
      setCatalog(fresh.entries);
      log.info('catalog refreshed', { count: fresh.entries.size });
      try {
        await enrichExistingModels();
      } catch (e) {
        log.warn('post-refresh enrichment failed', { err: e instanceof Error ? e.message : String(e) });
      }
      return true;
    } catch (e) {
      log.warn('catalog refresh failed', { err: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
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

/** Does this model accept image input (vision)? Reads `model.vision` from
 *  provider config; falls back to catalog; defaults false. Drives the
 *  attachment fallback chain: vision models get images inlined, others get
 *  an MCP/read_media_file path hint. */
export function supportsVision(modelId: string, modelEntry?: Model): boolean {
  if (modelEntry?.vision !== undefined) return modelEntry.vision;
  if (activeCatalog) {
    const ref: ModelRef = { modelId, contextWindow: 0 };
    const meta = resolveModelMeta(ref, activeCatalog);
    if (meta.resolvedCatalogId) return meta.supportsVision;
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
    vision: model.vision ?? meta.supportsVision,
    inputCostPerToken: model.inputCostPerToken ?? meta.pricing?.inputPerToken,
    outputCostPerToken: model.outputCostPerToken ?? meta.pricing?.outputPerToken,
    reasoningContracts: meta.reasoningOptions as ReasoningOption[] | undefined,
  };
}

/** One-time migration: enrich existing provider-config models with
 *  authoritative contextWindow, max output, reasoning, and pricing from the
 *  models.dev catalog. Runs after initModelCatalog() at boot and after every
 *  successful catalog refresh. Idempotent — models with a catalogId are
 *  skipped, so user edits are preserved. Store is imported dynamically to
 *  keep electron out of this module's static import graph (tests). */
export async function enrichExistingModels(): Promise<void> {
  const catalog = getActiveCatalog();
  if (!catalog || catalog.size === 0) return;
  const { listProviders, updateProvider } = await import('../store.js');
  let enriched = 0;
  for (const p of listProviders()) {
    let changed = false;
    const models = p.models.map((m) => {
      const e = enrichModelFromCatalog(m, catalog);
      if (e) { changed = true; enriched++; return e; }
      return m;
    });
    if (changed) updateProvider(p.id, { models });
  }
  if (enriched > 0) log.info('enriched models from catalog', { count: enriched });
}

// Re-export for callers that want full metadata.
export { resolveModelMeta, formatPriceRate } from './model-catalog.js';
export type { ModelMeta } from './model-catalog.js';

/** Resolve the reasoning contracts for a model. Reads `model.reasoningContracts`
 *  (populated during catalog enrichment); falls back to catalog lookup when
 *  the entry lacks the field (e.g. pre-enrichment or manual entry). Returns
 *  undefined when no contracts are available — callers fall back to the
 *  legacy fixed budget map in that case. */
export function resolveReasoningContracts(
  modelId: string,
  modelEntry?: Model,
): ReasoningOption[] | undefined {
  if (modelEntry?.reasoningContracts) return modelEntry.reasoningContracts;
  if (activeCatalog) {
    const meta = resolveModelMeta({ modelId, contextWindow: 0 }, activeCatalog);
    if (meta.resolvedCatalogId && meta.reasoningOptions) {
      return meta.reasoningOptions as ReasoningOption[];
    }
  }
  return undefined;
}
