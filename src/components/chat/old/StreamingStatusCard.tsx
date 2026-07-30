import { Square } from 'lucide-react';
import { VibeSpinner } from '@/components/VibeSpinner';
import { Button } from '@/components/ui/button';

export function StreamingStatusCard({
  isStreaming,
  onStop,
}: {
  isStreaming: boolean;
  onStop: () => void;
}) {
  if (!isStreaming) return null;

  return (
    <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary border border-border shadow-lg">
      <VibeSpinner className="text-xs" />
      <Button
        variant="ghost"
        size="xs"
        onClick={onStop}
        className="text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full"
        title="Stop (interrupts the current turn)"
      >
        <Square className="size-2.5 fill-current" />
        Stop
      </Button>
    </div>
  );
}
