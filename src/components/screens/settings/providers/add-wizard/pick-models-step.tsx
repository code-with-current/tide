import { useEffect, useRef, useState, type Dispatch } from 'react';
import { BrainCircuit, CheckCheck, ListChecks, MoreHorizontal, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import * as api from '@/lib/api/client';
import { fetchAndEnrichModels, toResolveFn, type FetchedModel } from '@/lib/fetch-models';
import type { ProviderPreset } from '@/lib/provider-presets';
import { formatContext } from '@/lib/utils';
import { FetchRow, FetchSection, SectionLabel } from '../providers';
import type { WizardAction, WizardState } from './wizard-reducer';

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
  const [query, setQuery] = useState('');
  const fetchedRef = useRef(false);

  const load = async () => {
    setStatus('loading');
    try {
      const models = await fetchAndEnrichModels(
        api.probeProviderModels,
        toResolveFn(api.resolveModelCatalog),
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

  const q = query.trim().toLowerCase();
  const live = state.models.filter(
    (m) => m.matchState === 'live' && (!q || m.modelId.toLowerCase().includes(q)),
  );
  const available = state.models.filter(
    (m) => m.matchState !== 'live' && (!q || m.modelId.toLowerCase().includes(q)),
  );
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={status === 'loading' || state.models.length === 0}
                className="size-7 p-0 text-muted-foreground hover:text-foreground"
                title="Model actions"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              <DropdownMenuItem onClick={() => void load()} className="text-xs gap-2">
                <RefreshCw className="size-3.5" /> Refresh models
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={allSelected}
                onClick={() => dispatch({ type: 'select-all-models' })}
                className="text-xs gap-2"
              >
                <ListChecks className="size-3.5" /> Select all
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={state.selected.length === 0}
                onClick={() => dispatch({ type: 'select-none-models' })}
                className="text-xs gap-2"
              >
                <CheckCheck className="size-3.5" /> Deselect all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="w-full h-8 pl-8 pr-8 text-[12px] bg-secondary/40 border border-border rounded-md outline-none focus:border-primary/50 transition-colors"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground/50 hover:text-foreground"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {status === 'done' && state.models.length > 0 && live.length + available.length === 0 && (
        <div className="py-8 text-center text-xs text-muted-foreground">
          No models match “{query.trim()}”.
        </div>
      )}

      {status === 'done' && state.models.length > 0 && live.length + available.length > 0 && (
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
