import { memo } from 'react';
import { MemoizedMarkdown } from './MemoizedMarkdown';

export const AnswerBlock = memo(function AnswerBlock({
  text,
  streaming,
  stopped,
  failed,
  hasProcessContent,
}: {
  text: string;
  streaming: boolean;
  /** True if the turn was aborted mid-stream — shows the [stopped] marker. */
  stopped?: boolean;
  /** True if the turn failed (stopReason === 'refusal'). Suppresses the
   *  "No summary — this turn was tool-only." placeholder so a failed turn
   *  doesn't show a neutral message on top of the error block. */
  failed?: boolean;
  /** True when the turn produced thinking, tool calls, or edits — i.e.
   *  there's process content above the answer worth demarcating. Pure
   *  text replies have no separator (nothing above to separate from). */
  hasProcessContent: boolean;
}) {
  // The hairline separator only renders when there's process content
  // (thinking/tools/edits) above. Without this guard, a pure text reply
  // gets an orphan separator directly under the header.
  const Separator = hasProcessContent
    ? <div className="border-t border-input my-1" />
    : null;

  // Empty answer (tool-only turn, pre-text phase, or failed). Suppress failed turns and turns with no text AND no process content (a real tool-only turn has hasProcessContent = true).
  if (!text && !streaming) {
    if (failed || !hasProcessContent) return null;
    return (
      <>
        {Separator}
        <div className="text-[12.5px] text-muted-foreground/60 italic py-1">
          No summary — this turn was tool-only.
        </div>
      </>
    );
  }
  if (!text) {
    // Streaming but no text yet — don't render anything until there's
    // something to show. (Separator also stays hidden until text lands.)
    return null;
  }

  return (
    <>
      {Separator}

      <div className="prose-chat">
        <MemoizedMarkdown content={text} streaming={streaming} />
      </div>

      {stopped && (
        <div className="mt-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-warning font-mono">
          <span className="size-1.5 bg-warning" />
          turn stopped
        </div>
      )}

      {streaming && (
        <span className="cursor-blink inline-block ml-0.5" />
      )}
    </>
  );
});
