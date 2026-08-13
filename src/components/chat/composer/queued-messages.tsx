/**
 * QueuedMessages — outgoing message queue rendered above the composer.
 *
 * Simple informational layout using base shadcn components:
 *  • Header: badge with count + status text + clear button
 *  • List: drag-reorderable items with edit / send-now / remove actions
 *  • Each item is a compact single-line preview (expandable via edit)
 *
 * Auto-drains when a turn finishes (wired in MainScreen's freeze effect).
 * "Send now" aborts the current turn and force-sends immediately.
 */

import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X, Pencil, Send, Clock, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUi, type QueuedMessage } from '@/lib/stores/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const EMPTY_QUEUE: QueuedMessage[] = [];

export function QueuedMessages({
  sessionId,
  inProgress,
  onSendItem,
  onSendNow,
}: {
  sessionId: string;
  inProgress: boolean;
  onSendItem: (text: string, promptText?: string) => void;
  onSendNow?: (text: string, promptText?: string) => void;
}) {
  const queue = useUi((s) => s.queue[sessionId] ?? EMPTY_QUEUE);
  const remove = useUi((s) => s.removeQueuedMessage);
  const reorder = useUi((s) => s.reorderQueuedMessages);
  const clear = useUi((s) => s.clearQueuedMessages);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  if (queue.length === 0) return null;

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = queue.map((m) => m.id);
    const from = ids.indexOf(active.id as string);
    const to = ids.indexOf(over.id as string);
    reorder(sessionId, arrayMove(ids, from, to));
  };

  return (
    <div className="mb-2 rounded-lg border border-border bg-secondary/40">
      {/* Header — badge + status + clear */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Badge variant="secondary" className="gap-1">
          <Clock className="size-2.5" />
          {queue.length}
        </Badge>
        <span className="text-[11px] text-muted-foreground">
          {inProgress ? 'Queued — Sends when the current turn finishes' : 'Queued — Sends on next turn'}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => clear(sessionId)}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3" />
          Clear
        </Button>
      </div>

      {/* Sortable list */}
      <div className="p-1.5">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={queue.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1">
              {queue.map((m, i) => (
                <SortableItem
                  key={m.id}
                  item={m}
                  index={i}
                  onRemove={() => remove(sessionId, m.id)}
                  onEdit={(text) => useUi.getState().editQueuedMessage(sessionId, m.id, text)}
                  onSendNow={() => {
                    if (inProgress && onSendNow) {
                      onSendNow(m.text, m.promptText);
                    } else {
                      remove(sessionId, m.id);
                      onSendItem(m.text, m.promptText);
                    }
                  }}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

function SortableItem({
  item,
  index,
  onRemove,
  onEdit,
  onSendNow,
}: {
  item: QueuedMessage;
  index: number;
  onRemove: () => void;
  onEdit: (text: string) => void;
  onSendNow: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5',
        isDragging && 'shadow-md border-accent/30',
      )}
    >
      {/* Drag handle */}
      <Button
        variant="ghost"
        size="icon"
        {...attributes}
        {...listeners}
        className="size-5 text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="size-3" />
      </Button>

      {/* Position number */}
      <span className="text-[10px] font-mono text-muted-foreground/40 tabular-nums w-3 text-center flex-shrink-0">
        {index + 1}
      </span>

      {/* Text / editor */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            rows={Math.min(5, Math.max(1, Math.ceil(draft.length / 60)))}
            className="w-full rounded border border-border bg-secondary px-2 py-1 text-xs resize-none outline-none focus:border-accent"
          />
        ) : (
          <div className="text-xs text-muted-foreground leading-relaxed line-clamp-2 whitespace-pre-wrap break-words">
            {item.text}
          </div>
        )}
      </div>

      {/* Actions — appear on hover */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { if (draft !== item.text) onEdit(draft); setEditing(false); }}
              className="size-6 text-primary hover:text-primary"
              title="Save"
            >
              <Send className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { setDraft(item.text); setEditing(false); }}
              className="size-6 text-muted-foreground hover:text-foreground"
              title="Cancel"
            >
              <X className="size-3" />
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setEditing(true)}
              className="size-6 text-muted-foreground hover:text-foreground"
              title="Edit"
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onSendNow}
              className="size-6 text-muted-foreground hover:text-primary"
              title="Send now — jumps the queue"
            >
              <Send className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRemove}
              className="size-6 text-muted-foreground hover:text-destructive"
              title="Remove"
            >
              <X className="size-3" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
