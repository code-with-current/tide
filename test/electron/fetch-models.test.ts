import { describe, expect, it } from 'vitest';
import {
  fetchAndEnrichModels, isRichProviderModel, liveToFetchedModel,
  type ProbeFn, type ResolveFn,
} from '@/lib/fetch-models';

const okProbe = (models: any[]): ProbeFn => async () => ({ ok: true, models });
const failProbe: ProbeFn = async () => ({ ok: false, error: 'boom' });
const noResolve: ResolveFn = async () => null;

describe('isRichProviderModel', () => {
  it('rich when pricing or context present, bare otherwise', () => {
    expect(isRichProviderModel({ id: 'x', pricing: { prompt: '0.000003' } })).toBe(true);
    expect(isRichProviderModel({ id: 'x', context_length: 200000 })).toBe(true);
    expect(isRichProviderModel({ id: 'x' })).toBe(false);
  });
});

describe('liveToFetchedModel', () => {
  it('maps pricing strings to per-token numbers and a label', () => {
    const f = liveToFetchedModel({
      id: 'anthropic/claude-sonnet-4-5',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      reasoning: { default_enabled: true },
      input_modalities: ['text', 'image'],
    });
    expect(f.matchState).toBe('live');
    expect(f.catalogId).toBe('anthropic/claude-sonnet-4-5');
    expect(f.contextWindow).toBe(200000);
    expect(f.inputCostPerToken).toBe(0.000003);
    expect(f.outputCostPerToken).toBe(0.000015);
    expect(f.priceLabel).toBeTruthy();
    expect(f.reasoning).toBe(true);
    expect(f.supportsVision).toBe(true);
  });
});

describe('fetchAndEnrichModels', () => {
  it('splits live vs bare, enriches bare via resolver, filters existing ids', async () => {
    const resolve: ResolveFn = async () => ({
      meta: {
        resolvedCatalogId: 'openai/gpt-5',
        contextWindow: 400000,
        supportsReasoning: true,
        pricing: { inputPerToken: 1.25e-6, outputPerToken: 1e-5 },
      },
    });
    const out = await fetchAndEnrichModels(
      okProbe([
        { id: 'anthropic/claude-sonnet-4-5', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'gpt-5' },
        { id: 'already-here' },
      ]),
      resolve,
      { apiStyle: 'openai', baseUrl: 'https://x', apiKey: 'k', existingIds: ['already-here'] },
    );
    expect(out).toHaveLength(2);
    expect(out[0].matchState).toBe('live');
    expect(out[1].modelId).toBe('gpt-5');
    expect(out[1].catalogId).toBe('openai/gpt-5');
    expect(out[1].contextWindow).toBe(400000);
  });

  it('bare with no catalog match stays metadata-free', async () => {
    const out = await fetchAndEnrichModels(okProbe([{ id: 'mystery' }]), noResolve, {
      apiStyle: 'openai', baseUrl: 'https://x', apiKey: 'k', existingIds: [],
    });
    expect(out).toEqual([{ modelId: 'mystery', matchState: 'none' }]);
  });

  it('throws the probe error', async () => {
    await expect(
      fetchAndEnrichModels(failProbe, noResolve, {
        apiStyle: 'openai', baseUrl: 'https://x', apiKey: 'k', existingIds: [],
      }),
    ).rejects.toThrow('boom');
  });
});
