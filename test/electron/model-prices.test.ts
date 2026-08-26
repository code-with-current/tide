import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// We test against a synthetic in-memory catalog by injecting fixture data
// into a temp cache dir, rather than depending on the real vendored file.
// Fixtures use the slim models.dev shape the loader consumes.

const BUNDLED = {
  fetchedAt: '2026-01-01T00:00:00Z',
  source: 'test',
  count: 2,
  models: {
    'anthropic/claude-opus-4-7': {
      reasoning: true,
      tool_call: true,
      attachment: true,
      limit: { context: 1000000, output: 128000 },
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    },
    'openai/gpt-5.5': {
      reasoning: true,
      tool_call: true,
      attachment: true,
      // input capped below context (Google/OpenAI-style three-limit model).
      limit: { context: 1050000, input: 922000, output: 128000 },
      cost: { input: 5, output: 30 },
    },
  },
};

describe('model-prices loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-catalog-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads the bundled catalog', async () => {
    const { createModelPricesLoader } = await import('../../app/core/agent/model-prices.js');
    const loader = createModelPricesLoader({ bundled: BUNDLED, cacheDir: tmpDir });
    const catalog = await loader.load();
    expect(catalog.entries.has('anthropic/claude-opus-4-7')).toBe(true);
    expect(catalog.version?.count).toBe(2);
  });

  it('normalizes raw models.dev entries into CatalogEntry shape (per-Mtok → per-token)', async () => {
    const { createModelPricesLoader } = await import('../../app/core/agent/model-prices.js');
    const loader = createModelPricesLoader({ bundled: BUNDLED, cacheDir: tmpDir });
    const catalog = await loader.load();
    const e = catalog.entries.get('anthropic/claude-opus-4-7')!;
    expect(e).toEqual({
      catalogId: 'anthropic/claude-opus-4-7',
      mode: 'chat',
      contextWindow: 1000000,
      maxInputTokens: 1000000,
      maxOutputTokens: 128000,
      inputCostPerToken: 5e-6,
      outputCostPerToken: 25e-6,
      cacheReadInputTokenCost: 5e-7,
      cacheCreationInputTokenCost: 6.25e-6,
      supportsReasoning: true,
      supportsFunctionCalling: true,
      supportsVision: true,
      supportsPromptCaching: true,
    });
  });

  it('preserves the separate context/input ceilings when limit.input is present', async () => {
    const { createModelPricesLoader } = await import('../../app/core/agent/model-prices.js');
    const loader = createModelPricesLoader({ bundled: BUNDLED, cacheDir: tmpDir });
    const catalog = await loader.load();
    const e = catalog.entries.get('openai/gpt-5.5')!;
    expect(e.contextWindow).toBe(1050000);
    expect(e.maxInputTokens).toBe(922000); // capped below context
    expect(e.maxOutputTokens).toBe(128000);
  });

  it('prefers a newer cached copy over the bundled one', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'model-prices.json'),
      JSON.stringify({
        fetchedAt: '2026-06-01T00:00:00Z',
        source: 'test',
        count: 1,
        models: {
          'openai/gpt-5.5': { tool_call: true, limit: { context: 300000, output: 8000 } },
        },
      }),
    );
    const { createModelPricesLoader } = await import('../../app/core/agent/model-prices.js');
    const loader = createModelPricesLoader({ bundled: BUNDLED, cacheDir: tmpDir });
    const catalog = await loader.load();
    expect(catalog.entries.has('anthropic/claude-opus-4-7')).toBe(false);
    expect(catalog.entries.get('openai/gpt-5.5')!.contextWindow).toBe(300000);
  });

  it('falls back to bundled when cache is older than bundled', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'model-prices.json'),
      JSON.stringify({
        fetchedAt: '2025-01-01T00:00:00Z',
        source: 'test',
        count: 1,
        models: { 'stale-only': { limit: { context: 1000 } } },
      }),
    );
    const { createModelPricesLoader } = await import('../../app/core/agent/model-prices.js');
    const loader = createModelPricesLoader({ bundled: BUNDLED, cacheDir: tmpDir });
    const catalog = await loader.load();
    expect(catalog.entries.has('anthropic/claude-opus-4-7')).toBe(true);
  });

  it('returns an empty catalog when both sources are missing', async () => {
    const { createModelPricesLoader } = await import('../../app/core/agent/model-prices.js');
    const loader = createModelPricesLoader({ bundled: null, cacheDir: tmpDir });
    const catalog = await loader.load();
    expect(catalog.entries.size).toBe(0);
  });

  it('isStale is true for a bundled baseline older than the refresh interval', async () => {
    const { createModelPricesLoader } = await import('../../app/core/agent/model-prices.js');
    const loader = createModelPricesLoader({ bundled: BUNDLED, cacheDir: tmpDir });
    await loader.load();
    // BUNDLED.fetchedAt is 2026-01-01 — well over 7 days ago relative to now.
    expect(loader.isStale()).toBe(true);
  });
});
