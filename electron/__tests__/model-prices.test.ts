import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// We test against a synthetic in-memory catalog by injecting fixture data
// into a temp userData dir, rather than depending on the real vendored file.
// This keeps the loader tests fast and deterministic.

const FIXTURE = {
  'sample_spec': { mode: 'chat' }, // must be stripped
  'anthropic/claude-sonnet-4-5': {
    mode: 'chat',
    litellm_provider: 'anthropic',
    max_input_tokens: 200000,
    max_output_tokens: 16000,
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    supports_reasoning: true,
    supports_function_calling: true,
    supports_vision: true,
    supports_prompt_caching: true,
  },
  'openai/gpt-5': {
    mode: 'chat',
    max_input_tokens: 200000,
    max_output_tokens: 128000,
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
    supports_function_calling: true,
  },
  'amazon.titan-embed-text-v1': {
    mode: 'embedding',
    max_input_tokens: 8192,
    input_cost_per_token: 1e-7,
    output_cost_per_token: 0,
    output_vector_size: 1536,
  },
};

describe('model-prices loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-catalog-'));
    fs.writeFileSync(
      path.join(tmpDir, 'bundled-model-prices.json'),
      JSON.stringify(FIXTURE),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'bundled-model-prices-version.json'),
      JSON.stringify({ fetchedAt: '2026-01-01T00:00:00Z', source: 'test', count: 4 }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads the bundled catalog and strips sample_spec', async () => {
    const { createModelPricesLoader } = await import('../agent/model-prices.js');
    const loader = createModelPricesLoader({
      bundledPath: path.join(tmpDir, 'bundled-model-prices.json'),
      bundledVersionPath: path.join(tmpDir, 'bundled-model-prices-version.json'),
      cacheDir: tmpDir,
    });
    const catalog = await loader.load();
    expect(catalog.entries.has('sample_spec')).toBe(false);
    expect(catalog.entries.has('anthropic/claude-sonnet-4-5')).toBe(true);
  });

  it('normalizes raw entries into CatalogEntry shape', async () => {
    const { createModelPricesLoader } = await import('../agent/model-prices.js');
    const loader = createModelPricesLoader({
      bundledPath: path.join(tmpDir, 'bundled-model-prices.json'),
      bundledVersionPath: path.join(tmpDir, 'bundled-model-prices-version.json'),
      cacheDir: tmpDir,
    });
    const catalog = await loader.load();
    const e = catalog.entries.get('anthropic/claude-sonnet-4-5')!;
    expect(e).toEqual({
      catalogId: 'anthropic/claude-sonnet-4-5',
      mode: 'chat',
      maxInputTokens: 200000,
      maxOutputTokens: 16000,
      inputCostPerToken: 3e-6,
      outputCostPerToken: 15e-6,
      cacheReadInputTokenCost: 3e-7,
      cacheCreationInputTokenCost: 3.75e-6,
      supportsReasoning: true,
      supportsFunctionCalling: true,
      supportsVision: true,
      supportsPromptCaching: true,
    });
  });

  it('prefers a newer cached copy over the bundled one', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'model-prices.json'),
      JSON.stringify({ 'openai/gpt-5': { mode: 'chat', max_input_tokens: 300000 } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'model-prices-version.json'),
      JSON.stringify({ fetchedAt: '2026-06-01T00:00:00Z', source: 'test', count: 1 }),
    );
    const { createModelPricesLoader } = await import('../agent/model-prices.js');
    const loader = createModelPricesLoader({
      bundledPath: path.join(tmpDir, 'bundled-model-prices.json'),
      bundledVersionPath: path.join(tmpDir, 'bundled-model-prices-version.json'),
      cacheDir: tmpDir,
    });
    const catalog = await loader.load();
    expect(catalog.entries.has('anthropic/claude-sonnet-4-5')).toBe(false);
    expect(catalog.entries.get('openai/gpt-5')!.maxInputTokens).toBe(300000);
  });

  it('falls back to bundled when cache is older than bundled', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'model-prices.json'),
      JSON.stringify({ 'stale-only': { mode: 'chat' } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'model-prices-version.json'),
      JSON.stringify({ fetchedAt: '2025-01-01T00:00:00Z', source: 'test', count: 1 }),
    );
    const { createModelPricesLoader } = await import('../agent/model-prices.js');
    const loader = createModelPricesLoader({
      bundledPath: path.join(tmpDir, 'bundled-model-prices.json'),
      bundledVersionPath: path.join(tmpDir, 'bundled-model-prices-version.json'),
      cacheDir: tmpDir,
    });
    const catalog = await loader.load();
    expect(catalog.entries.has('anthropic/claude-sonnet-4-5')).toBe(true);
  });

  it('returns an empty catalog when both sources are missing', async () => {
    const { createModelPricesLoader } = await import('../agent/model-prices.js');
    const loader = createModelPricesLoader({
      bundledPath: path.join(tmpDir, 'does-not-exist.json'),
      bundledVersionPath: path.join(tmpDir, 'does-not-exist-version.json'),
      cacheDir: tmpDir,
    });
    const catalog = await loader.load();
    expect(catalog.entries.size).toBe(0);
  });
});
