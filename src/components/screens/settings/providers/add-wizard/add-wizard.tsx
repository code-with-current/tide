import * as api from '@/lib/api/client';
import { useEffect, useReducer, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useProviders, useAddProvider } from '@/lib/queries';
import { rowsToModels, appendFetchedModels } from '../models-table';
import { getPreset } from '@/lib/provider-presets';
import { cn } from '@/lib/utils';
import { canAdvance, initialWizardState, wizardReducer, type TestStatus, type WizardStep } from './wizard-reducer';
import { ChooseProviderStep } from './choose-provider-step';
import { ConnectStep } from './connect-step';
import { PickModelsStep } from './pick-models-step';
import { ReviewStep } from './review-step';

const STEPS: WizardStep[] = ['choose', 'connect', 'models', 'review'];
const STEP_LABELS: Record<WizardStep, string> = {
  choose: 'Provider', connect: 'Connect', models: 'Models', review: 'Review',
};

export function AddProviderWizard({
  onClose,
  onCreated,
  embedded,
  onFinish,
}: {
  onClose?: () => void;
  onCreated?: (id: string) => void;
  embedded?: boolean;
  onFinish?: (created: { id: string; models: { modelId: string }[] }) => void;
}) {
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState);
  const [test, setTest] = useState<TestStatus>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { data: providers } = useProviders();
  const addProvider = useAddProvider();

  const preset = state.presetId ? getPreset(state.presetId) : undefined;
  const requiresKey = preset?.requiresKey ?? false;
  const existingNames = (providers ?? []).map((p) => p.name);
  const addedBaseUrls = (providers ?? []).map((p) => p.baseUrl);

  useEffect(() => {
    setTest({ status: 'idle' });
  }, [state.apiStyle, state.baseUrl, state.apiKey]);

  const runTest = async (): Promise<boolean> => {
    setTest({ status: 'running' });
    const withLocalHint = (message: string) =>
      preset?.group === 'local' && /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(message)
        ? `${message} — is the local server running?`
        : message;
    try {
      const result = await api.detectProviderProtocol({
        baseUrl: state.baseUrl.trim(),
        apiKey: state.apiKey.trim(),
      });
      if (!result) {
        setTest({ status: 'error', error: 'IPC unavailable.' });
        return false;
      }
      if ('error' in result) {
        setTest({ status: 'error', error: withLocalHint(result.error) });
        return false;
      }
      setTest({ status: 'ok' });
      return true;
    } catch (e) {
      setTest({
        status: 'error',
        error: withLocalHint(e instanceof Error ? e.message : 'Connection test failed.'),
      });
      return false;
    }
  };

  const handleNext = async () => {
    if (state.step === 'connect' && test.status !== 'ok') {
      const ok = await runTest();
      if (!ok) return;
    }
    dispatch({ type: 'next' });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const rows = appendFetchedModels(
        [],
        state.models.filter((m) => state.selected.includes(m.modelId)),
      );
      const created = await addProvider.mutateAsync({
        name: state.name.trim() || 'Untitled',
        apiStyle: state.apiStyle,
        baseUrl: state.baseUrl.trim(),
        apiKey: state.apiKey.trim() || undefined,
        models: rowsToModels(rows),
      });
      if (embedded && onFinish) onFinish(created);
      else onCreated?.(created.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const body = (
    <div className="flex flex-1 min-h-0">
      <div className="w-[168px] border-r border-border px-3 py-4 flex flex-col gap-2 shrink-0">
        {STEPS.map((s, i) => {
          const current = s === state.step;
          const completed = i < STEPS.indexOf(state.step);
          return (
            <div
              key={s}
              className={cn(
                'flex items-center gap-2.5 p-2.5 rounded-xl border transition-colors',
                current
                  ? 'border-primary/40 bg-secondary shadow-sm'
                  : completed
                    ? 'border-border/60 bg-secondary/40'
                    : 'border-transparent',
              )}
            >
              <span
                className={cn(
                  'size-6 rounded-lg flex items-center justify-center shrink-0 text-[0.7143rem] font-mono font-semibold',
                  current
                    ? 'bg-primary text-primary-foreground'
                    : completed
                      ? 'bg-primary/20 text-primary'
                      : 'bg-secondary text-muted-foreground/50 border border-border',
                )}
              >
                {completed ? (
                  <Check className="size-3" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  'text-[0.8571rem]',
                  current
                    ? 'text-foreground font-semibold'
                    : completed
                      ? 'text-foreground/80'
                      : 'text-muted-foreground/55',
                )}
              >
                {STEP_LABELS[s]}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scroll px-5 py-4">
        {state.step === 'choose' && (
          <ChooseProviderStep
            existingNames={existingNames}
            addedBaseUrls={addedBaseUrls}
            onSelect={(p) => dispatch({ type: 'select-preset', preset: p, existingNames })}
            onCustom={(apiStyle) => dispatch({ type: 'select-custom', apiStyle })}
          />
        )}
        {state.step === 'connect' && (
          <ConnectStep state={state} preset={preset} test={test} dispatch={dispatch} onRetest={runTest} />
        )}
        {state.step === 'models' && (
          <PickModelsStep state={state} preset={preset} dispatch={dispatch} />
        )}
        {state.step === 'review' && <ReviewStep state={state} preset={preset} />}
      </div>
    </div>
  );

  const footer = (
    <div className="px-5 py-3 bg-secondary border-t border-border flex items-center justify-between shrink-0">
      <Button
        variant="ghost"
        size="sm"
        disabled={state.step === 'choose'}
        onClick={() => dispatch({ type: 'back' })}
      >
        <ArrowLeft className="size-3.5" /> Back
      </Button>
      <div className="flex items-center gap-2.5 min-w-0">
        {state.step === 'connect' && test.status === 'ok' && (
          <span className="text-[0.7857rem] text-success flex items-center gap-1 shrink-0">
            <Check className="size-3" /> Connection verified
          </span>
        )}
        {state.step === 'connect' && test.status === 'error' && test.error && (
          <span className="text-[0.7857rem] text-destructive truncate max-w-[280px]" title={test.error}>
            {test.error}
          </span>
        )}
        {saveError && (
          <span className="text-[0.7857rem] text-destructive truncate max-w-[280px]" title={saveError}>
            {saveError}
          </span>
        )}
        <Button
          size="sm"
          disabled={
            state.step === 'choose' ||
            // Fields only — handleNext runs the connection test on click, so
            // requiring an already-passed test here would deadlock the button.
            !canAdvance(state, { status: 'ok' }, requiresKey) ||
            saving ||
            test.status === 'running'
          }
          onClick={state.step === 'review' ? handleSave : handleNext}
        >
          {saving || test.status === 'running' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : state.step === 'review' ? (
            <Check className="size-3.5" />
          ) : null}
          {saving
            ? 'Saving…'
            : test.status === 'running'
              ? 'Testing…'
              : state.step === 'review'
                ? 'Save provider'
                : 'Continue'}
          {state.step !== 'review' && <ArrowRight className="size-3.5" />}
        </Button>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {body}
        {footer}
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="min-w-[60%] max-w-3xl h-[600px] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 py-3.5 flex-row items-center gap-3 border-b border-border space-y-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{
              background: 'rgba(217,119,87,0.12)',
              border: '1px solid rgba(217,119,87,0.25)',
            }}
          >
            <KeyRound className="size-4 text-primary" />
          </div>
          <div className="flex-1">
            <DialogTitle className="text-base font-semibold text-left">
              Add Provider
            </DialogTitle>
            <DialogDescription className="text-xs mt-0.5">
              Pick a provider or configure a custom endpoint.
            </DialogDescription>
          </div>
        </DialogHeader>
        {body}
        {footer}
      </DialogContent>
    </Dialog>
  );
}
