import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, getPreset, filterPresetModels } from '../provider-presets';

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

describe('filterPresetModels (OpenCode Zen routing)', () => {
  const zen = getPreset('opencode')!;
  const ids = (models: { modelId: string }[]) => models.map((m) => m.modelId);

  it('anthropic style keeps only /messages models', () => {
    const out = filterPresetModels(
      [
        { modelId: 'claude-sonnet-4-6' },
        { modelId: 'qwen3.6-plus' },
        { modelId: 'glm-5.2' },
        { modelId: 'x-preview-f-free' },
        { modelId: 'gpt-5.5' },
      ],
      zen,
      'anthropic',
    );
    expect(ids(out)).toEqual(['claude-sonnet-4-6', 'qwen3.6-plus']);
  });

  it('openai style keeps chat/completions models, hides Responses-only ones', () => {
    const out = filterPresetModels(
      [
        { modelId: 'glm-5.2' },
        { modelId: 'kimi-k2.7-code' },
        { modelId: 'deepseek-v4-flash' },
        { modelId: 'x-preview-f-free' },
        { modelId: 'gpt-5.5' },
        { modelId: 'grok-4.6' },
        { modelId: 'claude-sonnet-4-6' },
      ],
      zen,
      'openai',
    );
    expect(ids(out)).toEqual(['glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-flash', 'x-preview-f-free']);
  });

  it('presets without routing pass everything through', () => {
    const out = filterPresetModels([{ modelId: 'anything' }], getPreset('openrouter'), 'openai');
    expect(ids(out)).toEqual(['anything']);
  });
});
