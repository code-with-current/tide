import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, getPreset, filterPresetModels, styleFlipPatch } from '../provider-presets';

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
        { modelId: 'mimo-v2.5-free' },
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

  it('free tier routes to openai style only (verified live)', () => {
    const out = filterPresetModels(
      [
        { modelId: 'hy3-free' },
        { modelId: 'nemotron-3.5-lightning-free' },
        { modelId: 'laguna-s-2.1-free' },
        { modelId: 'muse-spark-1.2-contributor-free' },
        { modelId: 'mimo-v2.5-free' },
      ],
      zen,
      'openai',
    );
    expect(ids(out)).toEqual(['hy3-free', 'nemotron-3.5-lightning-free', 'laguna-s-2.1-free', 'muse-spark-1.2-contributor-free', 'mimo-v2.5-free']);
  });

  it('presets without routing pass everything through', () => {
    const out = filterPresetModels([{ modelId: 'anything' }], getPreset('openrouter'), 'openai');
    expect(ids(out)).toEqual(['anything']);
  });
});

describe('styleFlipPatch', () => {
  const defaults = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
  } as const;

  it('z.ai flip swaps to the alt URL when the URL is untouched', () => {
    const zai = getPreset('zai')!;
    const patch = styleFlipPatch(zai.baseUrl, 'anthropic', 'openai', zai, defaults);
    expect(patch).toEqual({ apiStyle: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4' });
  });

  it('flip back returns the preset canonical URL', () => {
    const zai = getPreset('zai')!;
    const patch = styleFlipPatch('https://api.z.ai/api/paas/v4', 'openai', 'anthropic', zai, defaults);
    expect(patch).toEqual({ apiStyle: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic' });
  });

  it('same-URL presets (Zen) keep the URL — only the style changes', () => {
    const zen = getPreset('opencode')!;
    const patch = styleFlipPatch(zen.baseUrl, 'anthropic', 'openai', zen, defaults);
    expect(patch).toEqual({ apiStyle: 'openai', baseUrl: 'https://opencode.ai/zen/v1' });
  });

  it('never clobbers a user-customized URL', () => {
    const zai = getPreset('zai')!;
    const patch = styleFlipPatch('https://my-proxy.dev/zai', 'anthropic', 'openai', zai, defaults);
    expect(patch).toEqual({ apiStyle: 'openai' });
  });

  it('custom path follows the protocol defaults', () => {
    const patch = styleFlipPatch(defaults.openai, 'openai', 'anthropic', undefined, defaults);
    expect(patch).toEqual({ apiStyle: 'anthropic', baseUrl: 'https://api.anthropic.com' });
  });

  it('empty URL follows to the new canonical', () => {
    const patch = styleFlipPatch('  ', 'openai', 'anthropic', undefined, defaults);
    expect(patch).toEqual({ apiStyle: 'anthropic', baseUrl: 'https://api.anthropic.com' });
  });
});
