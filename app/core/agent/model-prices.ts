/**
 * Model catalog loader. Source: models.dev (https://models.dev/api.json) — the
 * opencode catalog, no auth, regenerated from TOML on every contribution.
 * Loaded once at app start; the in-memory map is queried by model-catalog.ts's
 * resolveModelMeta() and injected into model-capabilities.ts via setCatalog().
 *
 * The on-disk shape (bundled + cache) is a slim flattened wrapper:
 *   { fetchedAt, source, count, models: { [catalogId]: RawCatalogEntry } }
 * The raw models.dev API is nested { provider: { models: { id: {...} } } } and
 * is flattened via flattenModelsDevApi() before it is written anywhere, so the
 * bundled baseline, the runtime cache, and the in-memory map all share one
 * uniform shape. Costs are stored per-million-token (models.dev units) in the
 * file and converted to per-token in normalizeEntry(). Pure main-process module.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const CATALOG_URL = 'https://models.dev/api.json';

/** One model as it appears in the flattened catalog file (only fields we use).
 *  Costs are per-million-token (models.dev native units). */
export interface RawCatalogEntry {
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[]; min?: number }>;
  tool_call?: boolean;
  attachment?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  [key: string]: unknown;
}

/** Flatten the nested models.dev API into a flat { catalogId: model } map,
 *  keeping only the slim fields we consume. Duplicate ids across providers
 *  collapse (last wins) — acceptable for a fallback catalog. Exported so the
 *  refresh path and the vendor script share one canonical flattening. */
export function flattenModelsDevApi(api: unknown): Record<string, RawCatalogEntry> {
  const out: Record<string, RawCatalogEntry> = {};
  if (!api || typeof api !== 'object') return out;
  for (const provider of Object.values(api as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object') continue;
    const models = (provider as { models?: Record<string, unknown> }).models;
    if (!models || typeof models !== 'object') continue;
    for (const [id, model] of Object.entries(models)) {
      if (!model || typeof model !== 'object') continue;
      const m = model as RawCatalogEntry;
      // Keep only the slim subset; drop description/name/release_date/etc.
      out[id] = {
        reasoning: m.reasoning,
        reasoning_options: m.reasoning_options,
        tool_call: m.tool_call,
        attachment: m.attachment,
        limit: m.limit,
        cost: m.cost,
      };
    }
  }
  return out;
}

/** Normalized entry after loading (only the fields we consume). */
export interface CatalogEntry {
  catalogId: string; // the canonical key, e.g. 'anthropic/claude-opus-4-7'
  mode: string;
  /** Total context window (limit.context). The model's full input capacity. */
  contextWindow: number;
  /** Max input tokens the provider accepts (limit.input ?? limit.context).
   *  Equals contextWindow for most providers; Google/OpenAI cap it lower. */
  maxInputTokens: number;
  /** Max output tokens the model can generate (limit.output). */
  maxOutputTokens: number;
  inputCostPerToken: number; // 0 if absent
  outputCostPerToken: number; // 0 if absent
  cacheReadInputTokenCost: number | null;
  cacheCreationInputTokenCost: number | null;
  supportsReasoning: boolean;
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsPromptCaching: boolean;
  /** Reasoning contracts from models.dev (effort / budget_tokens / toggle).
   *  Undefined when the catalog entry has no reasoning_options. */
  reasoningOptions?: Array<{ type: string; values?: string[]; min?: number }>;
}

/** Version metadata embedded at the top of the catalog file. */
export interface CatalogVersion {
  fetchedAt: string;
  source: string;
  count: number;
}

/** On-disk catalog file shape (bundled baseline + runtime cache). */
export interface CatalogFile {
  fetchedAt: string;
  source: string;
  count: number;
  models: Record<string, RawCatalogEntry>;
}

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_FILENAME = 'model-prices.json';

/** Convert models.dev per-Mtok cost to per-token. */
function perToken(perMtok: number | undefined): number {
  return (perMtok ?? 0) / 1_000_000;
}

/** Normalizes a raw catalog entry into the CatalogEntry shape. */
function normalizeEntry(catalogId: string, raw: RawCatalogEntry): CatalogEntry {
  const limit = raw.limit ?? {};
  const cost = raw.cost ?? {};
  const context = limit.context ?? 0;
  const hasCache = cost.cache_read != null || cost.cache_write != null;
  return {
    catalogId,
    mode: 'chat',
    contextWindow: context,
    maxInputTokens: limit.input ?? context,
    maxOutputTokens: limit.output ?? 0,
    inputCostPerToken: perToken(cost.input),
    outputCostPerToken: perToken(cost.output),
    cacheReadInputTokenCost: cost.cache_read != null ? perToken(cost.cache_read) : null,
    cacheCreationInputTokenCost: cost.cache_write != null ? perToken(cost.cache_write) : null,
    supportsReasoning: raw.reasoning ?? false,
    supportsFunctionCalling: raw.tool_call ?? false,
    supportsVision: raw.attachment ?? false,
    supportsPromptCaching: hasCache,
    reasoningOptions: raw.reasoning_options,
  };
}

/** Parse + normalize the flattened model map into the entries map. */
function buildCatalog(raw: Record<string, RawCatalogEntry>): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>();
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    entries.set(key, normalizeEntry(key, value));
  }
  return entries;
}

export interface LoadedCatalog {
  entries: Map<string, CatalogEntry>;
  version: CatalogVersion | null;
}

export interface LoaderConfig {
  /** Inlined bundled baseline (imported JSON in main.ts). null in tests. */
  bundled: CatalogFile | null;
  /** Directory for the runtime cache file (appDataDir). */
  cacheDir: string;
}

export function createModelPricesLoader(config: LoaderConfig) {
  let cached: LoadedCatalog | null = null;

  /** Read the cache wrapper file. Returns null when absent or corrupt. */
  async function readCache(): Promise<LoadedCatalog | null> {
    const cachePath = path.join(config.cacheDir, CACHE_FILENAME);
    if (!existsSync(cachePath)) return null;
    try {
      const file = JSON.parse(await readFile(cachePath, 'utf8')) as CatalogFile;
      const version: CatalogVersion = {
        fetchedAt: file.fetchedAt,
        source: file.source,
        count: file.count,
      };
      return { entries: buildCatalog(file.models ?? {}), version };
    } catch {
      return null; // corrupt JSON — treat as absent
    }
  }

  /** Build a LoadedCatalog from the inlined bundled wrapper. */
  function fromBundled(): LoadedCatalog | null {
    if (!config.bundled) return null;
    return {
      entries: buildCatalog(config.bundled.models ?? {}),
      version: {
        fetchedAt: config.bundled.fetchedAt,
        source: config.bundled.source,
        count: config.bundled.count,
      },
    };
  }

  async function load(): Promise<LoadedCatalog> {
    if (cached) return cached;

    const [cacheResult, bundledResult] = await Promise.all([
      readCache(),
      Promise.resolve(fromBundled()),
    ]);

    // Prefer whichever is newer. Bundled wins ties (reviewed baseline).
    let chosen: LoadedCatalog | null = null;
    if (cacheResult && bundledResult) {
      chosen = Date.parse(cacheResult.version?.fetchedAt ?? '') >
        Date.parse(bundledResult.version?.fetchedAt ?? '')
        ? cacheResult
        : bundledResult;
    } else {
      chosen = cacheResult ?? bundledResult;
    }

    cached = chosen ?? { entries: new Map(), version: null };
    return cached;
  }

  /** Background refresh from models.dev. Never throws — on failure, keeps the
   *  currently loaded catalog. Call this fire-and-forget after load(). Returns
   *  the refreshed catalog (or null on failure) so callers can re-inject it. */
  async function refresh(): Promise<LoadedCatalog | null> {
    try {
      const res = await fetch(CATALOG_URL, { redirect: 'follow' });
      if (!res.ok) return null;
      const json = await res.json();
      const flat = flattenModelsDevApi(json);
      const entries = buildCatalog(flat);
      if (entries.size < 100) return null; // sanity check — abort on tiny payload
      const file: CatalogFile = {
        fetchedAt: new Date().toISOString(),
        source: CATALOG_URL,
        count: entries.size,
        models: flat,
      };
      await mkdir(config.cacheDir, { recursive: true });
      await writeFile(path.join(config.cacheDir, CACHE_FILENAME), JSON.stringify(file), 'utf8');
      cached = {
        entries,
        version: { fetchedAt: file.fetchedAt, source: file.source, count: file.count },
      };
      return cached;
    } catch {
      // Network failure, parse error, disk write error — all non-fatal.
      return null;
    }
  }

  /** True when the loaded catalog is older than the refresh interval. */
  function isStale(): boolean {
    const at = cached?.version?.fetchedAt;
    if (!at) return true;
    return Date.now() - Date.parse(at) > REFRESH_INTERVAL_MS;
  }

  /** The currently loaded catalog (loads lazily if not yet loaded). */
  async function getCatalog(): Promise<LoadedCatalog> {
    return load();
  }

  return { load, refresh, isStale, getCatalog };
}
