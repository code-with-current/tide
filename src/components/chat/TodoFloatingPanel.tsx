import { useState, useEffect } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useTodos } from '@/hooks/useTodos';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** Floating todo panel: top-right of chat column, collapsible, auto-collapses when all done and re-expands on new in-progress task. Renders null when no todos. */
export function TodoFloatingPanel({ sessionId }: { sessionId: string | null | undefined }) {
  const todos = useTodos(sessionId);
  const [collapsed, setCollapsed] = useState(false);

  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const inProgress = todos.find((t) => t.status === 'in_progress');

  // Auto-collapse once everything is done, auto-expand when work resumes.
  useEffect(() => {
    if (total > 0 && done === total) setCollapsed(true);
    if (inProgress) setCollapsed(false);
  }, [total, done, inProgress]);

  if (total === 0) return null;

  return (
    <div className="absolute top-3 right-3 z-20 w-64 max-h-[60vh] flex flex-col pointer-events-auto">
      <div
        className="rounded-xl border border-white/10 shadow-lg backdrop-blur-md overflow-hidden animate-slide-up"
        style={{ background: 'color-mix(in srgb, var(--background) 78%, transparent)' }}
      >
        {/* Header — always visible. Click to collapse/expand. */}
        <Button
          variant="ghost"
          onClick={() => setCollapsed((c) => !c)}
          className="w-full px-3 py-2 flex items-center gap-2 text-left transition-colors"
        >
          <span className="text-[11px] font-semibold text-foreground/90 uppercase tracking-wider">
            Tasks
          </span>
          <span className="text-[10px] text-white/50 font-mono">
            {done}/{total}
          </span>
          {/* Progress bar */}
          <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden min-w-[24px]">
            <div
              className="h-full bg-primary/80 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <ChevronDown
            className={cn('size-3 text-white/60 transition-transform', !collapsed && '-rotate-180')}
          />
        </Button>

        {/* Body — the todo rows. */}
        {!collapsed && (
          <div className="max-h-[50vh] overflow-y-auto scroll px-2 pb-2 pt-0.5 border-t border-white/5 animate-slide-up">
            {todos.map((t, i) => {
              const isDone = t.status === 'completed';
              const isActive = t.status === 'in_progress';
              return (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-2 px-1.5 py-1.5 rounded-md text-[12px] leading-snug transition-colors',
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
                          <Check className="size-2 text-black" strokeWidth={3} />
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
    </div>
  );
}
