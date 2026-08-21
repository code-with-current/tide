import { memo, useEffect, useMemo, useRef } from 'react';
import type { Block, ToolBlock } from '@/types';
import { deriveLayout } from './block-layout';
import { TurnHeader } from './turn-header';
import { StreamBlocks } from './stream-blocks';
import { summarizeFileChanges } from '@/lib/stream/block-state';
import { ToolChips } from '@/components/blocks/tool-chips';
import { FileChanges } from '@/components/chat/blocks/file-changes';
import { ThinkingBlock } from '@/components/blocks/thinking-block';
import { ProcessContainer } from '@/components/blocks/process-container';
import { answerIsGrowing, lastPhaseLabel } from '@/components/blocks/process-state';
import { groupToolRuns, flattenRun } from '@/components/blocks/stream-runs';
import { AnswerBlock } from '@/components/chat/blocks/answer-block';
import { FollowupPrompt } from '@/components/chat/blocks/followup-prompt';
import { CompactingIndicator } from '@/components/chat/blocks/compacting-indicator';
import { useUi } from '@/lib/stores/ui';

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
  /** Wall-clock send→result duration (ms), persisted on the message. Shown at
   *  the end of the answer block. Undefined for live turns until turn_end and
   *  for legacy messages saved before this field existed. */
  totalMs?: number;
  onViewFile?: (path: string) => void;
  /** Open a file with diff hunks (from FileChanges click). */
  onViewFileDiff?: (entry: { path: string; hunks?: import('@/types').DiffHunk[] }) => void;
  /** Revert a file to its pre-turn state (from FileChanges undo). */
  onUndoFile?: (path: string) => void;
  sessionTitle?: string;
  sessionModelId?: string;
  sessionProviderId?: string;
  /** True while autocompact is summarizing context for this turn.
   *  Renders an in-stream indicator so the user understands the pause. */
  compacting?: boolean;
}

/** Walks the canonical block list and routes each block via deriveLayout. Memoized sections; preserves scroll on streaming→completed transition when answer is in view. */
export const BlockList = memo(function BlockList({
  blocks, streaming, stopped, stopReason, sessionId, messageId, totalMs, onViewFile, onViewFileDiff, onUndoFile, sessionTitle, sessionModelId, sessionProviderId, compacting,
}: BlockListProps) {
  const layout = useMemo(() => deriveLayout(blocks), [blocks]);
  const fileChanges = useMemo(() => summarizeFileChanges(blocks ?? []), [blocks]);
  // Compact view nests tool children under their parent row via flattenRun.
  // Stream view (StreamBlocks) computes its own root-scoped grouping.
  const { childrenByParent } = useMemo(() => groupToolRuns(blocks, null), [blocks]);

  const chipCalls = useMemo(
    () => flattenRun(layout.process.filter((b): b is ToolBlock => b.kind === 'tool'), childrenByParent),
    [layout.process, childrenByParent],
  );

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

  // Stream view: blocks inline in emission order via the shared StreamBlocks
  // renderer (also the Agents panel's body, rooted at a dispatch). Chat-only
  // trailing sections render after it here.
  const chatView = useUi((s) => s.chatView);
  if (chatView === 'stream') {
    return (
      <>
        <StreamBlocks
          blocks={blocks}
          streaming={streaming}
          stopped={stopped}
          stopReason={stopReason}
          sessionId={sessionId}
          totalMs={totalMs}
          onViewFile={onViewFile}
          onViewFileDiff={onViewFileDiff}
          sessionTitle={sessionTitle}
          sessionModelId={sessionModelId}
          sessionProviderId={sessionProviderId}
        />

        {streaming && compacting && <CompactingIndicator />}

        {fileChanges.length > 0 && (
          <FileChanges
            changes={fileChanges}
            streaming={streaming}
            onViewFile={onViewFileDiff}
            onUndoFile={onUndoFile}
          />
        )}

        {layout.followup && (
          <FollowupPrompt
            mode={layout.followup.mode}
            sessionId={sessionId}
            messageId={messageId}
            toolCallId={layout.followup.toolCallId}
            streaming={streaming}
            resolved={isFollowupResolved(blocks, layout.followup.toolCallId)}
          />
        )}
      </>
    );
  }

  // Virtual start timestamp: reconstructs "now - duration" so the container's
  // finished-turn Elapsed reads ≈ totalMs. Only rendered when !streaming (the
  // spinner replaces it live), so the Date.now() call per render is inert for
  // history rows until they re-render; turns without persisted totalMs
  // (pre-field legacy) degrade to ~0s.
  const startedAtMs = Date.now() - (totalMs ?? 0);

  return (
    <>
      <ProcessContainer
        streaming={streaming}
        blocks={blocks}
        answerActive={answerIsGrowing(blocks, streaming)}
        startedAt={startedAtMs}
        phaseHint={lastPhaseLabel(layout.thinking?.text)}
      >
        <div ref={thinkingRef}>{layout.thinking && (
          <ThinkingBlock
            text={layout.thinking.text}
            tokens={layout.thinking.tokens}
            ms={layout.thinking.ms}
            streaming={streaming}
          />
        )}</div>
        <div ref={processRef}>{chipCalls.length > 0 && (
          <ToolChips
            calls={chipCalls}
            streaming={streaming}
            sessionId={sessionId}
            onViewFile={onViewFile}
            onViewDiff={onViewFileDiff}
          />
        )}</div>
      </ProcessContainer>

      {/* Compaction indicator — renders inline between the process section
          and the answer so the user sees *where* the pause is happening.
          Compaction always occurs between model steps, so it visually
          belongs here, not floating above the whole turn. */}
      {streaming && compacting && (
        <CompactingIndicator />
      )}

      <TurnHeader blocks={blocks} streaming={streaming} stopReason={stopReason} />

      <div ref={answerRef} data-answer-root>
        <AnswerBlock
          text={layout.answer?.text ?? ''}
          streaming={streaming}
          stopped={stopped}
          hasProcessContent={hasProcessContent}
          elapsedMs={totalMs}
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          sessionModelId={sessionModelId}
          sessionProviderId={sessionProviderId}
        />
      </div>

      {/* File changes section card — same block in BOTH views: collapsible
          summary after the answer. Path click / Review opens the diff viewer,
          Undo reverts the file to its pre-turn state. List caps at 5 files
          with a "Show More.." expander. */}
      {fileChanges.length > 0 && (
        <FileChanges
          changes={fileChanges}
          streaming={streaming}
          onViewFile={onViewFileDiff}
          onUndoFile={onUndoFile}
        />
      )}

      {layout.followup && (
        <FollowupPrompt
          mode={layout.followup.mode}
          sessionId={sessionId}
          messageId={messageId}
          toolCallId={layout.followup.toolCallId}
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
  prev.messageId === next.messageId &&
  prev.compacting === next.compacting
);
