import type { ApiStyle, ProviderModelMeta } from '@/types';
import { formatPriceRate } from '@/lib/model-catalog';

export type MatchState = 'live' | 'none';

export interface FetchedModel {
  modelId: string;
  matchState: MatchState;
  catalogId?: string;
  contextWindow?: number;
  priceLabel?: string;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadCostPerToken?: number;
  cacheWriteCostPerToken?: number;
  reasoning?: boolean;
  reasoningMandatory?: boolean;
  supportedEfforts?: string[];
  supportsVision?: boolean;
  maxOutputTokens?: number;
}

export function isRichProviderModel(m: ProviderModelMeta): boolean {
  return !!(
    m.context_length || m.pricing || m.reasoning ||
    m.max_completion_tokens || m.input_modalities
  );
}

export function liveToFetchedModel(m: ProviderModelMeta): FetchedModel {
  const num = (v?: string) => {
    const n = v != null ? parseFloat(v) : NaN;
    return Number.isNaN(n) ? undefined : n;
  };
  const inTok = num(m.pricing?.prompt);
  const outTok = num(m.pricing?.completion);
  return {
    modelId: m.id,
    matchState: 'live',
    catalogId: m.id,
    contextWindow: m.context_length,
    priceLabel:
      inTok != null && outTok != null
        ? formatPriceRate({ inputPerToken: inTok, outputPerToken: outTok })
        : undefined,
    inputCostPerToken: inTok,
    outputCostPerToken: outTok,
    cacheReadCostPerToken: num(m.pricing?.input_cache_read),
    cacheWriteCostPerToken: num(m.pricing?.input_cache_write),
    reasoning: m.reasoning?.default_enabled ?? m.reasoning?.mandatory ?? undefined,
    reasoningMandatory: m.reasoning?.mandatory,
    supportedEfforts: m.reasoning?.supported_efforts,
    supportsVision: m.input_modalities?.includes('image'),
    maxOutputTokens: m.max_completion_tokens,
  };
}

export type ProbeFn = (i: { apiStyle: ApiStyle; baseUrl: string; apiKey: string }) =>
  Promise<{ ok: true; models: ProviderModelMeta[] } | { ok: false; error: string }>;

export interface ResolveMeta {
  resolvedCatalogId?: string;
  contextWindow?: number;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  pricing?: { inputPerToken: number; outputPerToken: number };
}

export type ResolveFn = (i: { modelId: string; contextWindow: number }) =>
  Promise<{ meta?: ResolveMeta } | null | undefined>;

/** Adapts a raw catalog resolver (IPC shape: nulls for "absent") to ResolveFn (optional fields). */
export function toResolveFn(
  resolve: (i: { modelId: string; contextWindow: number }) => Promise<{
    meta?: {
      resolvedCatalogId?: string | null;
      contextWindow?: number;
      supportsReasoning?: boolean;
      supportsVision?: boolean;
      pricing?: { inputPerToken: number; outputPerToken: number } | null;
    };
  } | null | undefined>,
): ResolveFn {
  return async (input) => {
    const res = await resolve(input);
    const meta = res?.meta;
    return meta
      ? {
          meta: {
            resolvedCatalogId: meta.resolvedCatalogId ?? undefined,
            contextWindow: meta.contextWindow,
            supportsReasoning: meta.supportsReasoning,
            supportsVision: meta.supportsVision,
            pricing: meta.pricing ?? undefined,
          },
        }
      : null;
  };
}

export async function fetchAndEnrichModels(
  probe: ProbeFn,
  resolve: ResolveFn,
  input: { apiStyle: ApiStyle; baseUrl: string; apiKey: string; existingIds: string[] },
): Promise<FetchedModel[]> {
  const res = await probe(input);
  if (!res.ok) throw new Error(res.error);
  const existing = new Set(input.existingIds.map((id) => id.trim()));
  const probed = res.models.filter((m) => !existing.has(m.id.trim()));
  const live = probed.filter(isRichProviderModel).map(liveToFetchedModel);
  const bare = probed.filter((m) => !isRichProviderModel(m));
  const enriched = await Promise.all(
    bare.map(async (m): Promise<FetchedModel> => {
      const cat = await resolve({ modelId: m.id, contextWindow: 0 });
      const meta = cat?.meta;
      if (meta?.resolvedCatalogId) {
        return {
          modelId: m.id,
          matchState: 'none',
          catalogId: meta.resolvedCatalogId,
          contextWindow: meta.contextWindow,
          reasoning: meta.supportsReasoning,
          supportsVision: meta.supportsVision,
          priceLabel: meta.pricing ? formatPriceRate(meta.pricing) : undefined,
          inputCostPerToken: meta.pricing?.inputPerToken,
          outputCostPerToken: meta.pricing?.outputPerToken,
        };
      }
      return { modelId: m.id, matchState: 'none' };
    }),
  );
  return [...live, ...enriched];
}
