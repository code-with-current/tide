import { useEffect, useState } from 'react';
import { Check, X, AlertTriangle, AlertCircle, Clock } from 'lucide-react';
import type { Block, Turn } from '@/types';
import { cn } from '@/lib/utils';
import { isFailedStatus } from '@/lib/stream/block-state';
import { ThinkingOrb } from 'thinking-orbs';

/** Format ms as whole seconds: "14s", "1m30s". No sub-second/ms precision. */
function formatDuration(ms?: number): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** Pixel-grid "Working" loader + shimmer label + live wall-clock timer, shown
 *  at the BOTTOM of the turn while streaming. The timer reflects the FULL turn
 *  wall-clock — from `startedAt` (the assistant message's creation time, ≈ when
 *  the turn started) — not component-mount time, so it matches the persisted
 *  totalMs that appears in the answer once the turn completes. */
function useWallClock(startedAt?: string): string {
  const secondsOf = (s?: string) => {
    if (!s) return 0;
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 1000)) : 0;
  };
  const [sec, setSec] = useState(() => secondsOf(startedAt));
  useEffect(() => {
    const id = setInterval(() => setSec(secondsOf(startedAt)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function TurnWorkingFooter({ startedAt }: { startedAt?: string }) {
  const elapsed = useWallClock(startedAt);
  return (
    <div className="flex w-fit items-center gap-2.5 py-0.5">
      <ThinkingOrb
        state="composing"
        size={20}
        speed={2}
        aria-label="Running"
        className="flex-shrink-0"

      />
      <span className="animate-shimmer-title text-[13px] font-medium">Working</span>
      <span className="font-mono text-[12px] text-muted-foreground/50 tabular-nums">{elapsed}</span>
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
