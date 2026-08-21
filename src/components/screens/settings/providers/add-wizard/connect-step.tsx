import { useEffect, useState, type Dispatch, type ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Plug,
  RefreshCw,
  Server,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ApiStyle } from '@/types';
import type { ProviderPreset } from '@/lib/provider-presets';
import { ApiStylePicker, EndpointPreview, FormField, PROTOCOL, SectionLabel } from '../providers';
import type { TestStatus, WizardAction, WizardState } from './wizard-reducer';

export function ConnectStep({
  state,
  preset,
  test,
  dispatch,
}: {
  state: WizardState;
  preset: ProviderPreset | undefined;
  test: TestStatus;
  dispatch: Dispatch<WizardAction>;
  onRetest: () => Promise<boolean>;
}) {
  return preset ? (
    <PresetConnectStep state={state} preset={preset} test={test} dispatch={dispatch} />
  ) : (
    <CustomConnectStep state={state} test={test} dispatch={dispatch} />
  );
}

// Presets arrive with endpoint + protocol pre-filled; only name and key are
// front-and-center. Protocol/base URL live behind "Advanced" so the common
// path is two fields, but the z.ai anthropic↔openai flip stays reachable.
function PresetConnectStep({
  state,
  preset,
  test,
  dispatch,
}: {
  state: WizardState;
  preset: ProviderPreset;
  test: TestStatus;
  dispatch: Dispatch<WizardAction>;
}) {
  const [advanced, setAdvanced] = useState(false);
  const host = preset.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  return (
    <section className="space-y-3.5">
      <SectionLabel icon={<Server className="size-3" />}>Connection</SectionLabel>

      <FormField id="wizard-name" label="Provider name">
        <Input
          className="h-8 text-[12.5px]"
          value={state.name}
          onChange={(e) => dispatch({ type: 'patch', patch: { name: e.target.value } })}
        />
      </FormField>

      {preset.requiresKey ? (
        <FormField id="wizard-key" label="API key">
          <Input
            type="password"
            className="font-mono text-[12px] h-8"
            value={state.apiKey}
            placeholder={preset.keyPlaceholder}
            onChange={(e) => dispatch({ type: 'patch', patch: { apiKey: e.target.value } })}
          />
          <KeychainHint
            apiStyle={state.apiStyle}
            action={
              preset.keyUrl ? (
                <a
                  href={preset.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] text-primary/70 hover:text-primary shrink-0"
                >
                  Get a key ↗
                </a>
              ) : undefined
            }
          />
        </FormField>
      ) : (
        <p className="text-[11px] text-muted-foreground/60 flex items-center gap-1.5">
          <Server className="size-3" />
          No key needed — Tide talks to {host} locally.
        </p>
      )}

      {test.status === 'error' && test.error && (
        <p className="text-[11px] text-destructive">{test.error}</p>
      )}

      <div>
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer"
        >
          {advanced ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          Advanced
        </button>
        {advanced && (
          <div className="space-y-3.5 pt-3">
            <div className="space-y-2">
              <SectionLabel icon={<Plug className="size-3" />}>API style</SectionLabel>
              <ApiStylePicker
                value={state.apiStyle}
                onChange={(apiStyle) => dispatch({ type: 'patch', patch: { apiStyle } })}
              />
            </div>
            <FormField id="wizard-base-url" label="Base URL">
              <Input
                className="font-mono text-[12px] h-8"
                value={state.baseUrl}
                placeholder={PROTOCOL[state.apiStyle].baseUrlPlaceholder}
                onChange={(e) => dispatch({ type: 'patch', patch: { baseUrl: e.target.value } })}
              />
            </FormField>
            <EndpointPreview apiStyle={state.apiStyle} baseUrl={state.baseUrl} />
          </div>
        )}
      </div>
    </section>
  );
}

function CustomConnectStep({
  state,
  test,
  dispatch,
}: {
  state: WizardState;
  test: TestStatus;
  dispatch: Dispatch<WizardAction>;
}) {
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detected, setDetected] = useState(false);

  useEffect(() => {
    if (!detected) return;
    const t = setTimeout(() => setDetected(false), 3000);
    return () => clearTimeout(t);
  }, [detected]);

  const detectProtocol = async () => {
    if (!state.baseUrl.trim() || !state.apiKey.trim()) return;
    setDetecting(true);
    setDetectError(null);
    setDetected(false);
    try {
      const result = await window.tideIpc?.detectProviderProtocol({
        baseUrl: state.baseUrl.trim(),
        apiKey: state.apiKey.trim(),
      });
      if (!result) {
        setDetectError('IPC unavailable.');
      } else if ('error' in result) {
        setDetectError(result.error);
      } else {
        dispatch({ type: 'patch', patch: { apiStyle: result.apiStyle } });
        setDetected(true);
      }
    } catch (e) {
      setDetectError(e instanceof Error ? e.message : 'Detection failed.');
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionLabel icon={<Plug className="size-3" />}>API style</SectionLabel>
        <ApiStylePicker
          value={state.apiStyle}
          onChange={(apiStyle) => dispatch({ type: 'patch', patch: { apiStyle } })}
        />
      </div>

      <EndpointPreview apiStyle={state.apiStyle} baseUrl={state.baseUrl} />

      <section className="space-y-3.5">
        <SectionLabel icon={<Server className="size-3" />}>Connection</SectionLabel>

        <FormField id="wizard-name" label="Provider name">
          <Input
            className="h-8 text-[12.5px]"
            value={state.name}
            placeholder="OpenRouter, z.ai, LM Studio…"
            onChange={(e) => dispatch({ type: 'patch', patch: { name: e.target.value } })}
          />
        </FormField>

        <FormField id="wizard-base-url" label="Base URL">
          <Input
            className="font-mono text-[12px] h-8"
            value={state.baseUrl}
            placeholder={PROTOCOL[state.apiStyle].baseUrlPlaceholder}
            onChange={(e) => dispatch({ type: 'patch', patch: { baseUrl: e.target.value } })}
          />
        </FormField>

        <FormField id="wizard-key" label="API key">
          <Input
            type="password"
            className="font-mono text-[12px] h-8"
            value={state.apiKey}
            placeholder={PROTOCOL[state.apiStyle].keyPlaceholder}
            onChange={(e) => dispatch({ type: 'patch', patch: { apiKey: e.target.value } })}
          />
          <KeychainHint apiStyle={state.apiStyle} />
        </FormField>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            disabled={!state.baseUrl.trim() || !state.apiKey.trim() || detecting}
            onClick={detectProtocol}
          >
            {detecting ? (
              <>
                <RefreshCw className="size-3.5 animate-spin" /> Detecting…
              </>
            ) : detected ? (
              <>
                <Check className="size-3.5 text-success" /> Detected: {state.apiStyle}
              </>
            ) : (
              <>
                <Zap className="size-3.5" /> Auto-Detect Protocol
              </>
            )}
          </Button>
          {detectError && <span className="text-[11px] text-destructive">{detectError}</span>}
        </div>

        {test.status === 'error' && test.error && (
          <p className="text-[11px] text-destructive">{test.error}</p>
        )}
      </section>
    </div>
  );
}

function KeychainHint({ apiStyle, action }: { apiStyle: ApiStyle; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mt-1 gap-2">
      <p className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
        <ShieldCheck className="size-2.5 text-success" />
        Sent as <span className="font-mono">{PROTOCOL[apiStyle].authHeader}</span>. Stored in the
        OS keychain.
      </p>
      {action}
    </div>
  );
}
