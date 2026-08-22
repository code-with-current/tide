import { memo, useEffect, useState } from 'react';
import { MessageCircleQuestionMark, Loader2, MessageCircleReply, List } from 'lucide-react';
import type { FollowupMode } from '@/types';
import { useUi } from '@/lib/stores/ui';

/** Routes ask_followup_question: 'options' fires popup with chips+input, 'question' fires input-only, 'blank' shimmers while args stream. Dismissed-but-unresolved shows an Answer button. Once resolved nothing renders here — the question/options/answer trace lives in the ask_followup_question tool row. */
export const FollowupPrompt = memo(function FollowupPrompt({
  mode,
  sessionId,
  messageId,
  toolCallId,
  streaming,
  resolved = false,
}: {
  mode: FollowupMode;
  sessionId: string | null;
  messageId: string;
  /** The ask_followup_question tool call this block belongs to. Always pass
   *  it: the popup must carry the id so answering resolves the LIVE paused
   *  tool (submitFollowup) instead of the legacy new-user-message path —
   *  which would start a second turn while the first still awaits its pick. */
  toolCallId?: string;
  streaming: boolean;
  resolved?: boolean;
}) {
  const showOptionsPopup = useUi((s) => s.showOptionsPopup);
  const pendingOpts = useUi((s) => (sessionId ? s.pendingOptions[sessionId] : undefined));
  const [dismissed, setDismissed] = useState(false);

  // Fire the popup when the turn finishes and the question is unresolved.
  useEffect(() => {
    if (streaming) return;
    if (resolved) return;
    if (!sessionId) return;

    if (mode.kind === 'options') {
      showOptionsPopup(sessionId, {
        question: mode.question,
        multiple: mode.multiple,
        options: mode.options,
        messageId,
        toolCallId,
      });
      setDismissed(false);
    } else if (mode.kind === 'question') {
      showOptionsPopup(sessionId, {
        question: mode.question,
        multiple: false,
        options: [],
        messageId,
        toolCallId,
      });
      setDismissed(false);
    }
  }, [streaming, resolved, mode, sessionId, messageId, toolCallId, showOptionsPopup]);

  // Track dismissal: if pendingOptions was set but is now gone (for this
  // messageId) and we're not resolved, the user dismissed it.
  useEffect(() => {
    if (resolved) return;
    if (streaming) return;
    // If popup was showing (pendingOpts matches our messageId) and now it's
    // gone, the user dismissed it.
    if (!pendingOpts && !dismissed) {
      // Only mark as dismissed if we previously had a popup for this question.
      // The popup fires in the effect above, so by this point it should have
      // been shown at least once.
      const wasShown = sessionStorage.getItem(`followup_shown_${messageId}`);
      if (wasShown) setDismissed(true);
    }
    if (pendingOpts?.messageId === messageId) {
      sessionStorage.setItem(`followup_shown_${messageId}`, '1');
      setDismissed(false);
    }
  }, [pendingOpts, dismissed, resolved, streaming, messageId]);

  // Fully resolved — nothing renders here. The Q&A trace (question,
  // options, answer) lives in the ask_followup_question tool row so the
  // turn reads as one comprehensive tooling step.
  if (resolved) return null;

  // Mode 3 — blank.
  if (mode.kind === 'blank') {
    return (
      <div className="flex items-center gap-2 py-1 text-[0.8571rem] font-mono text-muted-foreground/60">
        <Loader2 className="size-3 animate-spin" />
        <MessageCircleQuestionMark className="size-3" />
        <span>preparing question…</span>
      </div>
    );
  }

  // Dismissed but not resolved — show the question + an "Answer" button
  // that re-opens the popup.
  if (dismissed) {
    const question = mode.kind === 'options' ? mode.question : mode.question;
    return (
      <button
        onClick={() => {
          if (!sessionId) return;
          if (mode.kind === 'options') {
            showOptionsPopup(sessionId, {
              question: mode.question,
              multiple: mode.multiple,
              options: mode.options,
              messageId,
              toolCallId,
            });
          } else if (mode.kind === 'question') {
            showOptionsPopup(sessionId, {
              question: mode.question,
              multiple: false,
              options: [],
              messageId,
              toolCallId,
            });
          }
          setDismissed(false);
        }}
        className="flex items-center gap-2 py-1.5 px-2.5 w-full text-left bg-primary/5 border border-accent/20 rounded-md hover:bg-primary/10 transition-colors group"
      >
        <MessageCircleQuestionMark className="size-3 text-primary flex-shrink-0" />
        <span className="text-xs text-muted-foreground flex-1 leading-snug">
          {question}
        </span>
        <span className="flex items-center gap-1 text-[0.7857rem] text-primary font-medium flex-shrink-0">
          <MessageCircleReply className="size-3" />
          Answer
        </span>
      </button>
    );
  }

  // Active (popup is showing or about to show)
  if (mode.kind === 'question') {
    return (
      <div className="text-[0.7857rem] text-muted-foreground/60 italic pt-[5px]">
        awaiting your reply ↓
      </div>
    );
  }

  // Mode 'options' active
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 text-[0.80rem] font-mono text-primary rounded-lg w-fit">
      <List className="size-3.5 text-warning" />
      <span>
        {mode.options.length} Options · Awaiting your Choice
      </span>
      {mode.multiple && <span className="text-muted-foreground/60">(pick any)</span>}
    </div>
  );
});
