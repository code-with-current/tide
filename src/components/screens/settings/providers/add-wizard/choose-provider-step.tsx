import { useState } from 'react';
import { Plug, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ProviderLogo } from '@/components/primitives/provider-logo';
import { PROVIDER_PRESETS, type PresetGroup, type ProviderPreset } from '@/lib/provider-presets';
import type { ApiStyle } from '@/types';
import { cn } from '@/lib/utils';
import { SectionLabel } from '../provider-fields';

const GROUPS: { id: PresetGroup; label: string }[] = [
  { id: 'first-party', label: 'First-party' },
  { id: 'aggregator', label: 'Aggregators' },
  { id: 'local', label: 'Local' },
];

const CUSTOM_LABELS: Record<string, string> = {
  openai: 'Custom OpenAI-compatible',
  anthropic: 'Custom Anthropic-compatible',
};

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
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = (p: ProviderPreset) =>
    !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
  const customMatches = (style: ApiStyle) =>
    !q || CUSTOM_LABELS[style].toLowerCase().includes(q);
  const visible = (groupId: PresetGroup) =>
    PROVIDER_PRESETS.filter((p) => p.group === groupId && matches(p));
  const anyVisible = GROUPS.some((g) => visible(g.id).length > 0);

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/50" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search providers…"
          className="w-full h-8 pl-8 pr-8 text-[0.8571rem] bg-secondary/40 border border-border rounded-md outline-none focus:border-primary/50 transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[0.7857rem] text-muted-foreground/50 hover:text-foreground"
          >
            ✕
          </button>
        )}
      </div>

      {GROUPS.map((g) => {
        const presets = visible(g.id);
        if (presets.length === 0 && !(g.id === 'local' && (customMatches('openai') || customMatches('anthropic')))) {
          return null;
        }
        return (
          <section key={g.id} className="space-y-2">
            <SectionLabel icon={<Plug className="size-3" />}>{g.label}</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              {presets.map((p) => (
                <PresetTile
                  key={p.id}
                  preset={p}
                  added={addedBaseUrls.includes(p.baseUrl)}
                  onClick={() => onSelect(p)}
                />
              ))}
              {g.id === 'local' && customMatches('openai') && (
                <CustomTile label={CUSTOM_LABELS.openai} onClick={() => onCustom('openai')} />
              )}
              {g.id === 'local' && customMatches('anthropic') && (
                <CustomTile label={CUSTOM_LABELS.anthropic} onClick={() => onCustom('anthropic')} />
              )}
            </div>
          </section>
        );
      })}

      {!anyVisible && !(customMatches('openai') || customMatches('anthropic')) && (
        <div className="py-8 text-center text-xs text-muted-foreground">
          No providers match “{query.trim()}”.
        </div>
      )}

      <p className="text-[0.7143rem] text-muted-foreground/45">
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
        <div className="text-[0.8929rem] font-semibold tracking-tight text-foreground/80">
          {preset.name}
        </div>
        <div className="text-[0.7143rem] text-muted-foreground/55 font-mono mt-0.5 truncate">
          {host}
        </div>
      </div>
      {added && (
        <Badge variant="secondary" className="text-[0.5714rem] uppercase px-1.5 py-0 shrink-0">
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
        <div className="text-[0.8929rem] font-semibold tracking-tight text-foreground/80">
          {label}
        </div>
      </div>
    </button>
  );
}
