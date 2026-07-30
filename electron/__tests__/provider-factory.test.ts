import { describe, it, expect } from 'vitest';
import { resolveModel } from '../agent/provider-factory.js';
import type { Provider, Model } from '../../src/types';

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p_test',
    name: 'Test Provider',
    apiStyle: 'anthropic',
    baseUrl: 'https://api.test.com',
    apiKey: 'sk-test-key',
    enabled: true,
    models: [],
    ...overrides,
  };
}

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'm_test',
    alias: 'Test',
    modelId: 'test-model-1',
    contextWindow: 200_000,
    providerId: 'p_test',
    ...overrides,
  };
}

describe('resolveModel', () => {
  it('resolves an anthropic-shape provider to a LanguageModel', () => {
    const provider = makeProvider({ apiStyle: 'anthropic' });
    const model = resolveModel(provider, makeModel());
    // LanguageModel is a union; verify it's truthy and carries the modelId.
    expect(model).toBeTruthy();
    expect((model as { modelId: string }).modelId).toBe('test-model-1');
  });

  it('resolves an openai-shape provider to a LanguageModel', () => {
    const provider = makeProvider({ apiStyle: 'openai' });
    const model = resolveModel(provider, makeModel());
    expect(model).toBeTruthy();
    expect((model as { modelId: string }).modelId).toBe('test-model-1');
  });

  it('passes the modelId through to the underlying provider', () => {
    const provider = makeProvider({ apiStyle: 'anthropic' });
    const model = resolveModel(provider, makeModel({ modelId: 'claude-sonnet-4-5' }));
    // The SDK stamps modelId on the returned object.
    expect((model as any).modelId).toBe('claude-sonnet-4-5');
  });

  it('throws on unknown apiStyle', () => {
    const provider = makeProvider({ apiStyle: 'unknown' as any });
    expect(() => resolveModel(provider, makeModel())).toThrow(/apiStyle/);
  });

  it('handles empty baseUrl for anthropic (SDK falls back to default)', () => {
    const provider = makeProvider({ apiStyle: 'anthropic', baseUrl: '' });
    expect(() => resolveModel(provider, makeModel())).not.toThrow();
  });

  it('handles missing apiKey gracefully (SDK validates later)', () => {
    const provider = makeProvider({ apiStyle: 'anthropic', apiKey: undefined });
    expect(() => resolveModel(provider, makeModel())).not.toThrow();
  });
});
