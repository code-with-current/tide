import type { ApiStyle } from '@/types';
import type { FetchedModel } from '@/lib/fetch-models';
import type { ProviderPreset } from '@/lib/provider-presets';

export type WizardStep = 'choose' | 'connect' | 'models' | 'review';

export interface WizardState {
  step: WizardStep;
  presetId: string | null;
  name: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
  models: FetchedModel[];
  selected: string[];
}

export const initialWizardState: WizardState = {
  step: 'choose',
  presetId: null,
  name: '',
  apiStyle: 'openai',
  baseUrl: '',
  apiKey: '',
  models: [],
  selected: [],
};

export interface TestStatus {
  status: 'idle' | 'running' | 'ok' | 'error';
  error?: string;
}

const STEP_ORDER: WizardStep[] = ['choose', 'connect', 'models', 'review'];

export function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export type WizardAction =
  | { type: 'select-preset'; preset: ProviderPreset; existingNames: string[] }
  | { type: 'select-custom'; apiStyle: ApiStyle }
  | { type: 'patch'; patch: Partial<Pick<WizardState, 'name' | 'apiStyle' | 'baseUrl' | 'apiKey'>> }
  | { type: 'models-loaded'; models: FetchedModel[]; recommended: string[] }
  | { type: 'toggle-model'; modelId: string }
  | { type: 'select-all-models' }
  | { type: 'select-none-models' }
  | { type: 'back' }
  | { type: 'next' };

export function wizardReducer(s: WizardState, a: WizardAction): WizardState {
  switch (a.type) {
    case 'select-preset':
      return {
        ...initialWizardState,
        step: 'connect',
        presetId: a.preset.id,
        name: uniqueName(a.preset.name, a.existingNames),
        apiStyle: a.preset.apiStyle,
        baseUrl: a.preset.baseUrl,
      };
    case 'select-custom':
      return { ...initialWizardState, step: 'connect', apiStyle: a.apiStyle };
    case 'patch':
      return { ...s, ...a.patch };
    case 'models-loaded': {
      const rs = a.recommended.map((r) => r.toLowerCase());
      const selected = a.models
        .filter((m) => rs.some((r) => m.modelId.toLowerCase().includes(r)))
        .map((m) => m.modelId);
      return { ...s, models: a.models, selected };
    }
    case 'toggle-model':
      return {
        ...s,
        selected: s.selected.includes(a.modelId)
          ? s.selected.filter((id) => id !== a.modelId)
          : [...s.selected, a.modelId],
      };
    case 'select-all-models':
      return { ...s, selected: s.models.map((m) => m.modelId) };
    case 'select-none-models':
      return { ...s, selected: [] };
    case 'back': {
      const i = STEP_ORDER.indexOf(s.step);
      return i <= 0 ? s : { ...s, step: STEP_ORDER[i - 1] };
    }
    case 'next': {
      const i = STEP_ORDER.indexOf(s.step);
      return i >= STEP_ORDER.length - 1 ? s : { ...s, step: STEP_ORDER[i + 1] };
    }
  }
}

export function canAdvance(
  s: Pick<WizardState, 'step' | 'baseUrl' | 'apiKey'>,
  test: TestStatus,
  requiresKey: boolean,
): boolean {
  if (s.step !== 'connect') return true;
  if (!s.baseUrl.trim()) return false;
  if (requiresKey && !s.apiKey.trim()) return false;
  return test.status === 'ok';
}
