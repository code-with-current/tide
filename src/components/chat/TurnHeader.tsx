import { useEffect, useState } from 'react';
import { Check, X, AlertTriangle, AlertCircle, Clock } from 'lucide-react';
import type { Block, Turn } from '@/types';
import { cn } from '@/lib/utils';
import { AsciiSpinner } from '@/components/AsciiSpinner';
import { isFailedStatus } from '@/lib/stream/blockState';

/** Format ms as e.g. "14s" or "1m30s" or "230ms". */
function formatDuration(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/** The "⠴ working" spinner + live elapsed timer, shown at the BOTTOM of the turn while streaming. */
export function TurnWorkingFooter({ totalMs }: { totalMs?: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedStr = formatDuration(elapsed);
  const toolStr = formatDuration(totalMs);

  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60 font-mono py-0.5">
      <div className="flex items-center gap-2">
        <AsciiSpinner className="text-muted-foreground" />
        <span className="text-muted-foreground">Working</span>
      </div>
      <div className="flex items-center gap-1 text-muted-foreground/50">
        <Clock className="size-3" />
        <span>{elapsedStr}</span>
        {toolStr && <span className="text-muted-foreground/30">/ {toolStr} tools</span>}
      </div>
    </div>
  );
}

export function TurnHeader({
  turn,
  streaming,
  stopReason,
  blocks,
}: {
  turn?: Turn;
  streaming: boolean;
  stopReason?: string | null;
  blocks?: Block[];
}) {
  let totalMs: number | undefined;
  let anyFailed: boolean | undefined;
  if (blocks) {
    let sum = 0;
    let failed = false;
    for (const b of blocks) {
      if (b.kind === 'tool') {
        if (b.durationMs != null) sum += b.durationMs;
        if (isFailedStatus(b.status)) failed = true;
      }
    }
    totalMs = sum > 0 ? sum : undefined;
    anyFailed = failed || undefined;
  } else {
    totalMs = turn?.totalMs;
    anyFailed = turn?.anyFailed;
  }
  const toolDuration = formatDuration(totalMs);
  // Wall-clock turn time — from Turn.totalMs (includes LLM time + tool time).
  const wallClock = formatDuration(turn?.totalMs);

  if (streaming) return null;

  const stopped = stopReason === 'aborted';
  const hasContent = blocks
    ? blocks.some((b) => b.kind === 'text' || b.kind === 'tool' || b.kind === 'reasoning')
    : !!(turn?.answer || turn?.commands?.length || turn?.edits?.length || turn?.exploration?.length);
  const failed = stopReason === 'refusal' || (!hasContent && !stopReason && !stopped);
  const Icon = stopped ? X : failed ? AlertCircle : anyFailed ? AlertTriangle : Check;
  const tone = stopped
    ? 'text-destructive'
    : failed
      ? 'text-destructive'
      : anyFailed
        ? 'text-warning'
        : 'text-success';

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 hover:text-accent/60 font-mono py-0.5">
      <Icon className={cn('size-3', tone)} />
      <span className={tone}>
        {stopped ? 'Stopped' : failed ? 'Failed' : anyFailed ? 'Done · Issues' : 'Done'}
      </span>
      {wallClock && (
        <span className="flex items-center gap-0.5 text-muted-foreground/50">
          <Clock className="size-2.5" />
          {wallClock}
        </span>
      )}
      {toolDuration && toolDuration !== wallClock && (
        <span className="text-muted-foreground/30">· {toolDuration} tools</span>
      )}
    </div>
  );
}
