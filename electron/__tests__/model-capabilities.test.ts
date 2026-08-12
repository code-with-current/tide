import { describe, it, expect, beforeEach } from 'vitest';
import {
  supportsThinking,
  contextWindowSize,
  setCatalog,
  resolveMaxOutputTokens,
} from '../agent/model-capabilities.js';
import type { CatalogMap } from '../agent/model-catalog.js';
import type { CatalogEntry } from '../agent/model-prices.js';

function entry(id: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    catalogId: id,
    mode: 'chat',
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
        maxInputTokens: 500000,
      })],
    ]);
    setCatalog(catalog);
    expect(supportsThinking('future-model-x')).toBe(true);
    expect(contextWindowSize('future-model-x')).toBe(500000);
  });

  it('returns defaults for model not in catalog (no heuristic fallback)', () => {
    const catalog: CatalogMap = new Map([['anthropic/claude-sonnet-4-5', entry('anthropic/claude-sonnet-4-5')]]);
    setCatalog(catalog);
    // glm-5 is not in this catalog, and there are no heuristic prefixes.
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
