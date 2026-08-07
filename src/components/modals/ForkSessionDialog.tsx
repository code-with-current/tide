/** Fork-session dialog: creates a new session carrying a summary of the source conversation. The source session is preserved unchanged. */
import { useState, useMemo, useEffect } from 'react';
import { GitFork, Loader2, Search, Check, Star, Brain } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useModels, useForkSession } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { cn, formatContext } from '@/lib/utils';
import type { ModelOption } from '@/lib/queries';

export function ForkSessionDialog({
  open,
  onOpenChange,
  sourceSessionId,
  sourceTitle,
  sourceModelId,
  sourceProviderId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceSessionId: string;
  sourceTitle: string;
  /** Pre-select the source session's model in the picker. */
  sourceModelId?: string;
  sourceProviderId?: string;
}) {
  const workspaceId = useUi((s) => s.activeWorkspaceId) ?? '';
  const { models, isLoading } = useModels();
  const fork = useForkSession(workspaceId);
  const setSelected = useUi((s) => s.setSelectedModel);
  const starred = useUi((s) => s.starredModels);
  const toggleStar = useUi((s) => s.toggleStarredModel);
  const [query, setQuery] = useState('');

  // Pre-select the source model on open.
  const [picked, setPicked] = useState<ModelOption | null>(null);
  useEffect(() => {
    if (open && sourceModelId && !picked) {
      const match =
        models.find((m) => m.providerId === sourceProviderId && m.modelId === sourceModelId) ??
        models.find((m) => m.modelId === sourceModelId);
      if (match) setPicked(match);
    }
    if (!open) setPicked(null);
  }, [open, sourceModelId, sourceProviderId, models, picked]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.alias.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q),
    );
  }, [models, query]);

  const byProvider = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const m of filtered) {
      const list = map.get(m.providerName) ?? [];
      list.push(m);
      map.set(m.providerName, list);
    }
    return [...map.entries()];
  }, [filtered]);

  function handleFork() {
    if (!picked) return;
    fork.mutate(
      { sourceId: sourceSessionId, newModelId: picked.modelId, opts: { providerId: picked.providerId } },
      {
        onSuccess: () => {
          setSelected(picked.providerId, picked.modelId);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitFork className="size-4" /> Fork session
          </DialogTitle>
          <DialogDescription>
            Creates a new session with a summary of <span className="font-medium text-foreground">"{sourceTitle}"</span>.
            The original is preserved unchanged.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border border-border/60 rounded-md">
          <Search className="size-4 text-muted-foreground/50 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="w-full bg-transparent border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground/50"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="text-muted-foreground/50 hover:text-foreground shrink-0">✕</button>
          )}
        </div>

        {/* Model list */}
        <div className="max-h-[300px] overflow-y-auto border border-border/60 rounded-md">
          {isLoading && models.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground/60 text-center flex items-center justify-center gap-1.5">
              <Loader2 className="size-3 animate-spin" /> Loading models…
            </div>
          )}
          {byProvider.map(([providerName, providerModels]) => (
            <div key={providerName}>
              <div className="text-[11px] text-muted-foreground/60 uppercase tracking-wider px-2 py-1 sticky top-0 bg-popover/95 border-b border-border/40">
                {providerName}
              </div>
              {providerModels.map((m) => {
                const isStarred = starred.includes(`${m.providerId}:${m.modelId}`);
                const isPicked = picked?.providerId === m.providerId && picked?.modelId === m.modelId;
                return (
                  <button
                    key={`${m.providerId}:${m.modelId}`}
                    type="button"
                    onClick={() => setPicked(m)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-2 text-left hover:bg-accent/50 transition-colors',
                      isPicked && 'bg-accent',
                    )}
                  >
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleStar(m.providerId, m.modelId); }}
                      className="text-muted-foreground/40 hover:text-warning shrink-0"
                    >
                      <Star className={cn('size-4', isStarred && 'fill-current text-warning')} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium flex items-center gap-1.5 truncate">
                        <span className="truncate">{m.alias}</span>
                        {m.reasoning && <Brain className="size-3 text-reasoning" />}
                      </div>
                      <div className="text-[0.7rem] text-muted-foreground/60 truncate">
                        {formatContext(m.contextWindow)} ctx{m.priceLabel ? ` · ${m.priceLabel}` : ''}
                      </div>
                    </div>
                    {isPicked && <Check className="size-4 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
          {!isLoading && filtered.length === 0 && (
            <div className="px-3 py-4 text-sm text-muted-foreground/60 text-center">
              No models match "{query}".
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={fork.isPending}>
            Cancel
          </Button>
          <Button onClick={handleFork} disabled={!picked || fork.isPending}>
            {fork.isPending ? (
              <><Loader2 className="size-4 animate-spin" /> Summarizing…</>
            ) : (
              <><GitFork className="size-4" /> Fork</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
