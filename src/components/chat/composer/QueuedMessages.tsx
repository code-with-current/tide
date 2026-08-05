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

/** Outgoing message queue above the composer. Drag-reorderable; per-item edit/send-now/remove actions. */

/** Module-level stable empty array — never re-create the fallback, or
 *  Zustand's useSyncExternalStore sees a "new" snapshot every render and
 *  triggers an infinite re-render loop. */
const EMPTY_QUEUE: QueuedMessage[] = [];

export function QueuedMessages({
  sessionId,
  inProgress,
  onSendItem,
}: {
  sessionId: string;
  /** When false, the queue will auto-drain — parent should call onSendItem for each. */
  inProgress: boolean;
  /** Send a single queued item now (e.g. user clicked send-now, or drain). */
  onSendItem: (text: string) => void;
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
    <div className="mb-2 rounded-md border border-border bg-secondary/60 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-input text-[11px] text-muted-foreground/60">
        <Clock className="size-3" />
        <span className="font-medium text-muted-foreground">Queued</span>
        <span>· {queue.length === 1 ? '1 message' : `${queue.length} messages`}</span>
        <span>·</span>
        <span>
          {inProgress
            ? 'will send when the current turn finishes'
            : 'will send on the next turn'}
        </span>
        <div className="flex-1" />
        <Button
          onClick={() => clear(sessionId)}
          title="Clear queue"
          className="flex items-center gap-1 hover:text-destructive text-muted-foreground/60 px-1.5 py-0.5 rounded"
        >
          <Trash2 className="size-3" /> Clear
        </Button>
      </div>

      {/* Sortable list */}
      <div className="p-1.5">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={queue.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5">
              {queue.map((m) => (
                <SortableItem
                  key={m.id}
                  item={m}
                  onRemove={() => remove(sessionId, m.id)}
                  onEdit={(text) => useUi.getState().editQueuedMessage(sessionId, m.id, text)}
                  onSendNow={() => {
                    remove(sessionId, m.id);
                    onSendItem(m.text);
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
  onRemove,
  onEdit,
  onSendNow,
}: {
  item: QueuedMessage;
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
        'group flex items-start gap-2 px-2 py-1.5 rounded-md bg-card border border-input',
        isDragging && 'shadow-lg border-accent/40',
      )}
    >
      {/* Grip + position */}
      <Button
        {...attributes}
        {...listeners}
        className="mt-0.5 text-muted-foreground/60 hover:text-muted cursor-grab active:cursor-grabbing"
        title="Drag to reorder"
      >
        <GripVertical className="size-3.5" />
      </Button>

      {/* Text / editor */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            rows={Math.min(5, Math.max(1, Math.ceil(draft.length / 60)))}
            className="w-full bg-secondary border border-border rounded text-xs px-2 py-1 resize-none focus:border-accent outline-none font-sans"
          />
        ) : (
          <div className="text-xs text-muted-foreground leading-relaxed line-clamp-3 whitespace-pre-wrap break-words">
            {item.text}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {editing ? (
          <>
            <Button
              onClick={() => {
                onEdit(draft);
                setEditing(false);
              }}
              className="text-primary hover:text-primary-hover p-1 rounded hover:bg-secondary"
              title="Save"
            >
              <Send className="size-3" />
            </Button>
            <Button
              onClick={() => {
                setDraft(item.text);
                setEditing(false);
              }}
              className="text-muted-foreground/60 hover:text-foreground p-1 rounded hover:bg-secondary"
              title="Cancel"
            >
              <X className="size-3" />
            </Button>
          </>
        ) : (
          <>
            <Button
              onClick={() => setEditing(true)}
              className="text-muted-foreground/60 hover:text-foreground p-1 rounded hover:bg-secondary"
              title="Edit"
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              onClick={onSendNow}
              className="text-muted-foreground/60 hover:text-primary p-1 rounded hover:bg-secondary"
              title="Send now (jumps the queue)"
            >
              <Send className="size-3" />
            </Button>
            <Button
              onClick={onRemove}
              className="text-muted-foreground/60 hover:text-destructive p-1 rounded hover:bg-secondary"
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
