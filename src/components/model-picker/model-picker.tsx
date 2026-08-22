/** ModelPickerPopover — the chat composer's two-pane model picker as a
 *  CONTROLLED component for settings: provider rail + model rows (reasoning/
 *  vision icons, context, price), search, keyboard nav, and an optional
 *  "default" row that picks null (e.g. "Session model (default)"). */

import { useRef, useState } from 'react';
import { Brain, Check, ChevronDown, Eye, Search, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProviderLogo } from '@/components/primitives/provider-logo';
import { Kbd } from '@/components/ui/kbd';
import { cn, formatContext } from '@/lib/utils';
import { useModels, useProviders } from '@/lib/queries';
import { matchPresetByBaseUrl } from '@/lib/provider-presets';
import { useUi } from '@/lib/stores/ui';
import type { ModelOption } from '@/lib/queries';

export interface PickedModel {
  providerId: string;
  modelId: string;
}

function ProviderTile({
  preset,
  apiStyle,
}: {
  preset?: ReturnType<typeof matchPresetByBaseUrl>;
  apiStyle: 'openai' | 'anthropic';
}) {
  const accent = preset?.accent;
  const branded = !!accent && accent !== '#ffffff';
  return (
    <span
      className={cn(
        'size-4 rounded flex items-center justify-center shrink-0',
        branded ? 'text-white' : 'bg-secondary text-foreground',
      )}
      style={branded ? { background: accent } : undefined}
    >
      <ProviderLogo apiStyle={apiStyle} presetId={preset?.id} className="size-2.5" />
    </span>
  );
}

export function ModelPickerPopover({
  value,
  onChange,
  defaultLabel,
  placeholder = 'Select model',
}: {
  value: PickedModel | null;
  onChange: (v: PickedModel | null) => void;
  /** Label for the null choice; omit to disable the default row entirely. */
  defaultLabel?: string;
  placeholder?: string;
}) {
  const starred = useUi((s) => s.starredModels);
  const toggleStar = useUi((s) => s.toggleStarredModel);
  const { models, isLoading } = useModels();
  const { data: providers } = useProviders();
  const presetByProvider = new Map(
    (providers ?? []).map((p) => [p.id, matchPresetByBaseUrl(p.baseUrl)]),
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rail, setRail] = useState<string>('__all__');
  const [activeIdx, setActiveIdx] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const selected =
    value ? models.find((m) => m.providerId === value.providerId && m.modelId === value.modelId) : undefined;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? models.filter(
        (m) => m.alias.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q),
      )
    : models;

  const entries: { id: string; name: string; apiStyle: 'openai' | 'anthropic'; models: ModelOption[] }[] = [];
  for (const m of filtered) {
    let e = entries.find((x) => x.id === m.providerId);
    if (!e) {
      e = { id: m.providerId, name: m.providerName, apiStyle: m.apiStyle, models: [] };
      entries.push(e);
    }
    e.models.push(m);
  }

  const searching = q.length > 0;
  const visible: ModelOption[] = searching
    ? filtered
    : rail === '__all__'
      ? filtered
      : (entries.find((e) => e.id === rail)?.models ?? []);

  const isStarredModel = (m: ModelOption) => starred.includes(`${m.providerId}:${m.modelId}`);

  // The default row is index 0 when present (and matched by the search);
  // model rows follow. Keeps keyboard nav over one flat list.
  const defaultRowVisible =
    !!defaultLabel && (!q || defaultLabel.toLowerCase().includes(q) || 'default'.includes(q));
  const rows: Array<{ kind: 'default' } | { kind: 'model'; model: ModelOption }> = [
    ...(defaultRowVisible ? [{ kind: 'default' as const }] : []),
    ...visible.map((model) => ({ kind: 'model' as const, model })),
  ];

  const pickRow = (row: (typeof rows)[number]) => {
    if (row.kind === 'default') onChange(null);
    else onChange({ providerId: row.model.providerId, modelId: row.model.modelId });
    setOpen(false);
  };

  const moveActive = (delta: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, activeIdx + delta));
    setActiveIdx(next);
    rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
  };

  const railIds = ['__all__', ...entries.map((e) => e.id)];
  const cycleRail = (delta: number) => {
    const i = railIds.indexOf(rail);
    const next = railIds[(i + delta + railIds.length) % railIds.length] ?? railIds[0];
    setRail(next);
    setActiveIdx(0);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setQuery('');
          setActiveIdx(0);
          const sid = value?.providerId;
          setRail(sid && models.some((m) => m.providerId === sid) ? sid : '__all__');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-normal max-w-[240px]">
          <span className="truncate">
            {value
              ? (selected?.alias ?? value.modelId)
              : (defaultLabel ?? placeholder)}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground/60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-[350px] max-w-[calc(100vw-2rem)] h-[250px] p-0 overflow-hidden flex flex-col">
        <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-border/60">
          <Search className="size-3.5 text-muted-foreground/50 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveActive(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveActive(-1);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const row = rows[activeIdx];
                if (row) pickRow(row);
              } else if (!q && e.key === 'ArrowRight') {
                e.preventDefault();
                cycleRail(1);
              } else if (!q && e.key === 'ArrowLeft') {
                e.preventDefault();
                cycleRail(-1);
              } else if (e.key === 'Escape' && q) {
                e.stopPropagation();
                setQuery('');
                setActiveIdx(0);
              }
            }}
            placeholder="Search models…"
            className="w-full bg-transparent border-0 outline-none text-[0.75rem] text-foreground placeholder:text-muted-foreground/50"
          />
          {searching && (
            <span className="text-[10px] font-mono text-muted-foreground/50 shrink-0">
              {filtered.length} match{filtered.length === 1 ? '' : 'es'}
            </span>
          )}
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-muted-foreground/50 hover:text-foreground text-md shrink-0"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-[100px] shrink-0 border-r border-border/60 overflow-y-auto overflow-x-hidden py-1">
            <RailItem
              active={rail === '__all__' && !searching}
              dim={searching && filtered.length === 0}
              count={filtered.length}
              onClick={() => {
                setRail('__all__');
                setActiveIdx(0);
              }}
              tile={
                <span className="size-4 rounded flex items-center justify-center bg-secondary text-muted-foreground shrink-0 text-[9px] font-semibold">
                  ∀
                </span>
              }
              name="All"
            />
            {entries.map((e) => (
              <RailItem
                key={e.id}
                active={rail === e.id && !searching}
                dim={searching && e.models.length === 0}
                count={e.models.length}
                onClick={() => {
                  setRail(e.id);
                  setActiveIdx(0);
                }}
                tile={<ProviderTile preset={presetByProvider.get(e.id)} apiStyle={e.apiStyle} />}
                name={e.name}
              />
            ))}
          </div>

          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden py-0.5">
            {rows.map((row, i) =>
              row.kind === 'default' ? (
                <div
                  key="__default__"
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  role="button"
                  tabIndex={-1}
                  onClick={() => pickRow(row)}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors',
                    i === activeIdx ? 'bg-accent/60' : 'hover:bg-accent/40',
                    'border-b border-border/40 mb-0.5',
                  )}
                >
                  <span className="size-3.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.8rem] font-medium truncate">{defaultLabel}</div>
                    <div className="text-[0.7rem] text-muted-foreground/60 truncate">
                      Follows the session's model
                    </div>
                  </div>
                  {!value && <Check className="size-4 text-primary shrink-0" />}
                </div>
              ) : (
                <PickerRow
                  key={`${row.model.providerId}:${row.model.modelId}`}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  model={row.model}
                  active={i === activeIdx}
                  showProvider={searching || rail === '__all__'}
                  selected={
                    !!value &&
                    value.providerId === row.model.providerId &&
                    value.modelId === row.model.modelId
                  }
                  isStarred={isStarredModel(row.model)}
                  onSelect={() => pickRow(row)}
                  onToggleStar={() => toggleStar(row.model.providerId, row.model.modelId)}
                  onHover={() => setActiveIdx(i)}
                />
              ),
            )}

            {rows.length === 0 && !isLoading && (
              <div className="px-2 py-6 text-[11px] text-muted-foreground/60 text-center">
                {q ? (
                  <>No models match &quot;{query}&quot;.</>
                ) : (
                  <>
                    No models configured.
                    <br />
                    Add a provider in Settings → LLM Providers.
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 px-2 py-1 border-t border-border/60 text-[10px] text-muted-foreground/60 flex items-center gap-3">
          <span><Kbd className='py-0.5'>←→</Kbd> Provider</span>
          <span><Kbd>↑↓</Kbd> Navigate</span>
          <span><Kbd>↵</Kbd> Select</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RailItem({
  active,
  dim,
  count,
  onClick,
  tile,
  name,
}: {
  active: boolean;
  dim: boolean;
  count: number;
  onClick: () => void;
  tile: React.ReactNode;
  name: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={name}
      className={cn(
        'w-full flex items-center gap-1.5 px-2 py-1 text-left transition-colors',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
        dim && 'opacity-40',
      )}
    >
      {tile}
      <span className="flex-1 min-w-0 truncate text-[10.5px] font-medium">{name}</span>
      <span className="text-[9px] font-mono text-muted-foreground/50 shrink-0">{count}</span>
    </button>
  );
}

function PickerRow({
  model,
  active,
  showProvider,
  selected,
  isStarred,
  onSelect,
  onToggleStar,
  onHover,
  ref,
}: {
  model: ModelOption;
  active: boolean;
  showProvider: boolean;
  selected: boolean;
  isStarred: boolean;
  onSelect: () => void;
  onToggleStar: () => void;
  onHover: () => void;
  ref: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={-1}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 cursor-pointer overflow-hidden transition-colors',
        active ? 'bg-accent/60' : 'hover:bg-accent/40',
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar();
        }}
        className="text-muted-foreground/40 hover:text-warning shrink-0"
        title={isStarred ? 'Unstar' : 'Star'}
      >
        <Star className={cn('size-3.5', isStarred && 'fill-current text-warning')} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-[0.8rem] font-medium flex items-center gap-1.5 truncate">
          <span className="truncate">{model.alias}</span>
          {model.reasoning && <Brain className="size-2.5 text-reasoning shrink-0" />}
          {model.vision && <Eye className="size-2.5 text-info shrink-0" />}
        </div>
        <div className="text-[0.7rem] text-muted-foreground/60 truncate">
          {showProvider && <span className="text-muted-foreground/80">{model.providerName} · </span>}
          {formatContext(model.contextWindow)} ctx{model.priceLabel ? ` · ${model.priceLabel}` : ''}
        </div>
      </div>
      {selected && <Check className="size-4 text-primary shrink-0" />}
    </div>
  );
}
