import React, { useRef, useState } from 'react';
import { ChevronDown, Check, Brain, Eye, Star, Search, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonBar } from '@/components/ui/loading-rows';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProviderLogo } from '@/components/primitives/provider-logo';
import { cn, formatContext } from '@/lib/utils';
import { useModels, useProviders } from '@/lib/queries';
import { matchPresetByBaseUrl } from '@/lib/provider-presets';
import { useUi } from '@/lib/stores/ui';
import type { ModelOption } from '@/lib/queries';
import { Kbd } from '@/components/ui/kbd';

/** Pseudo-rail id for the pinned Starred section. */
const STARRED_RAIL = '__starred__';

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

/** One rail entry: a provider with its (filtered) models. */
interface RailEntry {
  id: string;
  name: string;
  apiStyle: 'openai' | 'anthropic';
  models: ModelOption[];
}

/** Model picker — two-pane layout: provider rail (left) + model list (right).
 *  Every provider is one click away, no scrolling past other providers' models.
 *  When `locked`, renders a static label (the session's model is immutable); clicking it
 *  forks into the new-session screen with the fork intent set — the user picks a
 *  new model there and the first send creates the forked session. */
export function ModelSelector({ compact = false, locked = false, onLockedClick }: { compact?: boolean; locked?: boolean; onLockedClick?: () => void }) {
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const selectedId = useUi((s) => s.selectedModelId);
  const setSelected = useUi((s) => s.setSelectedModel);
  const starred = useUi((s) => s.starredModels);
  const toggleStar = useUi((s) => s.toggleStarredModel);
  const { models, isLoading } = useModels();
  const { data: providers } = useProviders();
  const presetByProvider = new Map(
    (providers ?? []).map((p) => [p.id, matchPresetByBaseUrl(p.baseUrl)]),
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rail, setRail] = useState<string>(STARRED_RAIL);
  const [activeIdx, setActiveIdx] = useState(0);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const selected =
    models.find((m) => m.providerId === selectedProviderId && m.modelId === selectedId) ??
    models.find((m) => m.modelId === selectedId);

  const isStarredModel = (m: ModelOption) => starred.includes(`${m.providerId}:${m.modelId}`);

  // ── Locked mode: static label, click opens Fork dialog ──
  if (locked) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={cn('h-8 gap-1.5 text-[0.85rem] px-2 text-input-foreground hover:text-foreground', compact && 'px-1.5')}
        onClick={onLockedClick}
        title="Model is locked for this session. Click to fork into a new session."
      >
        {!compact && (
          <span className="truncate max-w-[160px]">{selected?.alias ?? selectedId ?? 'Unknown'}</span>
        )}
        <Lock className="size-3 text-input-foreground/50" />
      </Button>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? models.filter(
        (m) =>
          m.alias.toLowerCase().includes(q) ||
          m.modelId.toLowerCase().includes(q),
      )
    : models;

  // Rail entries in provider-query order; counts reflect the active search.
  const entries: RailEntry[] = [];
  for (const m of filtered) {
    let e = entries.find((x) => x.id === m.providerId);
    if (!e) {
      e = { id: m.providerId, name: m.providerName, apiStyle: m.apiStyle, models: [] };
      entries.push(e);
    }
    e.models.push(m);
  }
  const allStarred = models.filter(isStarredModel);

  const searching = q.length > 0;
  const visible: ModelOption[] = searching
    ? filtered
    : rail === STARRED_RAIL
      ? allStarred
      : (entries.find((e) => e.id === rail)?.models ?? models.filter((m) => m.providerId === rail));

  // Cross-provider lists (search / starred) need the provider name in the sub-line.
  const showProviderInRow = searching || rail === STARRED_RAIL;

  const pick = (m: ModelOption) => {
    setSelected(m.providerId, m.modelId);
    setOpen(false);
  };

  const moveActive = (delta: number) => {
    const next = Math.max(0, Math.min(visible.length - 1, activeIdx + delta));
    setActiveIdx(next);
    rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
  };

  // ←/→ cycle the rail; only when not typing (caret arrows must keep working).
  const railIds = [STARRED_RAIL, ...entries.map((e) => e.id)];
  const cycleRail = (delta: number) => {
    const i = railIds.indexOf(rail);
    const next = railIds[(i + delta + railIds.length) % railIds.length] ?? railIds[0];
    setRail(next);
    setActiveIdx(0);
  };

  const railCount = (id: string) =>
    id === STARRED_RAIL ? allStarred.length : entries.find((e) => e.id === id)?.models.length ?? 0;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setQuery('');
          setActiveIdx(0);
          const sid = selected?.providerId;
          setRail(sid && models.some((m) => m.providerId === sid) ? sid : STARRED_RAIL);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-8 gap-1.5 text-[0.85rem] px-2 text-input-foreground hover:text-foreground', compact && 'px-1.5')}
          disabled={isLoading || models.length === 0}
        >
          {!compact &&
            (isLoading ? (
              <SkeletonBar className="h-3 w-16" aria-hidden />
            ) : (
              <span>{selected?.alias ?? (models.length === 0 ? 'No models' : 'Select model')}</span>
            ))}
          <ChevronDown className="size-4 text-muted-foreground/60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" sideOffset={6} className="w-[350px] max-w-[calc(100vw-2rem)] h-[250px] p-0 overflow-hidden flex flex-col">
        {/* ── Search — spans both panes ── */}
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
                const m = visible[activeIdx];
                if (m) pick(m);
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
            <span className="text-[0.7143rem] font-mono text-muted-foreground/50 shrink-0">
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
          {/* ── Provider rail — fixed, never scrolls with the list ── */}
          <div className="w-[100px] shrink-0 border-r border-border/60 overflow-y-auto overflow-x-hidden py-1">
            {allStarred.length > 0 && (
              <RailItem
                active={rail === STARRED_RAIL}
                dim={searching && railCount(STARRED_RAIL) === 0}
                count={railCount(STARRED_RAIL)}
                onClick={() => {
                  setRail(STARRED_RAIL);
                  setActiveIdx(0);
                }}
                tile={
                  <span className="size-4 rounded flex items-center justify-center bg-warning/15 text-warning shrink-0">
                    <Star className="size-2.5 fill-current" />
                  </span>
                }
                name="Starred"
              />
            )}
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

          {/* ── Model list — the only scrolling pane ── */}
          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden py-0.5">
            {visible.map((m, i) => (
              <ModelRow
                key={`${m.providerId}:${m.modelId}`}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                model={m}
                active={i === activeIdx}
                showProvider={showProviderInRow}
                selected={m === selected}
                isStarred={isStarredModel(m)}
                onSelect={() => pick(m)}
                onToggleStar={() => toggleStar(m.providerId, m.modelId)}
                onHover={() => setActiveIdx(i)}
              />
            ))}

            {/* ── Empty states ── */}
            {visible.length === 0 && q && !isLoading && (
              <div className="px-2 py-6 text-[0.7857rem] text-muted-foreground/60 text-center">
                No models match &quot;{query}&quot;.
              </div>
            )}
            {isLoading && models.length === 0 && (
              <div className="py-0.5" aria-hidden>
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex items-center gap-1.5 px-2 py-1">
                    <SkeletonBar className="size-3.5 shrink-0 rounded-[4px]" />
                    <div className="min-w-0 flex-1">
                      <SkeletonBar className="h-3 w-2/5" />
                      <SkeletonBar className="mt-1 h-2 w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!isLoading && models.length === 0 && (
              <div className="px-2 py-6 text-[0.7857rem] text-muted-foreground/60 text-center">
                No models configured.
                <br />
                Add a provider in Onboarding or Settings.
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 px-2 py-1 border-t border-border/60 text-[0.7143rem] text-muted-foreground/60 flex items-center gap-3">
          <span><Kbd className='py-0.5'>←→</Kbd> Provider</span>
          <span><Kbd>↑↓</Kbd> Navigate</span>
          <span><Kbd>↵</Kbd> Select</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One rail row: brand tile, provider name, live match count. */
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
      <span className="flex-1 min-w-0 truncate text-[0.75rem] font-medium">{name}</span>
      <span className="text-[0.6429rem] font-mono text-muted-foreground/50 shrink-0">{count}</span>
    </button>
  );
}

/** A single model row — star toggle, alias, brain icon, context, check mark. */
function ModelRow({
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
  /** Show provider name in the sub-line (search / starred lists span providers). */
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
