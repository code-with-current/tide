import { memo, useEffect, useMemo, useRef } from 'react';
import type { Block } from '@/types';
import { deriveLayout } from './blockLayout';
import { ThinkingSection } from '@/components/chat/ThinkingSection';
import { ProcessSection } from '@/components/chat/ProcessSection';
import { AnswerBlock } from '@/components/chat/AnswerBlock';
import { FollowupPrompt } from '@/components/chat/FollowupPrompt';

/** Look up the tool block for a followup and check if it has terminal status.
 *  Used to suppress popup re-firing on persisted messages that were already
 *  answered via the live pause-and-resume flow. */
function isFollowupResolved(blocks: Block[] | undefined, toolCallId: string): boolean {
  if (!blocks) return false;
  const tool = blocks.find(b => b.kind === 'tool' && b.toolCallId === toolCallId);
  if (!tool || tool.kind !== 'tool') return false;
  return tool.status === 'executed' || tool.status === 'rejected' ||
         tool.status === 'failed' || tool.status === 'aborted';
}

interface BlockListProps {
  blocks: Block[] | undefined;
  streaming: boolean;
  stopped?: boolean;
  stopReason?: string | null;
  sessionId: string | null;
  messageId: string;
  onViewFile?: (path: string) => void;
  sessionTitle?: string;
  sessionModelId?: string;
  sessionProviderId?: string;
}

/** Walks the canonical block list and routes each block via deriveLayout. Memoized sections; preserves scroll on streaming→completed transition when answer is in view. */
export const BlockList = memo(function BlockList({
  blocks, streaming, stopped, stopReason: _stopReason, sessionId, messageId, onViewFile, sessionTitle, sessionModelId, sessionProviderId,
}: BlockListProps) {
  const layout = useMemo(() => deriveLayout(blocks), [blocks]);

  // Refs for scroll-preservation math during the streaming → completed transition.
  const thinkingRef = useRef<HTMLDivElement>(null);
  const processRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const prevHeightsRef = useRef<{ thinking?: number; process?: number }>({});
  // Cached nearest scrollable ancestor — doesn't change during the turn.
  const scrollRef = useRef<HTMLElement | null>(null);

  const hasProcessContent = !!(
    layout.thinking ||
    layout.process.length > 0 ||
    layout.edits.length > 0
  );

  useEffect(() => {
    if (streaming) {
      // Record starting heights while expanded.
      prevHeightsRef.current = {
        thinking: thinkingRef.current?.scrollHeight,
        process: processRef.current?.scrollHeight,
      };
      return;
    }
    // streaming just flipped to false — compensate on next frame.
    // Cache the scroll container if we haven't yet.
    if (!scrollRef.current && answerRef.current) {
      let node: HTMLElement | null = answerRef.current.parentElement;
      while (node) {
        const overflow = window.getComputedStyle(node).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') {
          scrollRef.current = node;
          break;
        }
        node = node.parentElement;
      }
    }
    const prev = prevHeightsRef.current;
    const frame = requestAnimationFrame(() => {
      const delta =
        (prev.thinking ?? 0) - (thinkingRef.current?.scrollHeight ?? 0) +
        (prev.process ?? 0) - (processRef.current?.scrollHeight ?? 0);
      if (delta > 0 && scrollRef.current) {
        // Only compensate if the user is looking at or below the answer.
        // If they're scrolled up reading thinking/process, leave them alone.
        const answerTop = answerRef.current?.getBoundingClientRect().top;
        const viewportH = window.innerHeight;
        if (answerTop != null && answerTop < viewportH) {
          scrollRef.current.scrollTop -= delta;
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [streaming]);

  return (
    <>
      {layout.thinking && (
        <div ref={thinkingRef}>
          <ThinkingSection
            text={layout.thinking.text}
            tokens={layout.thinking.tokens}
            ms={layout.thinking.ms}
            streaming={streaming}
          />
        </div>
      )}

      {layout.process.length > 0 && (
        <div ref={processRef}>
          <ProcessSection
            blocks={layout.process}
            totals={layout.totals}
            streaming={streaming}
            onViewFile={onViewFile}
          />
        </div>
      )}

      <div ref={answerRef}>
        <AnswerBlock
          text={layout.answer?.text ?? ''}
          streaming={streaming}
          stopped={stopped}
          hasProcessContent={hasProcessContent}
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          sessionModelId={sessionModelId}
          sessionProviderId={sessionProviderId}
        />
      </div>

      {layout.followup && (
        <FollowupPrompt
          mode={layout.followup.mode}
          sessionId={sessionId}
          messageId={messageId}
          streaming={streaming}
          // Resolved = the associated tool block has terminal status. Live
          // turns set this once the user picks and the tool_result event
          // lands. Prevents the popup re-firing on persisted messages that
          // were already answered.
          resolved={isFollowupResolved(blocks, layout.followup.toolCallId)}
        />
      )}
    </>
  );
}, (prev, next) =>
  prev.blocks === next.blocks &&
  prev.streaming === next.streaming &&
  prev.stopped === next.stopped &&
  prev.stopReason === next.stopReason &&
  prev.sessionId === next.sessionId &&
  prev.messageId === next.messageId
);
