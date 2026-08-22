import { Brain, BrainCircuit, Eye, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ProviderLogo } from '@/components/primitives/provider-logo';
import type { FetchedModel } from '@/lib/fetch-models';
import type { ProviderPreset } from '@/lib/provider-presets';
import { cn, formatContext } from '@/lib/utils';
import { EndpointPreview, SectionLabel } from '../provider-fields';
import type { WizardState } from './wizard-reducer';

export function ReviewStep({
  state,
  preset,
}: {
  state: WizardState;
  preset: ProviderPreset | undefined;
}) {
  const plainTile = !preset || preset.accent === '#ffffff';
  const selected = state.models.filter((m) => state.selected.includes(m.modelId));

  const metaLine = (m: FetchedModel) =>
    m.contextWindow
      ? `${formatContext(m.contextWindow)} ctx${m.priceLabel ? ' · ' + m.priceLabel : ''}`
      : m.priceLabel;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-3 flex items-center gap-2.5">
        <span
          className={cn(
            'size-8 rounded-lg flex items-center justify-center shrink-0',
            plainTile && 'bg-secondary text-foreground',
          )}
          style={plainTile ? undefined : { background: preset.accent }}
        >
          <ProviderLogo
            apiStyle={state.apiStyle}
            presetId={preset?.id}
            className={plainTile ? 'size-4' : 'size-4 text-white'}
          />
        </span>
        <span className="text-sm font-semibold truncate">{state.name}</span>
        <Badge variant="secondary" className="ml-auto text-[9px] uppercase shrink-0">
          {state.apiStyle === 'openai' ? 'OpenAI' : 'Anthropic'}
        </Badge>
      </div>

      <EndpointPreview apiStyle={state.apiStyle} baseUrl={state.baseUrl} />

      <div className="flex items-center gap-1.5 text-[11px]">
        {state.apiKey.trim() ? (
          <>
            <ShieldCheck className="size-3 text-success shrink-0" />
            <span>Key will be stored in the OS keychain</span>
          </>
        ) : (
          <span className="text-muted-foreground/55">No API key set</span>
        )}
      </div>

      <div className="space-y-2">
        <SectionLabel icon={<BrainCircuit className="size-3" />} count={state.selected.length}>
          Models
        </SectionLabel>
        {selected.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/55">
            No models selected — you can add them later in Settings.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {selected.map((m) => (
              <span
                key={m.modelId}
                className="rounded-md border border-border bg-card px-2 py-1 flex items-center gap-1.5"
              >
                <code className="font-mono text-[11px]">{m.modelId}</code>
                {m.reasoning && <Brain className="size-3 text-reasoning shrink-0" />}
                {m.supportsVision && <Eye className="size-3 text-info shrink-0" />}
                {metaLine(m) && (
                  <span className="text-[10px] text-muted-foreground/55">{metaLine(m)}</span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
