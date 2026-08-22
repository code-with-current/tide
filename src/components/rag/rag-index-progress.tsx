/** RagIndexProgress: indexing-progress card. embedding → determinate %, walking/chunking → indeterminate shimmer, failed → destructive error. Renders null when idle/done. */

import { Loader2, AlertTriangle } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { RagInitProgressEvent } from '@/types';

/** Map an indexing phase to a human label. Shared so the three call sites
 *  (this card + two settings screens' status chips) stay in sync. */
export function phaseLabel(phase: RagInitProgressEvent['phase']): string {
  switch (phase) {
    case 'walking': return 'Walking files';
    case 'chunking': return 'Chunking source';
    case 'embedding': return 'Embedding chunks';
    case 'failed': return 'Indexing failed';
    case 'done': return 'Indexed';
    default: return 'Indexing';
  }
}

export function RagIndexProgress({ event }: { event: RagInitProgressEvent | null }) {
  // Self-gate: render nothing when idle or done (no active/failed state).
  if (!event || event.phase === 'done') return null;

  const failed = event.phase === 'failed';
  const determinate = event.phase === 'embedding' && event.chunksTotal > 0;
  const pct = determinate
    ? Math.min(100, Math.round((event.chunksEmbedded / event.chunksTotal) * 100))
    : 0;

  // Contextual counts line: show what's meaningful for the current phase.
  const counts =
    event.phase === 'walking'
      ? `${event.filesSeen} files`
      : event.phase === 'chunking'
        ? `${event.chunksTotal} chunks · ${event.filesSeen} files`
        : event.phase === 'embedding'
          ? `${event.chunksEmbedded} / ${event.chunksTotal} chunks`
          : '';

  return (
    <div
      className={cn(
        'rounded-lg border p-3 flex flex-col gap-2.5 mt-2',
        failed
          ? 'border-destructive/25 bg-destructive/5'
          : 'border-emerald-500/20 bg-emerald-500/[0.04]',
      )}
    >
      {/* Headline: phase + (determinate) percentage. */}
      <div className="flex items-center gap-2">
        {failed ? (
          <AlertTriangle className="size-3.5 text-destructive shrink-0" />
        ) : (
          <Loader2 className="size-3.5 animate-spin text-emerald-400 shrink-0" />
        )}
        <span className={cn('text-[0.8571rem] font-semibold flex-1 min-w-0 truncate', failed && 'text-destructive')}>
          {phaseLabel(event.phase)}
        </span>
        {determinate && (
          <span className="text-[0.7857rem] font-mono text-muted-foreground tabular-nums">{pct}%</span>
        )}
      </div>

      {/* Bar: determinate Progress vs. indeterminate shimmer. */}
      {failed ? null : determinate ? (
        <Progress value={pct} className="h-1.5 bg-emerald-500/15 [&>[data-slot=progress-indicator]]:bg-emerald-400" />
      ) : (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-500/15">
          <div className="rag-index-bar-indeterminate h-full rounded-full bg-emerald-400/80" />
        </div>
      )}

      {/* Error body (failed only). */}
      {failed && event.error && (
        <pre className="text-[0.7143rem] leading-relaxed text-destructive/80 whitespace-pre-wrap break-words font-mono bg-destructive/5 rounded-md p-2">
          {event.error}
        </pre>
      )}

      {/* Current file — surfaced for the first time (was unused before). */}
      {!failed && event.currentFile && (
        <div className="text-[0.7143rem] text-muted-foreground/60 font-mono truncate" title={event.currentFile}>
          {event.currentFile}
        </div>
      )}

      {/* Counts line. */}
      {!failed && counts && (
        <div className="text-[0.7857rem] text-muted-foreground/70 font-mono">{counts}</div>
      )}
    </div>
  );
}
