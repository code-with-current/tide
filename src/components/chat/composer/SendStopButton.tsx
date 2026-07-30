import { ArrowUp, Square, ListPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/quick-tooltip';
import { cn } from '@/lib/utils';

/**
 * Icon-only Send / Stop button. The caller decides which mode to show:
 *
 *   mode='stop'             — pulsing red square, click aborts the turn
 *   mode='send'             — coral arrow, click submits (or queues, see willQueue)
 *   mode='send' willQueue   — coral list-plus icon, click enqueues for later
 */
export function SendStopButton({
  mode,
  willQueue = false,
  disabled,
  onSend,
  onStop,
  className,
}: {
  mode: 'send' | 'stop';
  willQueue?: boolean;
  disabled?: boolean;
  onSend: () => void;
  onStop: () => void;
  className?: string;
}) {
  if (mode === 'stop') {
    return (
      <Tip label="Stop turn  ·  ⌘." side="top">
        <Button
          variant="destructive"
          size="sm"
          onClick={onStop}
          className={cn('size-7 p-0 rounded-full transition-all', className)}
          aria-label="Stop turn"
        >
          <Square className="size-3 fill-current animate-stop-pulse" />
        </Button>
      </Tip>
    );
  }

  return (
    <Tip label={willQueue ? 'Queue message  ·  ↵' : 'Send  ·  ↵'} side="top">
      <Button
        variant="default"
        size="sm"
        onClick={onSend}
        disabled={disabled}
        className={cn('size-7 p-0 rounded-full transition-all', className)}
        aria-label={willQueue ? 'Queue message' : 'Send message'}
      >
        {willQueue ? <ListPlus className="size-3.5" /> : <ArrowUp className="size-3.5" />}
      </Button>
    </Tip>
  );
}
