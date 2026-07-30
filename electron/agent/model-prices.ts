/**
 * LiteLLM model_prices_and_context_window.json catalog loader.
 *
 * Ships a vendored snapshot in electron/data/, refreshed in the background
 * from GitHub every 7 days with graceful fallback. Loaded once at app start;
 * the in-memory map is queried by model-catalog.ts's resolveModelMeta().
 *
 * Never imports anything renderer-side — pure main-process module.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/** Raw shape of one entry in the LiteLLM catalog JSON (only fields we use). */
export interface RawCatalogEntry {
  mode?: string;
  litellm_provider?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number; // legacy alias for max_output_tokens
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  supports_reasoning?: boolean;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_prompt_caching?: boolean;
  // Many other fields exist in the catalog; we deliberately ignore them.
  [key: string]: unknown;
}

/** Normalized entry after loading (only the Tier-1 fields we consume). */
export interface CatalogEntry {
  catalogId: string; // the canonical key, e.g. 'anthropic/claude-sonnet-4-5'
  mode: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  inputCostPerToken: number; // 0 if absent
  outputCostPerToken: number; // 0 if absent
  cacheReadInputTokenCost: number | null;
  cacheCreationInputTokenCost: number | null;
  supportsReasoning: boolean;
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsPromptCaching: boolean;
}

/** Version metadata from electron/data/model-prices-version.json. */
export interface CatalogVersion {
  fetchedAt: string;
  source: string;
  count: number;
}

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_FILENAME = 'model-prices.json';
const CACHE_VERSION_FILENAME = 'model-prices-version.json';
const CATALOG_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/litellm_internal_staging/model_prices_and_context_window.json';

/** Normalizes a raw catalog entry into the Tier-1 CatalogEntry shape. */
function normalizeEntry(catalogId: string, raw: RawCatalogEntry): CatalogEntry {
  return {
    catalogId,
    mode: raw.mode ?? 'chat',
    maxInputTokens: raw.max_input_tokens ?? 0,
    // max_output_tokens preferred; legacy max_tokens as fallback.
    maxOutputTokens: raw.max_output_tokens ?? raw.max_tokens ?? 0,
    inputCostPerToken: raw.input_cost_per_token ?? 0,
    outputCostPerToken: raw.output_cost_per_token ?? 0,
    cacheReadInputTokenCost: raw.cache_read_input_token_cost ?? null,
    cacheCreationInputTokenCost: raw.cache_creation_input_token_cost ?? null,
    supportsReasoning: raw.supports_reasoning ?? false,
    supportsFunctionCalling: raw.supports_function_calling ?? false,
    supportsVision: raw.supports_vision ?? false,
    supportsPromptCaching: raw.supports_prompt_caching ?? false,
  };
}

/** Parse + normalize raw JSON into the entries map. Strips sample_spec. */
function buildCatalog(raw: Record<string, RawCatalogEntry>): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>();
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'sample_spec') continue;
    if (!value || typeof value !== 'object') continue;
    entries.set(key, normalizeEntry(key, value));
  }
  return entries;
}

export interface LoadedCatalog {
  entries: Map<string, CatalogEntry>;
  version: CatalogVersion | null;
}

export interface LoaderPaths {
  bundledPath: string;
  bundledVersionPath: string;
  cacheDir: string;
}

export function createModelPricesLoader(paths: LoaderPaths) {
  let cached: LoadedCatalog | null = null;

  async function readWithVersion(
    dataPath: string,
    versionPath: string,
  ): Promise<{ catalog: LoadedCatalog; fetchedAt: number } | null> {
    if (!existsSync(dataPath)) return null;
    try {
      const raw = JSON.parse(await readFile(dataPath, 'utf8')) as Record<
        string,
        RawCatalogEntry
      >;
      let version: CatalogVersion | null = null;
      let fetchedAt = 0;
      if (existsSync(versionPath)) {
        try {
          version = JSON.parse(await readFile(versionPath, 'utf8')) as CatalogVersion;
          fetchedAt = Date.parse(version.fetchedAt) || 0;
        } catch {
          /* malformed version file — treat as age 0 */
        }
      }
      return { catalog: { entries: buildCatalog(raw), version }, fetchedAt };
    } catch {
      return null; // corrupt JSON — treat as absent
    }
  }

  async function load(): Promise<LoadedCatalog> {
    if (cached) return cached;

    const cacheDataPath = path.join(paths.cacheDir, CACHE_FILENAME);
    const cacheVersionPath = path.join(paths.cacheDir, CACHE_VERSION_FILENAME);

    const [cacheResult, bundledResult] = await Promise.all([
      readWithVersion(cacheDataPath, cacheVersionPath),
      readWithVersion(paths.bundledPath, paths.bundledVersionPath),
    ]);

    // Prefer whichever is newer. Bundled wins ties (reviewed baseline).
    let chosen: LoadedCatalog | null = null;
    if (cacheResult && bundledResult) {
      chosen = cacheResult.fetchedAt > bundledResult.fetchedAt
        ? cacheResult.catalog
        : bundledResult.catalog;
    } else {
      chosen = cacheResult?.catalog ?? bundledResult?.catalog ?? null;
    }

    cached = chosen ?? { entries: new Map(), version: null };
    return cached;
  }

  /** Background refresh from GitHub. Never throws — on failure, keeps the
   *  currently loaded catalog. Call this fire-and-forget after load(). */
  async function refresh(): Promise<void> {
    try {
      const res = await fetch(CATALOG_URL, { redirect: 'follow' });
      if (!res.ok) return;
      const text = await res.text();
      const parsed = JSON.parse(text) as Record<string, RawCatalogEntry>;
      const entries = buildCatalog(parsed);
      if (entries.size < 100) return; // sanity check — abort on tiny payload
      await mkdir(paths.cacheDir, { recursive: true });
      await writeFile(path.join(paths.cacheDir, CACHE_FILENAME), text, 'utf8');
      const version: CatalogVersion = {
        fetchedAt: new Date().toISOString(),
        source: CATALOG_URL,
        count: entries.size,
      };
      await writeFile(
        path.join(paths.cacheDir, CACHE_VERSION_FILENAME),
        JSON.stringify(version, null, 2) + '\n',
        'utf8',
      );
      cached = { entries, version };
    } catch {
      // Network failure, parse error, disk write error — all non-fatal.
    }
  }

  /** True when the loaded catalog is older than the refresh interval. */
  function isStale(): boolean {
    const at = cached?.version?.fetchedAt;
    if (!at) return true;
    return Date.now() - Date.parse(at) > REFRESH_INTERVAL_MS;
  }

  return { load, refresh, isStale };
}
