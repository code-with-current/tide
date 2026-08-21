import { describe, expect, it } from 'vitest';
import {
  canAdvance, initialWizardState, uniqueName, wizardReducer,
} from '../wizard-reducer';
import { getPreset } from '@/lib/provider-presets';
import type { FetchedModel } from '@/lib/fetch-models';

const m = (modelId: string): FetchedModel => ({ modelId, matchState: 'none' });

describe('uniqueName', () => {
  it('passes through unseen names and suffixes collisions', () => {
    expect(uniqueName('OpenRouter', [])).toBe('OpenRouter');
    expect(uniqueName('OpenRouter', ['OpenRouter'])).toBe('OpenRouter 2');
    expect(uniqueName('OpenRouter', ['OpenRouter', 'OpenRouter 2'])).toBe('OpenRouter 3');
  });
});

describe('select-preset', () => {
  it('seeds the draft and jumps to connect', () => {
    const s = wizardReducer(initialWizardState, {
      type: 'select-preset', preset: getPreset('openrouter')!, existingNames: [],
    });
    expect(s.step).toBe('connect');
    expect(s.presetId).toBe('openrouter');
    expect(s.apiStyle).toBe('openai');
    expect(s.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(s.name).toBe('OpenRouter');
  });

  it('suffixes the name when the preset is already added', () => {
    const s = wizardReducer(initialWizardState, {
      type: 'select-preset', preset: getPreset('openrouter')!, existingNames: ['OpenRouter'],
    });
    expect(s.name).toBe('OpenRouter 2');
  });
});

describe('models-loaded', () => {
  it('preselects recommended models case-insensitively', () => {
    const s = wizardReducer(
      { ...initialWizardState, presetId: 'openrouter' },
      {
        type: 'models-loaded',
        models: [m('anthropic/claude-sonnet-4-5'), m('meta-llama/llama-3.3-70b')],
        recommended: getPreset('openrouter')!.recommended,
      },
    );
    expect(s.selected).toEqual(['anthropic/claude-sonnet-4-5']);
  });

  it('selects nothing when preset has no recommendations', () => {
    const s = wizardReducer(initialWizardState, {
      type: 'models-loaded', models: [m('a'), m('b')], recommended: [],
    });
    expect(s.selected).toEqual([]);
  });
});

describe('toggle / select-all / select-none', () => {
  const loaded = wizardReducer(initialWizardState, {
    type: 'models-loaded', models: [m('a'), m('b')], recommended: [],
  });

  it('toggles', () => {
    const t = wizardReducer(wizardReducer(loaded, { type: 'toggle-model', modelId: 'a' }), {
      type: 'toggle-model', modelId: 'a',
    });
    expect(t.selected).toEqual([]);
  });

  it('select-all then select-none', () => {
    const all = wizardReducer(loaded, { type: 'select-all-models' });
    expect(all.selected).toEqual(['a', 'b']);
    expect(wizardReducer(all, { type: 'select-none-models' }).selected).toEqual([]);
  });
});

describe('step navigation', () => {
  it('back/next walk the order and clamp at the ends', () => {
    let s = wizardReducer(initialWizardState, { type: 'next' });
    expect(s.step).toBe('connect');
    s = wizardReducer(s, { type: 'back' });
    expect(s.step).toBe('choose');
    s = wizardReducer(s, { type: 'back' });
    expect(s.step).toBe('choose');
  });
});

describe('canAdvance', () => {
  const base = { ...initialWizardState, step: 'connect' as const };

  it('connect requires baseUrl, key (when preset demands one), and a passed test', () => {
    expect(canAdvance({ ...base, baseUrl: '' }, { status: 'ok' }, true)).toBe(false);
    expect(canAdvance({ ...base, baseUrl: 'https://x', apiKey: '' }, { status: 'ok' }, true)).toBe(false);
    expect(canAdvance({ ...base, baseUrl: 'https://x', apiKey: 'k' }, { status: 'idle' }, true)).toBe(false);
    expect(canAdvance({ ...base, baseUrl: 'https://x', apiKey: 'k' }, { status: 'error' }, true)).toBe(false);
    expect(canAdvance({ ...base, baseUrl: 'https://x', apiKey: 'k' }, { status: 'ok' }, true)).toBe(true);
  });

  it('keyless presets pass without a key', () => {
    expect(
      canAdvance({ ...base, baseUrl: 'http://localhost:11434/v1', apiKey: '' }, { status: 'ok' }, false),
    ).toBe(true);
  });

  it('models step always advances (zero models is legal)', () => {
    expect(canAdvance({ ...initialWizardState, step: 'models' }, { status: 'idle' }, true)).toBe(true);
  });
});
