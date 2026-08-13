/** In-stream indicator shown while autocompact is summarizing earlier
 *  context to fit the context window. Renders inline between the process
 *  section and the answer — that is where the pause chronologically sits
 *  (between model steps), so the indicator belongs there rather than
 *  floating above the whole turn.
 *
 *  The three animated bars visually compress and expand — a literal
 *  metaphor for context being folded into a tighter space. */
export function CompactingIndicator() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="group relative pl-3 py-2 animate-slide-up"
    >
      <div className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-primary/40" />

      <div className="flex items-center gap-3">
        {/* Animated compaction bars */}
        <div className="flex flex-col gap-[2px] w-5 shrink-0" aria-hidden>
          <div
            className="h-[2px] rounded-full bg-primary compact-bar"
            style={{ animationDelay: '0ms' }}
          />
          <div
            className="h-[2px] rounded-full bg-primary/70 compact-bar"
            style={{ animationDelay: '150ms' }}
          />
          <div
            className="h-[2px] rounded-full bg-primary/50 compact-bar"
            style={{ animationDelay: '300ms' }}
          />
        </div>

        <span className="text-[0.85rem] font-mono text-muted-foreground">
          Compacting context
        </span>
      </div>
    </div>
  );
}
