import { describe, it, expect } from 'vitest';
import { matchModelToCatalog, resolveModelMeta, formatPriceRate } from '../../app/core/agent/model-catalog.js';
import type { CatalogEntry } from '../../app/core/agent/model-prices.js';

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

const FIXTURE = new Map<string, CatalogEntry>([
  ['anthropic/claude-sonnet-4-5', entry('anthropic/claude-sonnet-4-5', { supportsReasoning: true, maxOutputTokens: 16000 })],
  ['anthropic/claude-sonnet-4-20250514', entry('anthropic/claude-sonnet-4-20250514', { supportsReasoning: true })],
  ['bedrock/anthropic.claude-sonnet-4-5', entry('bedrock/anthropic.claude-sonnet-4-5')],
  ['openai/gpt-5', entry('openai/gpt-5', { inputCostPerToken: 1.25e-6, outputCostPerToken: 10e-6, maxOutputTokens: 128000 })],
  ['amazon.titan-embed-text-v1', entry('amazon.titan-embed-text-v1', { mode: 'embedding', inputCostPerToken: 1e-7 })],
]);

describe('matchModelToCatalog', () => {
  it('exact key match returns single confident match', () => {
    const r = matchModelToCatalog('anthropic/claude-sonnet-4-5', FIXTURE);
    expect(r.state).toBe('matched');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].catalogId).toBe('anthropic/claude-sonnet-4-5');
  });

  it('suffix match: provider modelId matches the part after /', () => {
    const r = matchModelToCatalog('claude-sonnet-4-5', FIXTURE);
    expect(r.state).toBe('matched');
    expect(r.matches[0].catalogId).toBe('anthropic/claude-sonnet-4-5');
  });

  it('disambiguates identical-price cross-provider collisions to matched', () => {
    // 'claude-sonnet-4' hits several entries, but they share pricing/context
    // (or one is a bare canonical key), so the matcher collapses to matched.
    const r = matchModelToCatalog('claude-sonnet-4', FIXTURE);
    expect(r.state).toBe('matched');
    expect(r.matches).toHaveLength(1);
  });

  it('ambiguous: conflicting prices across providers stay ambiguous', () => {
    // Two keys with the SAME suffix but DIFFERENT pricing — genuinely
    // ambiguous, the user must pick. This is the step-2 ambiguity branch
    // that survives disambiguation.
    const conflictFixture = new Map<string, CatalogEntry>([
      ['anthropic/claude-haiku-4', entry('anthropic/claude-haiku-4', { inputCostPerToken: 1e-6 })],
      ['openai/claude-haiku-4', entry('openai/claude-haiku-4', { inputCostPerToken: 5e-6 })],
    ]);
    const r = matchModelToCatalog('claude-haiku-4', conflictFixture);
    expect(r.state).toBe('ambiguous');
    expect(r.matches).toHaveLength(2);
  });

  it('disambiguates to the bare canonical key when present', () => {
    // A bare key (no '/') is the model's home entry and wins even if other
    // routes have slightly different metadata.
    const bareFixture = new Map<string, CatalogEntry>([
      ['gpt-5', entry('gpt-5', { inputCostPerToken: 1.25e-6 })],
      ['openai/gpt-5', entry('openai/gpt-5', { inputCostPerToken: 1.25e-6 })],
      ['azure/gpt-5', entry('azure/gpt-5', { inputCostPerToken: 2e-6 })],
    ]);
    const r = matchModelToCatalog('gpt-5', bareFixture);
    expect(r.state).toBe('matched');
    expect(r.matches[0].catalogId).toBe('gpt-5');
  });

  it('no match for an unknown modelId', () => {
    const r = matchModelToCatalog('acme-corp-ft-v2', FIXTURE);
    expect(r.state).toBe('none');
    expect(r.matches).toHaveLength(0);
  });

  it('normalizes case and trims whitespace', () => {
    const r = matchModelToCatalog('  Claude-Sonnet-4-5  ', FIXTURE);
    expect(r.state).toBe('matched');
  });
});

describe('resolveModelMeta', () => {
  const model = (over: Partial<{ catalogId: string; modelId: string; contextWindow: number }> = {}) => ({
    catalogId: over.catalogId,
    modelId: over.modelId ?? 'claude-sonnet-4-5',
    contextWindow: over.contextWindow ?? 100000,
  });

  it('uses catalogId when present (exact, O(1))', () => {
    const meta = resolveModelMeta(model({ catalogId: 'openai/gpt-5' }), FIXTURE);
    expect(meta.maxOutputTokens).toBe(128000);
    expect(meta.supportsReasoning).toBe(false);
    expect(meta.contextWindow).toBe(200000);
    expect(meta.pricing?.inputPerToken).toBe(1.25e-6);
  });

  it('auto-matches by modelId when no catalogId', () => {
    const meta = resolveModelMeta(model({ modelId: 'claude-sonnet-4-5', catalogId: undefined }), FIXTURE);
    expect(meta.contextWindow).toBe(200000);
    expect(meta.supportsReasoning).toBe(true);
  });

  it('falls back to model fields + conservative defaults when no match', () => {
    const meta = resolveModelMeta(model({ modelId: 'unknown-model', contextWindow: 50000 }), FIXTURE);
    expect(meta.contextWindow).toBe(50000);
    expect(meta.maxOutputTokens).toBe(8192);
    expect(meta.supportsReasoning).toBe(false);
    expect(meta.pricing).toBeNull();
  });

  it('embedding mode flagged so callers can guard main-role use', () => {
    const meta = resolveModelMeta(model({ catalogId: 'amazon.titan-embed-text-v1' }), FIXTURE);
    expect(meta.mode).toBe('embedding');
    expect(meta.isValidForMainRole).toBe(false);
  });
});

describe('formatPriceRate', () => {
  it('formats input/output per million tokens', () => {
    expect(formatPriceRate({ inputPerToken: 3e-6, outputPerToken: 15e-6 })).toBe('$3 / $15 per Mtok');
  });
  it('rounds to 2 decimals', () => {
    expect(formatPriceRate({ inputPerToken: 1.25e-6, outputPerToken: 10e-6 })).toBe('$1.25 / $10 per Mtok');
  });
  it('returns empty string for null pricing', () => {
    expect(formatPriceRate(null)).toBe('');
  });
});
