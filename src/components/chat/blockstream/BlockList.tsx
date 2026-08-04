import { memo, useEffect, useMemo, useRef } from 'react';
import type { Block } from '@/types';
import { deriveLayout } from './blockLayout';
import { ThinkingSection } from '@/components/chat/ThinkingSection';
import { ProcessSection } from '@/components/chat/ProcessSection';
import { EditsSection } from '@/components/chat/EditsSection';
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
  /** Turn-level stop reason — suppresses the "tool-only" placeholder
   *  when the turn failed ('refusal') so we don't show a neutral message
   *  on top of an error. */
  stopReason?: string | null;
  sessionId: string | null;
  messageId: string;
  onViewFile?: (path: string) => void;
}

/**
 * Walks the canonical block list and routes each block to its visual
 * section via deriveLayout. The single source of truth for turn rendering.
 *
 * Each section leaf is memoized individually — when one tool block changes
 * reference (reducer guarantee), only that tool's row re-renders. The
 * layout itself is memoized on the blocks array reference.
 *
 * Scroll preservation: when `streaming` flips false, the Thinking +
 * Process sections auto-collapse above the answer. Without compensation,
 * content the user was reading would jump up. We measure the height delta
 * on the next animation frame and adjust the scroll container so the
 * answer stays at the same screen position — but only if the answer is
 * already in view. If the user is scrolled up reading thinking/process,
 * we leave them alone.
 */
export const BlockList = memo(function BlockList({
  blocks, streaming, stopped, stopReason, sessionId, messageId, onViewFile,
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

      {layout.edits.length > 0 && (
        <EditsSection
          edits={layout.edits}
          onViewFile={onViewFile}
        />
      )}

      <div ref={answerRef}>
        <AnswerBlock
          text={layout.answer?.text ?? ''}
          streaming={streaming}
          stopped={stopped}
          failed={stopReason === 'refusal'}
          hasProcessContent={hasProcessContent}
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
