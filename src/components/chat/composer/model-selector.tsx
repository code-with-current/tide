import { useState } from 'react';
import { ChevronDown, Check, Brain, Star, Search, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu';
import { cn, formatContext } from '@/lib/utils';
import { useModels } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import type { ModelOption } from '@/lib/queries';

/** Model picker. When `locked`, renders a static label (the session's model is immutable); clicking it opens the Fork dialog instead of a dropdown. */
export function ModelSelector({ compact = false, locked = false, onLockedClick }: { compact?: boolean; locked?: boolean; onLockedClick?: () => void }) {
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const selectedId = useUi((s) => s.selectedModelId);
  const setSelected = useUi((s) => s.setSelectedModel);
  const starred = useUi((s) => s.starredModels);
  const toggleStar = useUi((s) => s.toggleStarredModel);
  const { models, isLoading } = useModels();
  const [query, setQuery] = useState('');

  const selected =
    models.find((m) => m.providerId === selectedProviderId && m.modelId === selectedId) ??
    models.find((m) => m.modelId === selectedId);

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

  // Starred models (filtered) — pinned section at top.
  const starredModels = filtered.filter((m) => starred.includes(`${m.providerId}:${m.modelId}`));

  // Group ALL filtered models by provider (starred ones stay in their group).
  const byProvider = new Map<string, ModelOption[]>();
  for (const m of filtered) {
    const list = byProvider.get(m.providerName) ?? [];
    list.push(m);
    byProvider.set(m.providerName, list);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-8 gap-1.5 text-[0.85rem] px-2 text-input-foreground hover:text-foreground', compact && 'px-1.5')}
          disabled={isLoading || models.length === 0}
        >
          {!compact && (
            <span>{selected?.alias ?? (isLoading ? 'Loading…' : models.length === 0 ? 'No models' : 'Select model')}</span>
          )}
          <ChevronDown className="size-4 text-muted-foreground/60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top"  className="w-[300px] p-0 overflow-hidden">
        {/* ── Search box ── */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/60 sticky top-0 bg-popover z-10">
          <Search className="size-4 text-muted-foreground/50 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full bg-transparent border-0 outline-none text-[0.8rem] text-foreground placeholder:text-muted-foreground/50"
          />
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

        <div className="max-h-[340px] overflow-y-auto overflow-x-hidden">
          {/* ── Starred section ── */}
          {starredModels.length > 0 && (
            <>
              <DropdownMenuLabel className="text-[11px] text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1">
                <Star className="size-3 fill-current text-warning" />
                Starred
              </DropdownMenuLabel>
              {starredModels.map((m) => (
                <ModelRow
                  key={`star-${m.providerId}:${m.modelId}`}
                  model={m}
                  priceLabel={m.priceLabel}
                  selected={m === selected}
                  isStarred
                  onSelect={() => setSelected(m.providerId, m.modelId)}
                  onToggleStar={() => toggleStar(m.providerId, m.modelId)}
                />
              ))}
              <DropdownMenuSeparator />
            </>
          )}

          {/* ── Grouped by provider (starred models remain here too) ── */}
          {[...byProvider.entries()].map(([providerName, providerModels]) => (
            <DropdownMenuGroup key={providerName}>
              <DropdownMenuLabel className="text-[11px] text-muted-foreground/60 uppercase tracking-wider">
                {providerName}
              </DropdownMenuLabel>
              {providerModels.map((m) => (
                <ModelRow
                  key={`${m.providerId}:${m.modelId}`}
                  model={m}
                  priceLabel={m.priceLabel}
                  selected={m === selected}
                  isStarred={starred.includes(`${m.providerId}:${m.modelId}`)}
                  onSelect={() => setSelected(m.providerId, m.modelId)}
                  onToggleStar={() => toggleStar(m.providerId, m.modelId)}
                />
              ))}
            </DropdownMenuGroup>
          ))}

          {/* ── Empty states ── */}
          {filtered.length === 0 && q && !isLoading && (
            <div className="px-2 py-3 text-[11px] text-muted-foreground/60 text-center">
              No models match "{query}".
            </div>
          )}
          {isLoading && models.length === 0 && (
            <div className="px-2 py-3 text-[11px] text-muted-foreground/60 text-center flex items-center justify-center gap-1.5">
              <Loader2 className="size-3 animate-spin" /> Loading models…
            </div>
          )}
          {!isLoading && models.length === 0 && (
            <div className="px-2 py-3 text-[11px] text-muted-foreground/60 text-center">
              No models configured.
              <br />
              Add a provider in Onboarding or Settings.
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A single model row — star toggle, alias, brain icon, context, check mark. */
function ModelRow({
  model,
  priceLabel,
  selected,
  isStarred,
  onSelect,
  onToggleStar,
}: {
  model: ModelOption;
  /** Catalog price rate, e.g. "$3 / $15 per Mtok". Undefined = no catalog data. */
  priceLabel?: string;
  selected: boolean;
  isStarred: boolean;
  onSelect: () => void;
  onToggleStar: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onSelect}
      className="gap-2 py-2 cursor-pointer overflow-hidden"
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleStar(); }}
        className="text-muted-foreground/40 hover:text-warning shrink-0"
        title={isStarred ? 'Unstar' : 'Star'}
      >
        <Star className={cn('size-4', isStarred && 'fill-current text-warning')} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-[0.9rem] font-medium flex items-center gap-1.5 truncate">
          <span className="truncate">{model.alias}</span>
          {model.reasoning && <Brain className="size-3 text-reasoning" />}
        </div>
        <div className="text-[0.75rem] text-muted-foreground/60 truncate">
          {formatContext(model.contextWindow)} ctx{priceLabel ? ` · ${priceLabel}` : ''}
        </div>
      </div>
      {selected && <Check className="size-5 text-primary shrink-0" />}
    </DropdownMenuItem>
  );
}
