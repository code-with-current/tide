import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ExtensionRow } from './ExtensionRow';

/** Common shape produced by both listAgents and listSkills IPC. */
export interface ExtensionItem {
  name: string;
  description: string;
  source: 'builtin' | 'project' | 'user';
  enabled: boolean;
  path?: string;
}

export interface ExtensionGroup {
  label: string;
  items: ExtensionItem[];
}

interface ExtensionListProps {
  groups: ExtensionGroup[];
  /** Items per page within each card. Default 10. */
  pageSize?: number;
  /** Signature for per-item badges (e.g. collision warnings, active state). */
  onToggle: (name: string, enabled: boolean) => void;
  onReveal?: (path: string) => void;
  renderBadges?: (item: ExtensionItem) => ReactNode;
  /** Changes to this value reset all pages to 1 (e.g. the search query). */
  resetKey?: string;
}

/** Shared card-wrapped, paginated list for Extensions settings. Each group renders as its own card with independent pagination; pages reset on `resetKey` change. */
export function ExtensionList({
  groups,
  pageSize = 10,
  onToggle,
  onReveal,
  renderBadges,
  resetKey = '',
}: ExtensionListProps) {
  // Per-group page state: { [groupLabel]: pageNumber }. Start at 1 for each.
  const [pages, setPages] = useState<Record<string, number>>({});
  const pageFor = (label: string) => pages[label] ?? 1;
  const setPage = (label: string, p: number) => setPages((prev) => ({ ...prev, [label]: p }));

  // Reset all pages to 1 when the search filter changes.
  useEffect(() => {
    setPages({});
  }, [resetKey]);

  // Also reset a specific group's page if it's out of range after filtering.
  useEffect(() => {
    setPages((prev) => {
      const next = { ...prev };
      for (const g of groups) {
        const maxPage = Math.max(1, Math.ceil(g.items.length / pageSize));
        if ((next[g.label] ?? 1) > maxPage) next[g.label] = maxPage;
      }
      return next;
    });
  }, [groups, pageSize]);

  const visibleGroups = groups.filter((g) => g.items.length > 0);

  if (visibleGroups.length === 0) {
    return (
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground/70">
            {resetKey ? 'No items match your filter.' : 'Nothing installed.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {visibleGroups.map((group) => (
        <ExtensionCard
          key={group.label}
          group={group}
          pageSize={pageSize}
          page={pageFor(group.label)}
          onPageChange={(p) => setPage(group.label, p)}
          onToggle={onToggle}
          onReveal={onReveal}
          renderBadges={renderBadges}
        />
      ))}
    </div>
  );
}

function ExtensionCard({
  group,
  pageSize,
  page,
  onPageChange,
  onToggle,
  onReveal,
  renderBadges,
}: {
  group: ExtensionGroup;
  pageSize: number;
  page: number;
  onPageChange: (p: number) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onReveal?: (path: string) => void;
  renderBadges?: (item: ExtensionItem) => ReactNode;
}) {
  const { items, label } = group;
  const totalPages = Math.ceil(items.length / pageSize);
  const showPagination = totalPages > 1;

  const paged = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  const rangeStart = (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, items.length);

  return (
    <div className="rounded-lg bg-card border border-border overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/60">
        <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground/60 font-medium">
          {label}
        </h3>
        <span className="text-[10px] text-muted-foreground/50 font-mono tabular-nums">
          {items.length}
        </span>
      </div>

      {/* Rows */}
      <div className="divide-y divide-border/30">
        {paged.map((item) => (
          <ExtensionRow
            key={item.name}
            name={item.name}
            description={item.description}
            source={item.source}
            enabled={item.enabled}
            onToggle={(en) => onToggle(item.name, en)}
            onReveal={onReveal && item.path ? () => onReveal(item.path!) : undefined}
            badges={renderBadges?.(item)}
          />
        ))}
      </div>

      {/* Pagination footer */}
      {showPagination && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-border/60 bg-muted/20">
          <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums">
            Showing {rangeStart}–{rangeEnd} of {items.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-default"
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums min-w-[3rem] text-center">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              aria-label="Next page"
              className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-default"
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
