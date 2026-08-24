/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/StatusRow.tsx — ADAPTED (Ruling 4).
 *  Adaptations:
 *  - Todos come from a `todos` prop (Tide todo_write payload: {content, status, id?}) —
 *    upstream read live/persisted sync stores. Tide's todo shape has no `priority`, so
 *    the priority icon column and its tooltips are dropped.
 *  - Todo status vocabulary stays 'in_progress' | 'pending' | 'completed' | 'cancelled'
 *    (that IS Tide's todo_write status union; OpenCode tool statuses never appear).
 *  - Dropped: mobile/VSCode abort button (showAbort/onAbort) + isCompact variants,
 *    session stores, useI18n (literal English), `@/lib/desktop` isVSCodeRuntime.
 *  - WorkingPlaceholder comes from the ported ../message/parts/working-placeholder.
 *  - Tooltip → Tide shadcn; container-query sizing (cqw) kept as upstream. */

import React from 'react';
import { cn } from '@/lib/utils';
import { WorkingPlaceholder } from './message/parts/working-placeholder';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from './icon';

const STATUS_ROW_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'status-row' };

export interface StatusRowTodo {
  id?: string;
  content: string;
  status: string;
}

const statusConfig: Record<string, { textClassName: string }> = {
  in_progress: {
    textClassName: 'text-foreground',
  },
  pending: {
    textClassName: 'text-foreground',
  },
  completed: {
    textClassName: 'text-muted-foreground line-through',
  },
  cancelled: {
    textClassName: 'text-muted-foreground line-through',
  },
};

const statusLabel: Record<string, string> = {
  in_progress: 'In progress',
  pending: 'Pending',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

interface TodoItemRowProps {
  todo: StatusRowTodo;
}

const TodoItemRow: React.FC<TodoItemRowProps> = ({ todo }) => {
  const config = statusConfig[todo.status] || statusConfig.pending;
  const label = statusLabel[todo.status] ?? statusLabel.pending;

  const statusIcon =
    todo.status === 'in_progress' ? (
      <Icon name="record-circle" className="h-3.5 w-3.5 text-[var(--status-info)]" aria-hidden="true" />
    ) : todo.status === 'completed' ? (
      <Icon name="checkbox-circle" className="h-3.5 w-3.5 text-[var(--status-success)]" aria-hidden="true" />
    ) : (
      <Icon name="time" className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    );

  return (
    <div className="flex items-center min-w-0 py-0.5 gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex-shrink-0">{statusIcon}</span>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
      <span className={cn('flex-1 typography-ui-label', config.textClassName)}>
        {todo.content}
      </span>
    </div>
  );
};

const EMPTY_TODOS: StatusRowTodo[] = [];

interface StatusRowProps {
  isWorking?: boolean;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  wasAborted?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  showAbortStatus?: boolean;
  showAssistantStatus?: boolean;
  showTodos?: boolean;
  todos?: StatusRowTodo[];
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
  leftAccessory?: React.ReactNode;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  statusText = null,
  isGenericStatus,
  isWaitingForPermission,
  wasAborted,
  abortActive,
  retryInfo,
  showAbortStatus,
  showAssistantStatus = true,
  showTodos = true,
  todos = EMPTY_TODOS,
  agentName,
  modelName,
  providerId,
  leftAccessory,
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);

  // Filter out cancelled todos for display and keep original order.
  // This prevents items from jumping around when status changes.
  const visibleTodos = React.useMemo(() => {
    return todos.filter((todo) => todo.status !== 'cancelled');
  }, [todos]);

  // Find the current active todo (first in_progress, or first pending)
  const activeTodo = React.useMemo(() => {
    return (
      visibleTodos.find((t) => t.status === 'in_progress') ||
      visibleTodos.find((t) => t.status === 'pending') ||
      null
    );
  }, [visibleTodos]);

  const progress = React.useMemo(() => {
    const total = todos.filter((t) => t.status !== 'cancelled').length;
    const completed = todos.filter((t) => t.status === 'completed').length;
    return { completed, total };
  }, [todos]);

  const statusSummary = React.useMemo(() => {
    const active = visibleTodos.filter((t) => t.status === 'in_progress').length;
    const left = visibleTodos.filter((t) => t.status === 'in_progress' || t.status === 'pending').length;
    return { active, left };
  }, [visibleTodos]);

  const hasTodoContent = showTodos && statusSummary.left > 0;
  const hasAssistantContent = showAssistantStatus && (
    isWorking ||
    Boolean(wasAborted) ||
    Boolean(showAbortStatus)
  );
  const hasLeftAccessory = Boolean(leftAccessory);
  const shouldRenderPlaceholder = !showAbortStatus && (wasAborted || !abortActive);

  const hasContent = hasAssistantContent || hasTodoContent || hasLeftAccessory;

  // Close popover when clicking outside
  const popoverRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isExpanded]);

  const toggleExpanded = () => setIsExpanded((prev) => !prev);
  const todoSummaryLabel = `${statusSummary.active} active · ${statusSummary.left} left`;

  // Todo trigger button
  const todoTrigger = hasTodoContent ? (
    <button
      type="button"
      onClick={toggleExpanded}
      className="flex items-center gap-1 flex-shrink-0 text-muted-foreground"
      aria-label={todoSummaryLabel}
      title={todoSummaryLabel}
    >
      {activeTodo ? (
        <span className="status-row__active-todo typography-ui-label text-foreground truncate max-w-[200px]">
          {activeTodo.content}
        </span>
      ) : (
        <span className="typography-ui-label">Tasks</span>
      )}
      <span className="typography-meta flex items-center gap-1 tabular-nums" aria-hidden="true">
        <span className="flex items-center gap-0.5">
          <Icon name="record-circle" className="h-3.5 w-3.5 text-[var(--status-info)]" />
          {statusSummary.active}
        </span>
        <span>·</span>
        <span className="flex items-center gap-0.5">
          <Icon name="time" className="h-3.5 w-3.5" />
          {statusSummary.left}
        </span>
      </span>
      {isExpanded ? (
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
      ) : (
        <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
      )}
    </button>
  ) : null;

  // Don't render if nothing to show
  if (!hasContent) {
    return null;
  }

  return (
    <div
      // mb-6 reserves the ~12px of structure the finished message carries below its
      // footer, so this row and the turn footer land on the same line (upstream note).
      className={cn('mb-6', !hasLeftAccessory && 'chat-column')}
      style={STATUS_ROW_CONTAINER_STYLE}
    >
      {/* h-8 matches the turn footer's real row height: its h-8 action
          buttons define the footer line, with the meta text centered in it. */}
      <div className={cn('flex items-center justify-between gap-2 h-8', hasLeftAccessory && 'px-0.5')}>
        {/* Left: Abort status | Working placeholder | leftAccessory */}
        <div className={cn('flex-1 flex items-center min-w-0 gap-2', hasLeftAccessory ? 'pl-1.5' : 'overflow-x-hidden')}>
          {showAssistantStatus && showAbortStatus ? (
            <div className="flex h-full items-center text-[var(--status-error)] pl-0.5">
              <span className="flex items-center gap-1.5 typography-ui-label">
                <Icon name="close-circle" aria-hidden="true" />
                Aborted
              </span>
            </div>
          ) : showAssistantStatus && shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              isWorking={isWorking}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              agentName={agentName}
              modelName={modelName}
              providerId={providerId}
            />
          ) : leftAccessory ? (
            leftAccessory
          ) : null}
        </div>

        {/* Right: Todo trigger + popover */}
        <div
          className={cn('relative flex items-center gap-2 flex-shrink-0', hasLeftAccessory ? 'pr-1.5' : '-mr-3')}
          ref={popoverRef}
        >
          {todoTrigger}

          {isExpanded && hasTodoContent && (
            <div
              style={{
                maxWidth: 'min(28rem, calc(100cqw - 4ch))',
                backgroundColor: 'var(--surface-elevated)',
                color: 'var(--surface-elevated-foreground)',
              }}
              className={cn(
                'absolute right-0 bottom-full mb-1 z-50',
                'w-max min-w-[200px] rounded-xl p-1',
                'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)]',
                'dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]',
                'animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2',
                'duration-150',
              )}
            >
              <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
                <span>Tasks</span>
                <span className="typography-meta tabular-nums">
                  {progress.completed}/{progress.total}
                </span>
              </div>

              <div className="px-1 max-h-[200px] overflow-y-auto">
                {visibleTodos.map((todo, index) => (
                  <TodoItemRow key={todo.id ?? `todo-${index}`} todo={todo} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
