/** Providers RPC — port of the provider-domain channels from
 *  electron/ipc/handlers.ts (tide:listProviders / addProvider / updateProvider /
 *  deleteProvider, the /models probe, the OpenAI-vs-Anthropic protocol detect,
 *  the connection test, the models.dev catalog resolve/refresh, and the usage
 *  windows/report metering). The OpenRouter enrichment catalog
 *  (fetch + disk cache + 7-day refresh) moves here unchanged. The store
 *  surface is injectable so tests run against temp state. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';
import { providerWindowUsage, FIVE_HOUR_MS, WEEK_MS } from '../core/agent/usage-windows.js';
import { providerUsageReport } from '../core/agent/provider-usage.js';
import { resolveModelMeta, matchModelToCatalog } from '../core/agent/model-catalog.js';
import { getActiveCatalog, refreshModelCatalog } from '../core/agent/model-capabilities.js';
import type {
  ApiStyle,
  ModelCatalogResolveInput,
  ModelCatalogResolveResult,
  Provider,
  ProviderDetectResult,
  ProviderModelMeta,
  ProviderProbeInput,
  ProviderProbeResult,
  ProviderTestInput,
  ProviderTestResult,
} from '../../shared/rpc';
import type { Provider as RendererProvider } from '../../src/types';

const log = createLogger('providers-rpc');

// ── OpenRouter model catalog ──────────────────────────────────────
// OpenRouter /models is the universal metadata source: fetched at boot, cached
// to userData, refreshed every 7 days. Bare-id providers (z.ai, OpenAI direct,
// LM Studio) are enriched by matching against this catalog so they get real
// pricing/context/reasoning.
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OR_CACHE_FILE = 'openrouter-models.json';
const OR_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let orCatalog: ProviderModelMeta[] | null = null;
let orBooted: Promise<void> | null = null;

/** Test seam: swap the cache dir + reset the booted state. */
export function _setOrCacheDirForTests(dir: string | null): void {
  cacheDirOverride = dir;
  orBooted = null;
  orCatalog = null;
}

let cacheDirOverride: string | null = null;

function orCachePath(dataDir: string): string {
  return path.join(cacheDirOverride ?? dataDir, OR_CACHE_FILE);
}

/** Fetch + normalize the OpenRouter catalog. Cached to disk; refreshed when
 *  stale. Never throws — returns [] on any failure. */
export function bootstrapCatalog(dataDir: string): Promise<void> {
  if (orBooted) return orBooted;
  orBooted = (async () => {
    try {
      const cached = await fs.promises.readFile(orCachePath(dataDir), 'utf8');
      const parsed = JSON.parse(cached) as { data: unknown[]; fetchedAt?: string };
      if (parsed?.data && Array.isArray(parsed.data)) {
        orCatalog = normalizeProbeList(parsed.data);
        const age = parsed.fetchedAt ? Date.now() - Date.parse(parsed.fetchedAt) : Infinity;
        if (age < OR_REFRESH_MS) {
          log.info('or-catalog loaded from cache', { count: orCatalog.length });
          return;
        }
      }
    } catch { /* no cache — fetch fresh */ }

    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      log.warn('or-catalog fetch failed', { status: res.status });
      return;
    }
    const json = (await res.json()) as { data?: unknown[] };
    if (!json.data || !Array.isArray(json.data)) {
      log.warn('or-catalog unexpected response shape');
      return;
    }
    orCatalog = normalizeProbeList(json.data);
    try {
      await fs.promises.writeFile(
        orCachePath(dataDir),
        JSON.stringify({ data: json.data, fetchedAt: new Date().toISOString() }),
        'utf8',
      );
    } catch { /* cache write failed — non-fatal */ }
    log.info('or-catalog fetched from OpenRouter', { count: orCatalog.length });
  })().catch((e) => { log.warn('or-catalog bootstrap failed', { err: e?.message ?? e }); });
  return orBooted;
}

/** Enrich a bare model id from the OpenRouter catalog (pricing/context/
 *  reasoning); matches by exact id, then by the tail after the last '/'. */
function enrichFromOrCatalog(modelId: string): ProviderModelMeta | null {
  if (!orCatalog) return null;
  const lower = modelId.trim().toLowerCase();
  let hit = orCatalog.find((m) => m.id.toLowerCase() === lower);
  if (!hit) {
    hit = orCatalog.find((m) => {
      const tail = m.id.toLowerCase().slice(m.id.lastIndexOf('/') + 1);
      return tail === lower;
    });
  }
  return hit ?? null;
}

/** True when a provider model entry carries rich metadata beyond a bare id. */
function isRichProviderModel(m: ProviderModelMeta): boolean {
  return !!(m.context_length || m.pricing || m.reasoning || m.max_completion_tokens || m.input_modalities);
}

/** Enrich bare-id models from the OpenRouter catalog, CRITICAL: preserving the
 *  provider's original id (only metadata fields are copied). */
export function enrichBareModels(models: ProviderModelMeta[]): ProviderModelMeta[] {
  if (!orCatalog || orCatalog.length === 0) return models;
  return models.map((m) => {
    if (isRichProviderModel(m)) return m;
    const enriched = enrichFromOrCatalog(m.id);
    if (!enriched) return m;
    return { ...enriched, id: m.id };
  });
}

/** Normalize a raw /models response array into ProviderModelMeta objects,
 *  handling both rich and bare-id shapes defensively; drops id-less entries
 *  and sorts by id. */
export function normalizeProbeList(raw: unknown[]): ProviderModelMeta[] {
  const out: ProviderModelMeta[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m.id === 'string' ? m.id : undefined;
    if (!id) continue;
    const tp = m.top_provider as Record<string, unknown> | undefined;
    const arch = m.architecture as Record<string, unknown> | undefined;
    const reasoning = m.reasoning as Record<string, unknown> | undefined;
    const pricing = m.pricing as Record<string, unknown> | undefined;
    const supportedEfforts = Array.isArray(reasoning?.supported_efforts)
      ? (reasoning!.supported_efforts as string[]).filter((e) => typeof e === 'string')
      : undefined;
    out.push({
      id,
      name: typeof m.name === 'string' ? m.name : undefined,
      context_length: typeof m.context_length === 'number' ? m.context_length : undefined,
      max_completion_tokens:
        typeof m.max_completion_tokens === 'number'
          ? m.max_completion_tokens
          : typeof tp?.max_completion_tokens === 'number'
            ? tp.max_completion_tokens
            : undefined,
      pricing:
        pricing && (typeof pricing.prompt === 'string' || typeof pricing.completion === 'string')
          ? {
              prompt: typeof pricing.prompt === 'string' ? pricing.prompt : undefined,
              completion: typeof pricing.completion === 'string' ? pricing.completion : undefined,
              input_cache_read: typeof pricing.input_cache_read === 'string' ? pricing.input_cache_read : undefined,
              input_cache_write: typeof pricing.input_cache_write === 'string' ? pricing.input_cache_write : undefined,
            }
          : undefined,
      reasoning:
        reasoning && (typeof reasoning.mandatory === 'boolean' || typeof reasoning.default_enabled === 'boolean' || supportedEfforts)
          ? {
              mandatory: typeof reasoning.mandatory === 'boolean' ? reasoning.mandatory : undefined,
              default_enabled: typeof reasoning.default_enabled === 'boolean' ? reasoning.default_enabled : undefined,
              supported_efforts: supportedEfforts?.length ? supportedEfforts : undefined,
            }
          : undefined,
      supported_parameters: Array.isArray(m.supported_parameters)
        ? (m.supported_parameters as string[]).filter((p) => typeof p === 'string')
        : undefined,
      input_modalities: Array.isArray(arch?.input_modalities)
        ? (arch!.input_modalities as string[]).filter((x) => typeof x === 'string')
        : Array.isArray(m.input_modalities)
          ? (m.input_modalities as string[]).filter((x) => typeof x === 'string')
          : undefined,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The core-store surface the handlers touch. */
export interface ProviderDomain {
  listProviders(): RendererProvider[];
  addProvider(input: { name: string; apiStyle: ApiStyle; baseUrl: string; apiKey?: string; models?: { alias: string; modelId: string; contextWindow: number }[] }): RendererProvider;
  updateProvider(id: string, patch: Partial<RendererProvider>): RendererProvider | null;
  deleteProvider(id: string): boolean;
}

export interface ProvidersRpcOpts {
  /** Directory for the OpenRouter cache file (appDataDir in production). */
  dataDir: string;
}

export function registerProvidersRpc(domain: ProviderDomain, opts: ProvidersRpcOpts) {
  const dataDir = opts.dataDir;

  const probeModels = async (input: ProviderProbeInput): Promise<ProviderProbeResult> => {
    try {
      const { apiStyle, baseUrl, apiKey } = input;
      if (!baseUrl.trim()) return { ok: false, error: 'Base URL is empty.' };
      await bootstrapCatalog(dataDir);
      if (!apiKey.trim()) return { ok: false, error: 'API key is empty — type one or save a stored key first.' };
      const cleanBase = baseUrl.replace(/\/+$/, '');
      let url: string;
      if (apiStyle === 'openai') {
        url = `${cleanBase}/models`;
      } else {
        const hasVersion = /\/v\d+$/.test(cleanBase);
        url = hasVersion ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiStyle === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['authorization'] = `Bearer ${apiKey}`;
      }
      let res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok && apiStyle === 'openai' && !/\/v\d+$/.test(cleanBase)) {
        const v1 = await fetch(`${cleanBase}/v1/models`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (v1.ok) res = v1;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const body = await res.text().catch(() => '');
        try {
          const parsed = JSON.parse(body);
          if (parsed && (parsed.data || parsed.models)) {
            return { ok: true, models: enrichBareModels(normalizeProbeList(parsed.data ?? parsed.models ?? [])) };
          }
        } catch {
          /* not JSON — fall through to error */
        }
        return {
          ok: false,
          error: `Expected JSON but got ${contentType || 'unknown content type'}. Check the base URL — it may need a different path or the provider may not expose a models endpoint.`,
        };
      }
      const json = (await res.json()) as { data?: unknown[]; models?: unknown[] };
      const models = enrichBareModels(normalizeProbeList(json.data ?? json.models ?? []));
      return { ok: true, models };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  };

  return {
    providerList: (_: Record<string, never>) => domain.listProviders() as Provider[],

    providerAdd: ({ input }: { input: { name: string; apiStyle: ApiStyle; baseUrl: string; apiKey?: string; models?: { alias: string; modelId: string; contextWindow: number }[] } }) =>
      domain.addProvider(input) as Provider,

    providerUpdate: ({ providerId, patch }: { providerId: string; patch: Partial<Provider> }) =>
      domain.updateProvider(providerId, patch as Partial<RendererProvider>) as Provider | null,

    providerDelete: ({ providerId }: { providerId: string }) =>
      ({ ok: domain.deleteProvider(providerId) }),

    providerProbeModels: ({ input }: { input: ProviderProbeInput }) => probeModels(input),

    providerDetectProtocol: async ({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }): Promise<ProviderDetectResult> => {
      if (!baseUrl.trim() || !apiKey.trim()) return { error: 'Base URL and API key are required.' };
      const cleanBase = baseUrl.replace(/\/+$/, '');

      const candidates: Array<{ style: ApiStyle; url: string; headers: Record<string, string> }> = [];
      candidates.push({
        style: 'openai',
        url: `${cleanBase}/models`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      });
      const hasVersion = /\/v\d+$/.test(cleanBase);
      candidates.push({
        style: 'anthropic',
        url: hasVersion ? `${cleanBase}/models` : `${cleanBase}/v1/models`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });

      const probe = async (c: (typeof candidates)[0]): Promise<{ apiStyle: ApiStyle; models: ProviderModelMeta[] } | null> => {
        try {
          const res = await fetch(c.url, { method: 'GET', headers: c.headers, signal: AbortSignal.timeout(8_000) });
          if (!res.ok) return null;
          const ct = res.headers.get('content-type') ?? '';
          let parsed: Record<string, unknown>;
          if (ct.includes('application/json')) {
            parsed = (await res.json()) as Record<string, unknown>;
          } else {
            const text = await res.text().catch(() => '');
            parsed = JSON.parse(text); // throws if not JSON → null
          }
          const list = parsed?.data ?? parsed?.models;
          if (Array.isArray(list) && list.length > 0) {
            await bootstrapCatalog(dataDir);
            return { apiStyle: c.style, models: enrichBareModels(normalizeProbeList(list)) };
          }
          return null;
        } catch {
          return null;
        }
      };

      const results = await Promise.allSettled(candidates.map(probe));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) return r.value;
      }
      return { error: 'Could not detect API protocol — neither OpenAI nor Anthropic endpoint responded with a valid models list. Check the base URL and API key.' };
    },

    providerTestConnection: async ({ input }: { input: ProviderTestInput }): Promise<ProviderTestResult> => {
      try {
        const { apiStyle, baseUrl, apiKey, modelId } = input;
        if (!baseUrl.trim()) return { ok: false, error: 'Base URL is empty.' };
        if (!apiKey.trim()) return { ok: false, error: 'API key is empty.' };
        if (!modelId.trim()) return { ok: false, error: 'Model ID is empty.' };

        const cleanBase = baseUrl.replace(/\/+$/, '');
        const url = apiStyle === 'openai'
          ? `${cleanBase}/chat/completions`
          : /\/v\d+$/.test(cleanBase) ? `${cleanBase}/messages` : `${cleanBase}/v1/messages`;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (apiStyle === 'anthropic') {
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          headers['authorization'] = `Bearer ${apiKey}`;
        }

        const body = JSON.stringify({ model: modelId, max_tokens: 16, messages: [{ role: 'user', content: 'Say hello in one word.' }] });

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(20_000),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
        }
        return { ok: true };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
      }
    },

    modelCatalogResolve: ({ catalogId, modelId, contextWindow }: ModelCatalogResolveInput): ModelCatalogResolveResult => {
      const catalog = getActiveCatalog();
      if (!catalog) {
        return {
          meta: {
            contextWindow: contextWindow || 200000,
            maxInputTokens: contextWindow || 200000,
            maxOutputTokens: 8192,
            supportsReasoning: false,
            supportsFunctionCalling: true,
            supportsPromptCaching: false,
            supportsVision: false,
            mode: 'chat',
            isValidForMainRole: true,
            pricing: null,
            resolvedCatalogId: null,
          },
          match: { state: 'none' as const, matches: [] },
        };
      }
      const ref = { catalogId, modelId, contextWindow };
      return { meta: resolveModelMeta(ref, catalog), match: matchModelToCatalog(modelId, catalog) };
    },

    modelCatalogRefresh: (_: Record<string, never>) => {
      void refreshModelCatalog();
      return { ok: true };
    },

    providerUsageWindows: ({ providerId }: { providerId: string }) => ({
      fiveHour: providerWindowUsage(providerId, FIVE_HOUR_MS),
      weekly: providerWindowUsage(providerId, WEEK_MS),
    }),

    providerUsageReport: async ({ providerId }: { providerId: string }) => {
      const provider = domain.listProviders().find((p) => p.id === providerId);
      if (!provider) return null;
      return providerUsageReport(provider);
    },
  };
}
