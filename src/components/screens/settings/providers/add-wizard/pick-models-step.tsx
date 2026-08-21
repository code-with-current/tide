import type { Dispatch } from 'react';
import type { ProviderPreset } from '@/lib/provider-presets';
import type { WizardAction, WizardState } from './wizard-reducer';

export function PickModelsStep(_props: {
  state: WizardState;
  preset: ProviderPreset | undefined;
  dispatch: Dispatch<WizardAction>;
}) {
  return null;
}
