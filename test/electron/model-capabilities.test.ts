import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  supportsThinking,
  contextWindowSize,
  setCatalog,
  resolveMaxOutputTokens,
  clampOutputForContext,
  enrichModelFromCatalog,
} from '../../app/core/agent/model-capabilities.js';
import type { CatalogMap } from '../../app/core/agent/model-catalog.js';
import type { CatalogEntry } from '../../app/core/agent/model-prices.js';
import type { Model } from '../../src/types/index.js';

function entry(id: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    catalogId: id,
    mode: 'chat',
    contextWindow: 200000,
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
    inputCostPerToken: 3e-6,
    outputCostPerToken: 15e-6,
    cacheReadInputTokenCost: null,
    cacheCreationInputTokenCost: null,
    supportsReasoning: false,
    supportsFunctionCalling: true,
    supportsVision: false,
    supportsPromptCaching: false,
    ...over,
  };
}

describe('model-capabilities delegation', () => {
  // Reset to the no-catalog state before each test so ordering doesn't leak.
  beforeEach(() => setCatalog(null));

  it('returns defaults when no catalog is set (no heuristic prefix tables)', () => {
    // Heuristics were removed — without a catalog, reasoning defaults false
    // and context window is undefined.
    expect(supportsThinking('claude-sonnet-4-5')).toBe(false);
    expect(supportsThinking('some-unknown-model')).toBe(false);
    expect(contextWindowSize('claude-opus-4-1')).toBeUndefined();
    expect(contextWindowSize('some-unknown-model')).toBeUndefined();
  });

  it('uses catalog value when a match resolves', () => {
    const catalog: CatalogMap = new Map([
      // A model that the heuristic would call NON-reasoning (no prefix match),
      // but the catalog marks reasoning=true. Catalog must win.
      ['acme/future-model-x', entry('acme/future-model-x', {
        supportsReasoning: true,
        contextWindow: 500000,
      })],
    ]);
    setCatalog(catalog);
    expect(supportsThinking('future-model-x')).toBe(true);
    expect(contextWindowSize('future-model-x')).toBe(500000);
  });

  it('returns defaults for model not in catalog (no heuristic fallback)', () => {
    const catalog: CatalogMap = new Map([['anthropic/claude-sonnet-4-5', entry('anthropic/claude-sonnet-4-5')]]);
    setCatalog(catalog);
    expect(supportsThinking('glm-5-air')).toBe(false);
    expect(contextWindowSize('glm-5-air')).toBeUndefined();
  });

  it('does not return catalog conservative-defaults for an unmatched model', () => {
    // When the catalog is set but the modelId doesn't match anything, the
    // resolver would return a 200000 contextWindow conservative default —
    // but model-capabilities must NOT surface that (it must return undefined
    // so callers fall back to the user-entered contextWindow). This test locks
    // that the resolvedCatalogId null-check guard works.
    const catalog: CatalogMap = new Map([['anthropic/claude-sonnet-4-5', entry('anthropic/claude-sonnet-4-5')]]);
    setCatalog(catalog);
    expect(contextWindowSize('totally-unknown-model')).toBeUndefined();
  });
});

describe('resolveMaxOutputTokens', () => {
  beforeEach(() => setCatalog(null));

  it('returns conservative 8192 when no catalog is loaded', () => {
    expect(resolveMaxOutputTokens('claude-sonnet-4-5')).toBe(8192);
  });

  it('returns the catalog maxOutputTokens for a matched model', () => {
    const catalog: CatalogMap = new Map([
      ['anthropic/claude-sonnet-4-5', entry('anthropic/claude-sonnet-4-5', { maxOutputTokens: 64000 })],
    ]);
    setCatalog(catalog);
    expect(resolveMaxOutputTokens('claude-sonnet-4-5')).toBe(64000);
  });

  it('returns conservative 8192 for an unmatched model even with catalog loaded', () => {
    const catalog: CatalogMap = new Map([
      ['anthropic/claude-sonnet-4-5', entry('anthropic/claude-sonnet-4-5', { maxOutputTokens: 64000 })],
    ]);
    setCatalog(catalog);
    expect(resolveMaxOutputTokens('unknown-private-model')).toBe(8192);
  });
});

describe('enrichModelFromCatalog', () => {
  const catalog: CatalogMap = new Map([
    ['zai-org/glm-5.2', entry('zai-org/glm-5.2', {
      contextWindow: 1048576,
      maxInputTokens: 1048576,
      maxOutputTokens: 131072,
      supportsReasoning: true,
    })],
  ]);

  function model(over: Partial<Model> = {}): Model {
    return {
      id: 'm_1',
      alias: 'GLM-5.2',
      modelId: 'glm-5.2',
      contextWindow: 200000,
      providerId: 'p_1',
      ...over,
    };
  }

  it('enriches contextWindow, max output, reasoning + sets catalogId', () => {
    const result = enrichModelFromCatalog(model(), catalog);
    expect(result).not.toBeNull();
    expect(result!.catalogId).toBe('zai-org/glm-5.2');
    expect(result!.contextWindow).toBe(1048576);
    expect(result!.max_completion_tokens).toBe(131072);
    expect(result!.maxInputTokens).toBe(1048576);
    expect(result!.reasoning).toBe(true);
  });

  it('skips models that already have a catalogId (idempotency)', () => {
    const result = enrichModelFromCatalog(model({ catalogId: 'zai-org/glm-5.2' }), catalog);
    expect(result).toBeNull();
  });

  it('returns null for models not in the catalog', () => {
    const result = enrichModelFromCatalog(model({ modelId: 'totally-unknown' }), catalog);
    expect(result).toBeNull();
  });

  it('preserves user-set fields (does not overwrite)', () => {
    const result = enrichModelFromCatalog(
      model({ max_completion_tokens: 65536, reasoning: false }),
      catalog,
    );
    expect(result!.max_completion_tokens).toBe(65536);
    expect(result!.reasoning).toBe(false);
    // contextWindow is always authoritative from catalog (the whole point)
    expect(result!.contextWindow).toBe(1048576);
  });
});

describe('refreshModelCatalog', () => {
  // initModelCatalog/refreshModelCatalog hold module-level state (loader +
  // once-per-session refresh guard), so this suite uses a single it() block.
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-catalog-refresh-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('no-ops before init, then fetches, injects, caches, and runs once per session', async () => {
    const { initModelCatalog, refreshModelCatalog } = await import('../../app/core/agent/model-capabilities.js');

    // Before initModelCatalog the loader is null — refresh must resolve false,
    // not throw, and must not consume the once-per-session guard.
    expect(await refreshModelCatalog()).toBe(false);

    // models.dev-shaped payload: one provider with >100 models (the loader's
    // sanity floor) so the refresh isn't rejected as a tiny payload.
    const models: Record<string, { limit?: { context?: number } }> = {};
    for (let i = 0; i < 150; i++) models[`model-${i}`] = { limit: { context: 1000 + i } };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ acme: { models } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await initModelCatalog({ bundled: null, cacheDir: tmpDir });
    expect(contextWindowSize('model-42')).toBeUndefined(); // nothing loaded yet

    // First call performs the fetch, injects entries, and writes the cache.
    expect(await refreshModelCatalog()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(contextWindowSize('model-42')).toBe(1042);

    // Second call in the same session is a no-op — no extra fetch.
    expect(await refreshModelCatalog()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The refreshed catalog was persisted for the next boot.
    const cached = JSON.parse(fs.readFileSync(path.join(tmpDir, 'model-prices.json'), 'utf8'));
    expect(cached.count).toBe(150);
  });
});

describe('clampOutputForContext', () => {
  it('passes through output limits that already leave input headroom', () => {
    expect(clampOutputForContext(8192, 128000)).toBe(8192);
    expect(clampOutputForContext(65536, 200000)).toBe(65536);
  });

  it('clamps output == context to half the window (input + max_tokens must fit)', () => {
    expect(clampOutputForContext(128000, 128000)).toBe(64000);
    expect(clampOutputForContext(262144, 262144)).toBe(131072);
  });

  it('keeps a sane floor when the context window is tiny', () => {
    expect(clampOutputForContext(128000, 6000)).toBeGreaterThanOrEqual(4096);
  });

  it('returns the limit unchanged when the context window is unknown', () => {
    expect(clampOutputForContext(128000, 0)).toBe(128000);
    expect(clampOutputForContext(128000, undefined)).toBe(128000);
  });
});
