import { useEffect, useRef, useState, type Dispatch } from 'react';
import { BrainCircuit, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import * as api from '@/lib/api/client';
import { fetchAndEnrichModels, type FetchedModel, type ResolveFn } from '@/lib/fetch-models';
import type { ProviderPreset } from '@/lib/provider-presets';
import { cn, formatContext } from '@/lib/utils';
import { FetchRow, FetchSection, SectionLabel } from '../providers';
import type { WizardAction, WizardState } from './wizard-reducer';

/** Adapts api.resolveModelCatalog (nulls for "absent") to ResolveFn (optional fields). */
const resolveCatalogMeta: ResolveFn = async (input) => {
  const res = await api.resolveModelCatalog(input);
  const meta = res?.meta;
  return meta
    ? {
        meta: {
          resolvedCatalogId: meta.resolvedCatalogId ?? undefined,
          contextWindow: meta.contextWindow,
          supportsReasoning: meta.supportsReasoning,
          supportsVision: meta.supportsVision,
          pricing: meta.pricing ?? undefined,
        },
      }
    : null;
};

export function PickModelsStep({
  state,
  preset,
  dispatch,
}: {
  state: WizardState;
  preset: ProviderPreset | undefined;
  dispatch: Dispatch<WizardAction>;
}) {
  const [status, setStatus] = useState<'loading' | 'error' | 'done'>('loading');
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const load = async () => {
    setStatus('loading');
    try {
      const models = await fetchAndEnrichModels(
        api.probeProviderModels,
        resolveCatalogMeta,
        {
          apiStyle: state.apiStyle,
          baseUrl: state.baseUrl.trim(),
          apiKey: state.apiKey.trim(),
          existingIds: [],
        },
      );
      dispatch({ type: 'models-loaded', models, recommended: preset?.recommended ?? [] });
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fetch failed');
      setStatus('error');
    }
  };

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void load();
    // Mount-once auto-fetch; ref guard survives strict-mode double-invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = state.models.filter((m) => m.matchState === 'live');
  const available = state.models.filter((m) => m.matchState !== 'live');
  const allSelected =
    state.models.length > 0 && state.selected.length === state.models.length;

  const metaLine = (m: FetchedModel) =>
    m.contextWindow
      ? `${formatContext(m.contextWindow)} ctx${m.priceLabel ? ' · ' + m.priceLabel : ''}`
      : m.priceLabel;

  return (
    <div className="space-y-2">
      <SectionLabel
        icon={<BrainCircuit className="size-3" />}
        count={state.selected.length}
        action={
          <div className="flex items-center gap-1">
            {state.models.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  dispatch({ type: allSelected ? 'select-none-models' : 'select-all-models' })
                }
                className="text-[11px] text-muted-foreground/60 hover:text-foreground cursor-pointer transition-colors"
              >
                {allSelected ? 'Select none' : 'Select all'}
              </button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              className="text-[11px] h-7 text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={cn('size-3', status === 'loading' && 'animate-spin')} />
              {status === 'loading' ? 'Fetching…' : 'Refresh'}
            </Button>
          </div>
        }
      >
        Models
      </SectionLabel>

      {status === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
          <RefreshCw className="size-3 animate-spin" /> Fetching models from the provider…
        </div>
      )}

      {status === 'error' && (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <span className="text-xs text-destructive">{error}</span>
          <span className="text-[11px] text-muted-foreground/55">
            You can retry, or continue and add models later in Settings.
          </span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      {status === 'done' && state.models.length === 0 && (
        <div className="py-10 text-center text-xs text-muted-foreground">
          No models reported by this endpoint. Continue and add them manually later.
        </div>
      )}

      {status === 'done' && state.models.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden max-h-[46vh] overflow-y-auto scroll">
          {live.length > 0 && (
            <FetchSection
              icon="🟢"
              tone="success"
              label="From provider"
              count={live.length}
              hint="live data"
            >
              {live.map((m) => (
                <FetchRow
                  key={m.modelId}
                  checked={state.selected.includes(m.modelId)}
                  onToggle={() => dispatch({ type: 'toggle-model', modelId: m.modelId })}
                  modelId={m.modelId}
                  reasoning={m.reasoning}
                  vision={m.supportsVision}
                  mandatory={m.reasoningMandatory}
                  meta={metaLine(m)}
                />
              ))}
            </FetchSection>
          )}

          {available.length > 0 && (
            <FetchSection
              icon="—"
              tone="muted"
              label="Available models"
              count={available.length}
              hint={available.some((m) => m.catalogId) ? 'catalog-enriched' : 'no metadata'}
            >
              {available.map((m) => (
                <FetchRow
                  key={m.modelId}
                  checked={state.selected.includes(m.modelId)}
                  onToggle={() => dispatch({ type: 'toggle-model', modelId: m.modelId })}
                  modelId={m.modelId}
                  reasoning={m.reasoning}
                  vision={m.supportsVision}
                  mandatory={m.reasoningMandatory}
                  meta={metaLine(m)}
                />
              ))}
            </FetchSection>
          )}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/45">
        {preset?.recommended.length
          ? 'Recommended models are pre-checked — adjust as you like.'
          : 'Check the models you want available.'}
      </p>
    </div>
  );
}
