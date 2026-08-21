import { memo, useEffect, useMemo, useRef } from 'react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import type { Block, TextBlock, ToolBlock, ToolCall } from '@/types';
import { deriveLayout } from './block-layout';
import { TurnHeader } from './turn-header';
import { summarizeFileChanges } from '@/lib/stream/block-state';
import { ToolChips } from '@/components/chat-v2/tool-chips';
import { FileChanges } from '@/components/chat/blocks/file-changes';
import { ThinkingBlock } from '@/components/chat-v2/thinking-block';
import { ProcessContainer } from '@/components/chat-v2/process-container';
import { answerIsGrowing, lastPhaseLabel } from '@/components/chat-v2/process-state';
import { AnswerBlock } from '@/components/chat/blocks/answer-block';
import { FollowupPrompt } from '@/components/chat/blocks/followup-prompt';
import { CompactingIndicator } from '@/components/chat/blocks/compacting-indicator';
import { toolBlockToToolCall } from '@/components/chat/turn/block-adapter';
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

/** v2 ToolChips input: tool calls with dispatch_agent children flattened
 *  directly after their parent row. */
function flattenCalls(tools: ToolBlock[], childrenByParent: Map<string, ToolBlock[]>): ToolCall[] {
  const out: ToolCall[] = [];
  for (const b of tools) {
    out.push(toolBlockToToolCall(b));
    for (const child of childrenByParent.get(b.toolCallId) ?? []) {
      out.push(toolBlockToToolCall(child));
    }
  }
  return out;
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
  // Stream view renders blocks inline, but the answer phase can contain
  // several text blocks (all flagged isAnswer — see redetermineAnswerFlag).
  // Consolidate them into a single result block at the first answer block's
  // position so stream view shows ONE answer, mirroring compact's deriveLayout.
  const answerInfo = useMemo(() => {
    if (!blocks) return null;
    const answerBlocks = blocks.filter((b): b is TextBlock => b.kind === 'text' && b.isAnswer);
    if (answerBlocks.length === 0) return null;
    const firstIdx = blocks.findIndex((b) => b.kind === 'text' && b.isAnswer);
    return { firstIdx, text: answerBlocks.map((b) => b.text).join('\n\n').trim() };
  }, [blocks]);
  // Index child tool blocks by their parentToolCallId so ProcessSection can
  // pass each dispatch_agent's children to its ToolRow for nested
  // rendering. Children are excluded from layout.process by deriveLayout.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, ToolBlock[]>();
    for (const b of blocks ?? []) {
      if (b.kind === 'tool' && b.parentToolCallId) {
        const arr = map.get(b.parentToolCallId);
        if (arr) arr.push(b);
        else map.set(b.parentToolCallId, [b]);
      }
    }
    return map;
  }, [blocks]);

  const chipCalls = useMemo(
    () => flattenCalls(layout.process.filter((b): b is ToolBlock => b.kind === 'tool'), childrenByParent),
    [layout.process, childrenByParent],
  );

  // Stream view groups contiguous top-level tool blocks into runs; each run
  // renders as one ToolChips section — the same anatomy as compact's single
  // grouped section, split where reasoning/text interrupts tooling.
  const toolRuns = useMemo(() => {
    const runs: ToolBlock[][] = [];
    let prevWasTopLevelTool = false;
    for (const b of blocks ?? []) {
      const isTopLevelTool = b.kind === 'tool' && !b.parentToolCallId;
      if (isTopLevelTool) {
        const run = prevWasTopLevelTool ? runs[runs.length - 1] : undefined;
        if (run) run.push(b);
        else runs.push([b]);
      }
      prevWasTopLevelTool = isTopLevelTool;
    }
    return runs;
  }, [blocks]);

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

  // Stream view: blocks inline in emission order — same block UI as compact
  // (ThinkingBlock headers, grouped ToolChips sections), just not hoisted:
  // reasoning renders per model step where it was emitted, and tooling splits
  // into one section per contiguous run. Only narration text is stream-only.
  const chatView = useUi((s) => s.chatView);
  if (chatView === 'stream') {
    return (
      <>
        {(blocks ?? []).map((b, idx) => {
          switch (b.kind) {
            case 'reasoning':
              // Each reasoning block is one model step. `streaming` is only
              // true for the actively-emitting (last) block, so the previous
              // step's ThinkingBlock collapses via its streaming effect as a
              // new one starts — mirroring compact's single-card collapse.
              if (!b.text.trim()) return null;
              return (
                <ThinkingBlock
                  key={b.id}
                  text={b.text}
                  tokens={b.tokens}
                  ms={b.ms}
                  streaming={streaming && !!blocks && b.id === blocks[blocks.length - 1]?.id}
                />
              );
            case 'tool': {
              // Children nest under their dispatch_agent parent — skip at top
              // level. Non-first blocks of a run render with the run.
              if (b.parentToolCallId) return null;
              const isFirstOfRun = toolRuns.some((r) => r[0]?.id === b.id);
              if (!isFirstOfRun) return null;
              return (
                <ToolChips
                  key={b.id}
                  calls={flattenCalls(toolRuns.find((r) => r[0]?.id === b.id) ?? [], childrenByParent)}
                  streaming={streaming}
                  onViewFile={onViewFile}
                  onViewDiff={onViewFileDiff}
                />
              );
            }
            case 'text':
              if (!b.text.trim()) return null;
              if (b.isAnswer) {
                // Render the consolidated answer ONCE (at the first answer
                // block's position); skip subsequent answer blocks — their
                // text is already included in answerInfo.text. Prevents
                // duplicate result blocks when the answer phase spans
                // multiple text blocks (e.g. split by reasoning).
                if (!answerInfo || idx !== answerInfo.firstIdx) return null;
                return (
                  <div key={b.id}>
                    <TurnHeader blocks={blocks} streaming={streaming} stopReason={stopReason} />
                    <AnswerBlock
                      text={answerInfo.text}
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
                );
              }
              return (
                <div
                  key={b.id}
                  className="text-[0.85rem] text-card-foreground/80 leading-relaxed mt-[5px] [&_p]:my-0.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-0.5 [&_ul:first-child]:mt-0 [&_ul:last-child]:mb-0 [&_li]:my-0 [&_pre]:my-1 [&_code]:text-[11px]"
                >
                  <Streamdown mode="static" remarkPlugins={[remarkGfm]} controls={false} animated={false}>
                    {b.text.trim()}
                  </Streamdown>
                </div>
              );
            default:
              return null;
          }
        })}

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
