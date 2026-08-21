import { Plug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ProviderLogo } from '@/components/primitives/provider-logo';
import { PROVIDER_PRESETS, type PresetGroup, type ProviderPreset } from '@/lib/provider-presets';
import type { ApiStyle } from '@/types';
import { cn } from '@/lib/utils';
import { SectionLabel } from '../providers';

const GROUPS: { id: PresetGroup; label: string }[] = [
  { id: 'first-party', label: 'First-party' },
  { id: 'aggregator', label: 'Aggregators' },
  { id: 'local', label: 'Local' },
];

export function ChooseProviderStep({
  existingNames,
  addedBaseUrls,
  onSelect,
  onCustom,
}: {
  existingNames: string[];
  addedBaseUrls: string[];
  onSelect: (preset: ProviderPreset) => void;
  onCustom: (apiStyle: ApiStyle) => void;
}) {
  return (
    <div className="space-y-5">
      {GROUPS.map((g) => (
        <section key={g.id} className="space-y-2">
          <SectionLabel icon={<Plug className="size-3" />}>{g.label}</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {PROVIDER_PRESETS.filter((p) => p.group === g.id).map((p) => (
              <PresetTile
                key={p.id}
                preset={p}
                added={addedBaseUrls.includes(p.baseUrl)}
                onClick={() => onSelect(p)}
              />
            ))}
            {g.id === 'local' && (
              <>
                <CustomTile label="Custom OpenAI-compatible" onClick={() => onCustom('openai')} />
                <CustomTile label="Custom Anthropic-compatible" onClick={() => onCustom('anthropic')} />
              </>
            )}
          </div>
        </section>
      ))}
      <p className="text-[10px] text-muted-foreground/45">
        {existingNames.length > 0
          ? 'Providers you add again get a numbered name — multi-account is fine.'
          : 'Pick a provider to pre-fill its endpoint and key format.'}
      </p>
    </div>
  );
}

function PresetTile({
  preset,
  added,
  onClick,
}: {
  preset: ProviderPreset;
  added: boolean;
  onClick: () => void;
}) {
  const whiteAccent = preset.accent === '#ffffff';
  const host = preset.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-2.5 p-3 rounded-xl text-left transition-all duration-150 border',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        !added && 'border-border bg-card hover:border-primary/30 hover:bg-secondary/60',
      )}
    >
      <span
        className={cn(
          'size-8 rounded-lg flex items-center justify-center shrink-0',
          whiteAccent && 'bg-secondary text-foreground',
        )}
        style={whiteAccent ? undefined : { background: preset.accent }}
      >
        <ProviderLogo
          apiStyle={preset.apiStyle}
          presetId={preset.id}
          className={whiteAccent ? 'size-4' : 'size-4 text-white'}
        />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-semibold tracking-tight text-foreground/80">
          {preset.name}
        </div>
        <div className="text-[10px] text-muted-foreground/55 font-mono mt-0.5 truncate">
          {host}
        </div>
      </div>
      {added && (
        <Badge variant="secondary" className="text-[8px] uppercase px-1.5 py-0 shrink-0">
          Added
        </Badge>
      )}
    </button>
  );
}

function CustomTile({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex items-center gap-2.5 p-3 rounded-xl text-left transition-all duration-150',
        'border border-dashed border-border bg-card hover:border-primary/30 hover:bg-secondary/60',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      <span className="size-8 rounded-lg bg-secondary flex items-center justify-center shrink-0">
        <Plug className="size-4 text-muted-foreground" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-semibold tracking-tight text-foreground/80">
          {label}
        </div>
      </div>
    </button>
  );
}
