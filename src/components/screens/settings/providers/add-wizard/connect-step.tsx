import type { Dispatch } from 'react';
import type { ProviderPreset } from '@/lib/provider-presets';
import type { TestStatus, WizardAction, WizardState } from './wizard-reducer';

export function ConnectStep(_props: {
  state: WizardState;
  preset: ProviderPreset | undefined;
  test: TestStatus;
  dispatch: Dispatch<WizardAction>;
  onRetest: () => Promise<boolean>;
}) {
  return null;
}
