import { useState, useEffect, useRef } from 'react';
import { Check, ChevronDown, Loader2, Circle } from 'lucide-react';
import { useTodoGroups, type TodoGroup } from '@/hooks/useTodos';
import { cn } from '@/lib/utils';

/** Floating todo panel: stacked collapsible cards, one per todo group. Active group expands; completed groups collapse to a bar. */
export function TodoFloatingPanel({ sessionId }: { sessionId: string | null | undefined }) {
  const groups = useTodoGroups(sessionId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [userTouched, setUserTouched] = useState(false);

  // Auto-expand the active group (has an in_progress item).
  // Only fires when the ACTIVE GROUP ID changes — not on every status tick.
  // Once the user manually toggles, stop auto-managing until a new group becomes active.
  const activeId = groups.find((g) => g.items.some((t) => t.status === 'in_progress'))?.id ?? null;
  const prevActiveId = useRef<string | null>(null);

  useEffect(() => {
    // A different group became active → auto-expand it, reset user override.
    if (activeId && activeId !== prevActiveId.current) {
      setExpandedId(activeId);
      setUserTouched(false);
    }
    // Active group went away (all done) and user hasn't manually expanded something → collapse.
    if (!activeId && prevActiveId.current && !userTouched) {
      setExpandedId(null);
    }
    prevActiveId.current = activeId;
  }, [activeId, userTouched]);

  const handleToggle = (id: string) => {
    setUserTouched(true);
    setExpandedId(expandedId === id ? null : id);
  };

  if (groups.length === 0) return null;

  // Aggregate stats across all groups.
  const allItems = groups.flatMap((g) => g.items ?? []);
  const totalDone = allItems.filter((t) => t.status === 'completed').length;
  const totalAll = allItems.length;
  const overallPct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0;
  const hasActive = allItems.some((t) => t.status === 'in_progress');

  return (
    <div className="absolute top-3 right-3 z-[1] w-90 max-h-[60vh] flex flex-col pointer-events-auto">
      <div
        className="border border-white/10 shadow-lg backdrop-blur-md overflow-hidden rounded-xl"
        style={{ background: 'color-mix(in srgb, var(--background) 78%, transparent)' }}
      >
        {/* Main header — overall session progress across all groups. */}
        <div className="px-3 py-2 flex items-center justify-between gap-2 border-b border-white/10">
          {hasActive && <Loader2 className="size-3 text-info animate-spin flex-shrink-0" />}
          <span className="text-[11px] flex-1 font-semibold text-foreground/90 uppercase tracking-wider">
            Tasks
          </span>
          <div className="flex flex-1 items-center justify-end gap-1">
          <span className="text-[10px] text-white/50 font-mono flex-shrink-0">
            {overallPct}%
          </span>
          <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden max-w-24">
            <div
              className={cn(
                'h-full transition-all duration-300',
                overallPct === 100 ? 'bg-success/80' : 'bg-primary/80',
              )}
              style={{ width: `${overallPct}%` }}
            />
          </div>
          </div>
        </div>

        {/* Group cards — stacked, no gap. */}
        <div className="flex flex-col">
          {groups.map((group, i) => (
            <TodoCard
              key={group.id}
              group={group}
              expanded={expandedId === group.id}
              onToggle={() => handleToggle(group.id)}
              isLast={i === groups.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TodoCard({ group, expanded, onToggle, isLast }: { group: TodoGroup; expanded: boolean; onToggle: () => void; isLast: boolean }) {
  const items = group.items ?? [];
  const total = items.length;
  const done = items.filter((t) => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const inProgress = items.find((t) => t.status === 'in_progress');
  const allDone = total > 0 && done === total;
  const hasStarted = done > 0 || !!inProgress;

  // Dynamic title: in-progress task while working, group title when done/pending.
  const title = inProgress
    ? inProgress.content.length > 40
      ? inProgress.content.slice(0, 37) + '…'
      : inProgress.content
    : group.title;

  return (
    <div className={cn(!isLast && 'border-b border-white/5')}>
      {/* Group header bar — click to expand/collapse. */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-left transition-colors hover:bg-white/[0.03]"
      >
        {/* Status icon */}
        {allDone ? (
          <span className="size-3 rounded-full bg-success/80 flex items-center justify-center flex-shrink-0">
            <Check className="size-1.5 text-white" strokeWidth={3} />
          </span>
        ) : inProgress ? (
          <Loader2 className="size-3 text-info animate-spin flex-shrink-0" />
        ) : (
          <Circle className="size-2.5 text-muted-foreground/40 flex-shrink-0" />
        )}

        {/* Title */}
        <span className={cn(
          'text-[10.5px] font-medium truncate flex-1 min-w-0',
          inProgress ? 'text-info' : allDone ? 'text-success/70' : 'text-foreground/80',
        )}>
          {title}
        </span>

        {/* Count + percentage */}
        <span className="text-[10px] text-white/40 font-mono flex-shrink-0">
          {done}/{total}
        </span>

        {/* Progress bar */}
        <div className="w-12 h-0.5 rounded-full bg-white/10 overflow-hidden flex-shrink-0">
          <div
            className={cn(
              'h-full transition-all duration-300',
              allDone ? 'bg-success/80' : hasStarted ? 'bg-primary/80' : 'bg-muted-foreground/30',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>

        <ChevronDown
          className={cn('size-3 text-white/40 transition-transform flex-shrink-0', expanded && '-rotate-180')}
        />
      </button>

      {/* Body — the todo rows. Flush with the header, no extra border. */}
      {expanded && (
        <div className="px-3 pb-2 pt-0.5">
          {items.map((t, i) => {
            const isDone = t.status === 'completed';
            const isActive = t.status === 'in_progress';
            return (
              <div
                key={i}
                className={cn(
                  'flex items-start gap-2 px-1.5 py-1 rounded-md text-[11.5px] leading-snug transition-colors',
                  isActive && 'bg-info/10',
                )}
              >
                {/* Status marker */}
                <span className="mt-0.5 flex-shrink-0">
                  {isDone ? (
                    <span className="size-3.5 rounded-full bg-success/80 flex items-center justify-center">
                      <Check className="size-2 text-white" strokeWidth={3} />
                    </span>
                  ) : isActive ? (
                    <Loader2 className="size-3.5 text-info animate-spin" />
                  ) : (
                    <span className="size-3.5 rounded-full bg-gray-600/80 flex items-center justify-center">
                      <Check className="size-2 text-black/40" strokeWidth={3} />
                    </span>
                  )}
                </span>
                {/* Content */}
                <span
                  className={cn(
                    'flex-1',
                    isDone ? 'text-white/40 line-through' : isActive ? 'text-foreground' : 'text-white/70',
                  )}
                >
                  {t.content}
                </span>
                {/* Priority flag */}
                {t.priority === 'high' && !isDone && (
                  <span className="text-[9px] font-mono uppercase text-destructive/80 flex-shrink-0 mt-0.5">
                    high
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
