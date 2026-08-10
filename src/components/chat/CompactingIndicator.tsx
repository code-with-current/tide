import { Loader2, Minimize2 } from 'lucide-react';

/** In-stream indicator shown while autocompact is summarizing earlier
 *  context to fit the context window. Renders inline between the process
 *  section and the answer — that is where the pause chronologically sits
 *  (between model steps), so the indicator belongs there rather than
 *  floating above the whole turn.
 *
 *  Tone matches the process-section tool rows: monospace, muted, with a
 *  left accent and spinner. Subtle by design — compaction is routine. */
export function CompactingIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="group relative pl-3 py-1 animate-slide-up"
    >
      {/* Left accent — primary-tinted to read as "system working" (matches
          the running-tool accent in OneCodeToolRow). */}
      <div className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-primary/50" />

      <div className="flex items-center gap-2 text-[12.5px] font-mono">
        <span className="inline-flex w-3 justify-center flex-shrink-0">
          <Loader2 className="size-3 text-primary/70 animate-spin" />
        </span>
        <Minimize2 className="size-3 text-primary/70" />
        <span className="text-primary/80">Compacting context</span>
        <span className="text-muted-foreground/50 truncate">
          — summarizing earlier turns to fit the context window
        </span>
      </div>
    </div>
  );
}
