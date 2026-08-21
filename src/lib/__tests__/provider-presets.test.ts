import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, getPreset } from '../provider-presets';

const VALID_STYLES = ['openai', 'anthropic'];

describe('PROVIDER_PRESETS', () => {
  it('has unique ids', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every preset has a valid apiStyle, baseUrl, and accent', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(VALID_STYLES).toContain(p.apiStyle);
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.accent).toMatch(/^#/);
    }
  });

  it('keyed presets carry keyUrl and keyPlaceholder; local ones do not', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.requiresKey) {
        expect(p.keyUrl).toBeDefined();
        expect(p.keyPlaceholder).toBeDefined();
      } else {
        expect(p.group).toBe('local');
        expect(p.baseUrl).toContain('localhost');
      }
    }
  });

  it('getPreset finds by id and misses gracefully', () => {
    expect(getPreset('openrouter')?.name).toBe('OpenRouter');
    expect(getPreset('nope')).toBeUndefined();
  });
});
