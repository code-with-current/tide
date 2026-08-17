import { describe, it, expect } from 'vitest';
import { resolveReasoning, budgetToEffort } from '../agent/protocols/reasoning.js';
import type { ReasoningOption } from '../../src/types/index.js';

describe('resolveReasoning', () => {
  it('returns null for thinkingLevel "off"', () => {
    expect(resolveReasoning('off', [], 'openai', 8192)).toBeNull();
  });

  it('emits explicit reasoning_effort=none when the model publishes "none"', () => {
    const contracts: ReasoningOption[] = [
      { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
    ];
    // OpenAI protocol: 'none' is a real effort value — send it instead of
    // omitting the param (omission leaves the provider default active).
    const result = resolveReasoning('off', contracts, 'openai', 8192);
    expect(result?.contract).toBe('effort');
    expect(result?.effort).toBe('none');
    // Anthropic protocol: 'none' is OpenAI vocabulary → plain disable.
    expect(resolveReasoning('off', contracts, 'anthropic', 8192)).toBeNull();
    // No 'none' published → plain disable everywhere.
    expect(resolveReasoning('off', [{ type: 'effort', values: ['low', 'medium'] }], 'openai', 8192)).toBeNull();
  });

  it('supports the minimal tier end to end', () => {
    const contracts: ReasoningOption[] = [
      { type: 'effort', values: ['minimal', 'low', 'medium', 'high'] },
    ];
    expect(resolveReasoning('minimal', contracts, 'openai', 8192)?.effort).toBe('minimal');
    // Legacy budget map (no contracts) gets a minimal entry below low.
    expect(resolveReasoning('minimal', undefined, 'anthropic', 8192)?.budgetTokens).toBe(512);
    // minimal on a high/max-only model snaps up to the lowest offered.
    expect(resolveReasoning('minimal', [{ type: 'effort', values: ['high', 'max'] }], 'openai', 8192)?.effort).toBe('high');
  });

  it('falls back to legacy budget map when no contracts', () => {
    const result = resolveReasoning('high', undefined, 'anthropic', 8192);
    expect(result?.contract).toBe('budget_tokens');
    expect(result?.budgetTokens).toBe(24_000); // legacy map value
  });

  it('sends effort string directly for OpenAI + effort contract (no precision loss)', () => {
    const contracts: ReasoningOption[] = [
      { type: 'effort', values: ['low', 'medium', 'high'] },
    ];
    const result = resolveReasoning('low', contracts, 'openai', 8192);
    expect(result?.contract).toBe('effort');
    expect(result?.effort).toBe('low');

    const high = resolveReasoning('high', contracts, 'openai', 8192);
    expect(high?.effort).toBe('high');
  });

  it('snaps to supported effort values for GLM-5.2 (high/max only)', () => {
    const contracts: ReasoningOption[] = [
      { type: 'effort', values: ['high', 'max'] },
    ];
    // 'low' snaps to 'high' (lowest available)
    expect(resolveReasoning('low', contracts, 'openai', 8192)?.effort).toBe('high');
    // 'high' maps directly
    expect(resolveReasoning('high', contracts, 'openai', 8192)?.effort).toBe('high');
    // 'max' maps directly
    expect(resolveReasoning('max', contracts, 'openai', 8192)?.effort).toBe('max');
    // 'extra' snaps to 'max'
    expect(resolveReasoning('extra', contracts, 'openai', 8192)?.effort).toBe('max');
  });

  it('computes budget_tokens for Anthropic + budget contract', () => {
    const contracts: ReasoningOption[] = [
      { type: 'budget_tokens', min: 1024 },
    ];
    const result = resolveReasoning('high', contracts, 'anthropic', 128_000);
    expect(result?.contract).toBe('budget_tokens');
    expect(result?.budgetTokens).toBe(102_400); // 128000 * 0.8
  });

  it('clamps budget so response always gets ≥1024 tokens', () => {
    const contracts: ReasoningOption[] = [
      { type: 'budget_tokens', min: 1024 },
    ];
    // max level on small output (2000): raw = 2000*0.95 = 1900
    // ceiling = max(2000-1024, 1024) = max(976, 1024) = 1024
    // result = min(max(1900, 1024), 1024) = min(1900, 1024) = 1024
    const result = resolveReasoning('max', contracts, 'anthropic', 2000);
    expect(result?.budgetTokens).toBe(1024);
    expect(result?.budgetTokens!).toBeLessThan(2000);
  });

  it('uses adaptive thinking for Anthropic + effort contract', () => {
    const contracts: ReasoningOption[] = [
      { type: 'effort', values: ['low', 'medium', 'high'] },
    ];
    const result = resolveReasoning('high', contracts, 'anthropic', 8192);
    expect(result?.contract).toBe('effort');
    expect(result?.effort).toBe('high');
  });

  it('derives effort from budget for OpenAI + budget contract (lossy)', () => {
    const contracts: ReasoningOption[] = [
      { type: 'budget_tokens', min: 1024 },
    ];
    const result = resolveReasoning('high', contracts, 'openai', 128_000);
    expect(result?.contract).toBe('effort');
    // budget = 128000 * 0.8 = 102400, effort derived from that
    expect(result?.effort).toBe('max'); // >= 48000 → max
  });

  it('handles toggle-only models', () => {
    const contracts: ReasoningOption[] = [{ type: 'toggle' }];
    const result = resolveReasoning('high', contracts, 'openai', 8192);
    expect(result?.contract).toBe('toggle');
  });

  it('handles models with both effort and budget contracts', () => {
    const contracts: ReasoningOption[] = [
      { type: 'effort', values: ['low', 'medium', 'high'] },
      { type: 'budget_tokens', min: 1024 },
    ];
    // OpenAI prefers effort
    expect(resolveReasoning('low', contracts, 'openai', 8192)?.contract).toBe('effort');
    // Anthropic prefers budget_tokens
    expect(resolveReasoning('low', contracts, 'anthropic', 8192)?.contract).toBe('budget_tokens');
  });
});

describe('budgetToEffort', () => {
  it('maps budget ranges to discrete effort levels', () => {
    expect(budgetToEffort(500)).toBe('low');
    expect(budgetToEffort(4_000)).toBe('low');
    expect(budgetToEffort(8_000)).toBe('medium');
    expect(budgetToEffort(20_000)).toBe('medium');
    expect(budgetToEffort(24_000)).toBe('high');
    expect(budgetToEffort(47_999)).toBe('high');
    expect(budgetToEffort(48_000)).toBe('max');
    expect(budgetToEffort(100_000)).toBe('max');
  });
});
