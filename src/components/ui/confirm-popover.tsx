/**
 * ConfirmPopover — a reusable popover confirmation dialog anchored to a trigger.
 *
 * Wraps the shadcn Popover with a title + description + confirm/cancel buttons.
 * Use it anywhere you need a lightweight "are you sure?" before a destructive
 * action, without a full-screen modal dialog.
 *
 * Example:
 *   <ConfirmPopover
 *     trigger={<button><Trash2 /></button>}
 *     title="Remove server?"
 *     description="This will disconnect and delete the config entry."
 *     confirmLabel="Remove"
 *     destructive
 *     onConfirm={handleRemove}
 *   />
 */
import { useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';

export interface ConfirmPopoverProps {
  /** The element that opens the popover when clicked. */
  trigger: ReactNode;
  /** Bold title text. */
  title: string;
  /** Longer description shown under the title. */
  description?: string;
  /** Label for the confirm button. Default: "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Default: "Cancel". */
  cancelLabel?: string;
  /** Destructive styling (red confirm button). Default: false. */
  destructive?: boolean;
  /** Called when the user confirms. The popover closes automatically. */
  onConfirm: () => void;
  /** Alignment of the popover relative to the trigger. Default: 'end'. */
  align?: 'start' | 'center' | 'end';
}

export function ConfirmPopover({
  trigger,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  align = 'end',
}: ConfirmPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-3">
        <div className="space-y-3">
          <div>
            <p className="text-[13px] font-semibold">{title}</p>
            {description && (
              <p className="text-[11px] text-muted-foreground/60 mt-1 leading-relaxed">
                {description}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => setOpen(false)}
            >
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
