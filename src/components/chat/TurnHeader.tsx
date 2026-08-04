import { Check, X, AlertTriangle, AlertCircle } from 'lucide-react';
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

export function TurnHeader({
  turn,
  streaming,
  stopReason,
  blocks,
}: {
  /** @deprecated — kept for back-compat. When `blocks` is present it wins. */
  turn?: Turn;
  streaming: boolean;
  /** From SessionStream.stopReason — 'aborted' renders as stopped. */
  stopReason?: string | null;
  /** When present, totals are derived from this instead of `turn`. */
  blocks?: Block[];
}) {
  // Derive totals from blocks if present; fall back to legacy turn.
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
  const duration = formatDuration(totalMs);

  // Working state — animated braille spinner + "working" label.
  if (streaming) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60 font-mono py-0.5">
        <AsciiSpinner className="text-muted-foreground" />
        <span className="text-muted-foreground">working</span>
        {duration && <span>· {duration}</span>}
      </div>
    );
  }

  // Completed states.
  const stopped = stopReason === 'aborted';
  // A turn is "failed" if stopReason says so, OR if it produced zero content
  // (no text answer, no tool blocks) — the latter catches old sessions that
  // were persisted before stopReason was saved.
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
    <div className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-accent/60 font-mono py-0.5">
      <Icon className={cn('size-3', tone)} />
      <span className={tone}>
        {stopped ? 'Stopped' : failed ? 'Failed' : anyFailed ? 'Done · Issues' : 'Done'}
      </span>
      {duration && <span>· {duration}</span>}
    </div>
  );
}
