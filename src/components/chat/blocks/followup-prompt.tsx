import { memo, useEffect, useState } from 'react';
import { HelpCircle, Loader2, MessageCircleReply } from 'lucide-react';
import type { FollowupMode } from '@/types';
import { useUi } from '@/lib/stores/ui';

/** Routes ask_followup_question: 'options' fires popup with chips+input, 'question' fires input-only, 'blank' shimmers while args stream. Dismissed-but-unresolved shows an Answer button. */
export const FollowupPrompt = memo(function FollowupPrompt({
  mode,
  sessionId,
  messageId,
  streaming,
  resolved = false,
}: {
  mode: FollowupMode;
  sessionId: string | null;
  messageId: string;
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
      });
      setDismissed(false);
    } else if (mode.kind === 'question') {
      showOptionsPopup(sessionId, {
        question: mode.question,
        multiple: false,
        options: [],
        messageId,
      });
      setDismissed(false);
    }
  }, [streaming, resolved, mode, sessionId, messageId, showOptionsPopup]);

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

  // Fully resolved — hide the card entirely.
  if (resolved) return null;

  // Mode 3 — blank.
  if (mode.kind === 'blank') {
    return (
      <div className="flex items-center gap-2 py-1 text-[12px] font-mono text-muted-foreground/60">
        <Loader2 className="size-3 animate-spin" />
        <HelpCircle className="size-3" />
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
            });
          } else if (mode.kind === 'question') {
            showOptionsPopup(sessionId, {
              question: mode.question,
              multiple: false,
              options: [],
              messageId,
            });
          }
          setDismissed(false);
        }}
        className="flex items-center gap-2 py-1.5 px-2.5 w-full text-left bg-primary/5 border border-accent/20 rounded-md hover:bg-primary/10 transition-colors group"
      >
        <HelpCircle className="size-3 text-primary flex-shrink-0" />
        <span className="text-xs text-muted-foreground flex-1 truncate">
          {question}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-primary font-medium flex-shrink-0">
          <MessageCircleReply className="size-3" />
          Answer
        </span>
      </button>
    );
  }

  // Active (popup is showing or about to show)
  if (mode.kind === 'question') {
    return (
      <div className="text-[11px] text-muted-foreground/60 italic py-1">
        awaiting your reply ↓
      </div>
    );
  }

  // Mode 'options' active
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 bg-primary/5 border border-accent/20 text-[12px] font-mono text-primary">
      <HelpCircle className="size-3" />
      <span>
        {mode.options.length} options · awaiting your choice
      </span>
      {mode.multiple && <span className="text-muted-foreground/60">(pick any)</span>}
    </div>
  );
});
