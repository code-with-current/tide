import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import type { Block, TextBlock, ToolBlock } from '@/types';
import { deriveLayout } from './block-layout';
import { TurnHeader } from './turn-header';
import { summarizeFileChanges } from '@/lib/stream/block-state';
import { ReasoningView } from '@/components/chat/blocks/reasoning-view';
import { ProcessList } from '@/components/chat/blocks/process-list';
import { ToolRow } from '@/components/chat/blocks/tool-row';
import { AnswerBlock } from '@/components/chat/blocks/answer-block';
import { FollowupPrompt } from '@/components/chat/blocks/followup-prompt';
import { FileChanges } from '../blocks/file-changes';
import { CompactingIndicator } from '@/components/chat/blocks/compacting-indicator';
import { toolBlockToToolCall } from '@/components/chat/turn/block-adapter';
import { useUi } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';

/** Inline thinking for Stream view — renders reasoning as part of the stream
 *  flow (like narration) but visually categorized as thinking (reasoning tint,
 *  a small label, and a left accent), instead of the standalone ReasoningView
 *  card. Compact view is unaffected.
 *
 *  Collapsed by default; the block actively being streamed (last block during a
 *  streaming turn) opens so live thinking stays visible, then collapses when
 *  the turn ends — mirroring the flat/phased reasoning views. */
function StreamThinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);
  return (
    <div className="my-1 border-l-2 border-reasoning/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-[0.7rem] font-mono uppercase tracking-wider text-reasoning/80 hover:text-reasoning transition-colors"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <Brain className={cn("size-3", streaming && "animate-pulse")} />
        Thinking
      </button>
      {open && (
        <div className='border-l border-card-foreground ml-4'>
        <div className="px-3 pb-2 text-[0.85rem] leading-relaxed text-card-foreground/80 [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0 [&_pre]:my-1 [&_code]:text-[11px]">
          <Streamdown mode="static" remarkPlugins={[remarkGfm]} controls={false} animated={false}>
            {text.trim()}
          </Streamdown>
          </div>
        </div>
      )}
    </div>
  );
}

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

  // Stream view: every block inline in emission order — nothing hoisted or
  // grouped. Reasoning still respects the Flat/Phased setting; tool rows and
  // text render where the model emitted them. (chatView is read via a
  // subscribed hook, so switching it re-renders despite the parent memo.)
  const chatView = useUi((s) => s.chatView);
  if (chatView === 'stream') {
    return (
      <>
        {(blocks ?? []).map((b, idx) => {
          switch (b.kind) {
            case 'reasoning':
              // Stream view: render thinking inline like narration, but with a
              // distinct "thinking" category (reasoning tint + label + accent).
              // Compact view still uses the collapsible ReasoningView card.
              // The actively-streaming (last) block is passed streaming= so it
              // auto-expands to show live deltas; all others stay collapsed.
              if (!b.text.trim()) return null;
              return (
                <StreamThinking
                  key={b.id}
                  text={b.text}
                  streaming={streaming && !!blocks && b.id === blocks[blocks.length - 1]?.id}
                />
              );
            case 'tool':
              // Children nest under their dispatch_agent parent — skip at top level.
              if (b.parentToolCallId) return null;
              return (
                <div key={b.id} className="py-0.5">
                  <ToolRow
                    call={toolBlockToToolCall(b)}
                    streaming={streaming}
                    onViewFile={onViewFile}
                    childToolCalls={childrenByParent.get(b.toolCallId)?.map(toolBlockToToolCall)}
                  />
                </div>
              );
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
                      hasProcessContent={false}
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
                  className="text-[0.85rem] text-card-foreground/80 leading-relaxed py-1 [&_p]:my-0.5 [&_ul]:my-0.5 [&_li]:my-0 [&_pre]:my-1 [&_code]:text-[11px]"
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
            streaming={streaming}
            resolved={isFollowupResolved(blocks, layout.followup.toolCallId)}
          />
        )}
      </>
    );
  }

  return (
    <>
      {layout.thinking && (
        <div ref={thinkingRef}>
          <ReasoningView
            text={layout.thinking.text}
            tokens={layout.thinking.tokens}
            ms={layout.thinking.ms}
            streaming={streaming}
          />
        </div>
      )}

      {layout.process.length > 0 && (
        <div ref={processRef}>
          <ProcessList
            blocks={layout.process}
            totals={layout.totals}
            streaming={streaming}
            onViewFile={onViewFile}
            childrenByParent={childrenByParent}
          />
        </div>
      )}

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
