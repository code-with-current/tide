import { useState, useEffect, useMemo, useRef } from 'react';
import { Check, ChevronDown, Loader2, Circle, Minus } from 'lucide-react';
import { useSessionTodos, type TodoItem } from '@/hooks/use-todos';
import { useUi } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';

/** Floating todo panel: a single live list (the source of truth) with an
 *  overall progress header. Auto-expands while work is in flight; collapses
 *  to a compact bar once everything is completed/cancelled. */
export function TodoFloatingPanel({ sessionId }: { sessionId: string | null | undefined }) {
  const todos = useSessionTodos(sessionId);
  const setDismissedTodo = useUi((s) => s.setDismissedTodo);
  const dismissedSignature = useUi((s) => (sessionId ? s.dismissedTodoSignatures[sessionId] : undefined));
  const [collapsed, setCollapsed] = useState(false);

  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const cancelled = todos.filter((t) => t.status === 'cancelled').length;
  const active = todos.find((t) => t.status === 'in_progress');
  const open = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress').length;
  const settled = total > 0 && open === 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // A todo update while collapsed force-expands; settling (all done)
  // force-expands for the completion review. Dismissal is derived from the
  // persisted store record: the panel stays hidden across session switches
  // and restarts until the todo list changes again (new signature).
  const signature = useMemo(() => todos.map((t) => `${t.status}:${t.content}`).join('|'), [todos]);
  const dismissed = dismissedSignature !== undefined && dismissedSignature === signature;
  const prevSignature = useRef(signature);
  useEffect(() => {
    if (signature === prevSignature.current) return;
    prevSignature.current = signature;
    setCollapsed(false);
  }, [signature]);

  if (total === 0 || dismissed) return null;

  const headline = active
    ? (active.content.length > 42 ? active.content.slice(0, 39) + '…' : active.content)
    : settled
      ? (done === total ? 'All tasks done' : 'Tasks complete')
      : `${open} remaining`;

  return (
    <div className="todo-floating-panel absolute top-3 right-3 z-[50] w-90 max-w-[calc(100%-1.5rem)] max-h-[60vh] flex flex-col pointer-events-auto">
      <div
        className="border border-white/10 shadow-lg backdrop-blur-md overflow-hidden rounded-xl"
        style={{ background: 'color-mix(in srgb, var(--background) 78%, transparent)' }}
      >
        {/* Header — overall progress + click to toggle. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="w-full px-3 py-2 flex items-center gap-2 border-b border-white/10 transition-colors hover:bg-white/[0.03]"
        >
          {active && <Loader2 className="size-3 text-info animate-spin flex-shrink-0" />}
          <span className="text-[0.7857rem] font-semibold text-foreground/90 uppercase tracking-wider flex-shrink-0">
            Tasks
          </span>
          <span className="text-[0.75rem] font-medium truncate flex-1 min-w-0 text-left text-foreground/70 normal-case tracking-normal">
            {headline}
          </span>
          <span className="text-[0.7143rem] text-white/50 font-mono flex-shrink-0">{pct}%</span>
          <div className="w-16 h-1 rounded-full bg-white/10 overflow-hidden flex-shrink-0">
            <div
              className={cn('h-full transition-all duration-300', pct === 100 ? 'bg-success/80' : 'bg-primary/80')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <ChevronDown className={cn('size-3 text-white/40 transition-transform flex-shrink-0', collapsed && '-rotate-90')} />
        </button>

        {/* List. Scrolls independently so a long plan doesn't overflow the
            viewport — the header (progress + toggle) stays pinned above. */}
        {!collapsed && (
          <div className="px-2 py-1.5 flex flex-col overflow-y-auto max-h-[40vh] scroll">
            {todos.map((t, i) => (
              <TodoRow key={i} item={t} />
            ))}
            {cancelled > 0 && (
              <div className="px-1.5 pt-1 text-[0.7143rem] text-white/30 font-mono">
                {done}/{total} done · {cancelled} cancelled
              </div>
            )}
          </div>
        )}

        {/* Completion footer — embedded flush to the panel's bottom edge
            (the container clips it into the rounded corners). */}
        {!collapsed && settled && (
          <button
            type="button"
            onClick={() => sessionId && setDismissedTodo(sessionId, signature)}
            className="w-full px-3 py-2 flex items-center justify-center gap-1.5 border-t border-white/10 text-[0.75rem] font-semibold uppercase tracking-wider text-white/50 hover:text-foreground hover:bg-success/10 transition-colors"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  const isDone = item.status === 'completed';
  const isActive = item.status === 'in_progress';
  const isCancelled = item.status === 'cancelled';
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-1.5 py-1 rounded-md text-[0.8214rem] leading-snug transition-colors',
        isActive && 'bg-info/10',
      )}
    >
      <span className="mt-0.5 flex-shrink-0">
        {isDone ? (
          <span className="size-3.5 rounded-full bg-success/80 flex items-center justify-center">
            <Check className="size-2 text-white" strokeWidth={3} />
          </span>
        ) : isActive ? (
          <Loader2 className="size-3.5 text-info animate-spin" />
        ) : isCancelled ? (
          <span className="size-3.5 rounded-full bg-white/5 flex items-center justify-center">
            <Minus className="size-2 text-white/40" strokeWidth={3} />
          </span>
        ) : (
          <Circle className="size-2.5 text-muted-foreground/40 mt-1" />
        )}
      </span>
      <span
        className={cn(
          'flex-1 min-w-0 line-clamp-2 break-words leading-snug',
          isDone ? 'text-white/40 line-through' : isActive ? 'text-foreground' : isCancelled ? 'text-white/30 line-through' : 'text-white/70',
        )}
      >
        {item.content}
      </span>
      {item.priority === 'high' && !isDone && !isCancelled && (
        <span className="text-[0.6429rem] font-mono uppercase text-destructive/80 flex-shrink-0 mt-0.5">
          high
        </span>
      )}
    </div>
  );
}
