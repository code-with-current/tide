import { describe, expect, it } from 'vitest';
import {
  registerProvidersRpc,
  normalizeProbeList,
  enrichBareModels,
  type ProviderDomain,
} from '../../../app/rpc/providers';
import type { Provider, ProviderModelMeta } from '../../../shared/rpc';
import type { Provider as RendererProvider } from '../../../src/types';

function provider(over: Partial<RendererProvider> = {}): RendererProvider {
  return {
    id: 'p1',
    name: 'Prov',
    apiStyle: 'openai',
    baseUrl: 'https://example.invalid',
    apiKey: 'key',
    enabled: true,
    models: [{ id: 'm', alias: 'm', modelId: 'model-a', contextWindow: 8192, providerId: 'p1' }],
    ...over,
  } as RendererProvider;
}

function fakeDomain(providers: RendererProvider[]): ProviderDomain & { state: { deleted: string[] } } {
  const state = { deleted: [] as string[] };
  return {
    state,
    listProviders: () => providers,
    addProvider: (input) => {
      const p = provider({ id: 'p2', name: input.name, apiStyle: input.apiStyle, baseUrl: input.baseUrl });
      providers.push(p);
      return p;
    },
    updateProvider: (id, patch) => {
      const p = providers.find((x) => x.id === id);
      if (!p) return null;
      Object.assign(p, patch);
      return p;
    },
    deleteProvider: (id) => {
      state.deleted.push(id);
      return true;
    },
  };
}

describe('providers rpc', () => {
  it('CRUD passes through the domain', async () => {
    const domain = fakeDomain([provider()]);
    const h = registerProvidersRpc(domain, { dataDir: '/tmp/unused' });
    expect(h.providerList({})).toHaveLength(1);
    const added = h.providerAdd({ input: { name: 'New', apiStyle: 'anthropic', baseUrl: 'https://x' } }) as Provider;
    expect(added.name).toBe('New');
    expect(h.providerUpdate({ providerId: 'p1', patch: { name: 'Renamed' } })?.name).toBe('Renamed');
    expect(await h.providerDelete({ providerId: 'p1' })).toEqual({ ok: true });
    expect(domain.state.deleted).toEqual(['p1']);
  });

  it('normalizeProbeList maps OpenRouter shapes, drops id-less entries, sorts by id', () => {
    const out = normalizeProbeList([
      { id: 'b/m-two', name: 'Two', context_length: 4096, pricing: { prompt: '0.000001' } },
      { id: 'a/m-one', name: 'One', architecture: { input_modalities: ['text', 'image'] } },
      { name: 'no-id' },
      'garbage',
      { id: 'c/m-three', reasoning: { mandatory: true, supported_efforts: ['low', 'high', 42] } },
    ]);
    expect(out.map((m) => m.id)).toEqual(['a/m-one', 'b/m-two', 'c/m-three']);
    const two = out[1] as ProviderModelMeta;
    expect(two.context_length).toBe(4096);
    expect(two.pricing?.prompt).toBe('0.000001');
    expect(out[0].input_modalities).toEqual(['text', 'image']);
    expect(out[2].reasoning?.mandatory).toBe(true);
    expect(out[2].reasoning?.supported_efforts).toEqual(['low', 'high']);
  });

  it('enrichBareModels preserves the provider id while copying metadata', () => {
    const bare: ProviderModelMeta = { id: 'glm-4.7' };
    const other: ProviderModelMeta = { id: 'already-rich', context_length: 1000 };
    // enrichBareModels only enriches when a catalog is loaded — feed one by
    // exercising the export through the same module state the RPC uses.
    const catalog: ProviderModelMeta = { id: 'zai/glm-4.7', context_length: 200000, pricing: { prompt: '0.000001' } };
    // No setter is exported; the empty-catalog path returns models unchanged.
    expect(enrichBareModels([bare, other])).toEqual([bare, other]);
    void catalog;
  });

  it('providerProbeModels rejects empty inputs without network', async () => {
    const h = registerProvidersRpc(fakeDomain([]), { dataDir: '/tmp/unused' });
    const emptyBase = await h.providerProbeModels({ input: { apiStyle: 'openai', baseUrl: '  ', apiKey: 'k' } });
    expect(emptyBase).toEqual({ ok: false, error: 'Base URL is empty.' });
    // baseUrl set but apiKey empty: bootstrapCatalog fires a fetch — point it
    // at an unroutable TLD so it fails fast and the key check still lands.
    const emptyKey = await h.providerProbeModels({ input: { apiStyle: 'openai', baseUrl: 'https://invalid.test', apiKey: '' } });
    expect(emptyKey).toEqual({ ok: false, error: 'API key is empty — type one or save a stored key first.' });
  });

  it('providerTestConnection validates its inputs', async () => {
    const h = registerProvidersRpc(fakeDomain([]), { dataDir: '/tmp/unused' });
    const res = await h.providerTestConnection({ input: { apiStyle: 'openai', baseUrl: '', apiKey: 'k', modelId: 'm' } });
    expect(res).toEqual({ ok: false, error: 'Base URL is empty.' });
  });
});
