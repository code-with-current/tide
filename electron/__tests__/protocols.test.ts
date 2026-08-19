import { describe, it, expect } from 'vitest';
import { anthropicCallOptions } from '../agent/protocols/anthropic.js';
import { openaiCallOptions } from '../agent/protocols/openai.js';
import type { ReasoningInstruction } from '../agent/protocols/reasoning.js';

const budget = (tokens: number): ReasoningInstruction =>
  ({ contract: 'budget_tokens', budgetTokens: tokens, label: `budget=${tokens}` });

describe('anthropic protocol — thinking budget carving', () => {
  it('carves the budget out of maxBase so the wire total never exceeds it', () => {
    const maxBase = 131_072;
    const r = anthropicCallOptions(budget(121_600), { hasTools: true, modelId: 'glm-5.3', maxOutputTokens: maxBase });
    const sent = r.providerOptions?.anthropic as { thinking: { budgetTokens: number } };
    const out = r.maxOutputTokens ?? 0;
    expect(sent.thinking.budgetTokens).toBeLessThanOrEqual(Math.floor(maxBase * 0.8));
    expect(sent.thinking.budgetTokens + out).toBe(maxBase);
  });

  it('keeps at least 1024 output tokens at the highest level', () => {
    const r = anthropicCallOptions(budget(1_000_000), { hasTools: true, modelId: 'glm-5.3', maxOutputTokens: 131_072 });
    const sent = r.providerOptions?.anthropic as { thinking: { budgetTokens: number } };
    expect(sent.thinking.budgetTokens).toBe(Math.floor(131_072 * 0.8));
    expect(r.maxOutputTokens).toBe(131_072 - Math.floor(131_072 * 0.8));
  });

  it('sends thinking to z.ai (allowlisted) and strips it for OpenRouter', () => {
    const zai = anthropicCallOptions(budget(10_000), { hasTools: true, modelId: 'glm-5.3', maxOutputTokens: 131_072, providerBaseUrl: 'https://api.z.ai/api/anthropic' });
    expect((zai.providerOptions?.anthropic as { thinking?: unknown }).thinking).toBeDefined();

    const or = anthropicCallOptions(budget(10_000), { hasTools: true, modelId: 'glm-5.3', maxOutputTokens: 131_072, providerBaseUrl: 'https://openrouter.ai/api/v1' });
    expect((or.providerOptions?.anthropic as { thinking?: unknown } | undefined)?.thinking).toBeUndefined();
    expect(or.label).toContain('stripped');
  });

  it('carves the 1024 toggle budget too', () => {
    const r = anthropicCallOptions({ contract: 'toggle', label: 'on' }, { hasTools: true, modelId: 'glm-5.3', maxOutputTokens: 131_072 });
    expect(r.maxOutputTokens).toBe(131_072 - 1024);
  });
});

describe('openai protocol — effort clamping', () => {
  it("clamps 'max' (from a large budget) down to 'high'", () => {
    const r = openaiCallOptions(budget(60_000), { hasTools: true, modelId: 'glm-5.3', maxOutputTokens: 131_072 });
    expect((r.providerOptions?.openaiCompatible as { reasoningEffort: string }).reasoningEffort).toBe('high');
  });

  it('does not stack budget into maxOutputTokens for non-gemini models', () => {
    const r = openaiCallOptions(budget(60_000), { hasTools: true, modelId: 'glm-5.3', maxOutputTokens: 131_072 });
    expect(r.maxOutputTokens).toBe(131_072);
  });

  it('caps gemini-backed models at 65535', () => {
    const r = openaiCallOptions({ contract: 'effort', effort: 'high', label: 'high' }, { hasTools: false, modelId: 'gemini-2.5-pro', maxOutputTokens: 131_072 });
    expect(r.maxOutputTokens).toBe(65_535);
  });
});
