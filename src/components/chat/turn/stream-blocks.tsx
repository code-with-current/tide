/** StreamBlocks — the stream-view block renderer extracted from block-list's
 *  stream branch, shared with the Agents panel. Renders the blocks whose
 *  parentToolCallId === rootId (null = session top level, a dispatch id =
 *  that dispatch's children) in emission order: one ThinkingBlock per model
 *  step, one ToolChips section per contiguous tool run, narration text, and
 *  the consolidated answer at its first block's position. Chat-only trailing
 *  sections (CompactingIndicator, FileChanges, FollowupPrompt) stay in
 *  block-list — they need chat-only handlers. */

import { memo, useMemo } from 'react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import type { Block, DiffHunk, TextBlock } from '@/types';
import { TurnHeader } from './turn-header';
import { ToolChips } from '@/components/blocks/tool-chips';
import { ThinkingBlock } from '@/components/blocks/thinking-block';
import { groupToolRuns, flattenRun } from '@/components/blocks/stream-runs';
import { AnswerBlock } from '@/components/chat/blocks/answer-block';

interface StreamBlocksProps {
  blocks: Block[] | undefined;
  streaming: boolean;
  stopped?: boolean;
  stopReason?: string | null;
  sessionId: string | null;
  /** Parent scope to render: null = session top level (main chat), a
   *  dispatch id = that dispatch's children (Agents panel). */
  rootId?: string | null;
  /** Wall-clock send→result duration (ms), shown at the end of the answer. */
  totalMs?: number;
  onViewFile?: (path: string) => void;
  onViewFileDiff?: (entry: { path: string; hunks?: DiffHunk[] }) => void;
  sessionTitle?: string;
  sessionModelId?: string;
  sessionProviderId?: string;
}

export const StreamBlocks = memo(function StreamBlocks({
  blocks, streaming, stopped, stopReason, sessionId, rootId = null,
  totalMs, onViewFile, onViewFileDiff, sessionTitle, sessionModelId, sessionProviderId,
}: StreamBlocksProps) {
  // The answer phase can contain several text blocks (all flagged isAnswer —
  // see redetermineAnswerFlag). Consolidate them into a single result block
  // at the first answer block's position so stream view shows ONE answer.
  // Root-scoped: sub-agent narration (rootId = a dispatch) never joins the
  // main answer, and parented text flagged by legacy migration never
  // consolidates at the session root.
  const answerInfo = useMemo(() => {
    if (!blocks) return null;
    const atRoot = (b: Block) =>
      b.kind === 'tool' || b.kind === 'text' || b.kind === 'reasoning'
        ? (b.parentToolCallId ?? null) === rootId
        : false;
    const answerBlocks = blocks.filter((b): b is TextBlock => b.kind === 'text' && b.isAnswer && atRoot(b));
    if (answerBlocks.length === 0) return null;
    const firstIdx = blocks.findIndex((b) => b.kind === 'text' && b.isAnswer && atRoot(b));
    return { firstIdx, text: answerBlocks.map((b) => b.text).join('\n\n').trim() };
  }, [blocks, rootId]);

  // Contiguous tool blocks at the root group into runs; each run renders as
  // one ToolChips section — split where reasoning/text interrupts tooling.
  // Deeper descendants index by parent so flattenRun nests them under their
  // own row.
  const { runs: toolRuns, childrenByParent } = useMemo(() => groupToolRuns(blocks, rootId), [blocks, rootId]);

  // Root-scoped equivalent of deriveLayout's hasProcessContent: any
  // reasoning, tool, or narration text at this root precedes the answer.
  const hasProcessContent = useMemo(
    () => !!blocks?.some((b) =>
      (b.kind === 'reasoning' || b.kind === 'tool' || (b.kind === 'text' && !b.isAnswer)) &&
      (b.parentToolCallId ?? null) === rootId,
    ),
    [blocks, rootId],
  );

  // Blocks inline in emission order — same block UI as compact view
  // (ThinkingBlock headers, grouped ToolChips sections), just not hoisted:
  // reasoning renders per model step where it was emitted, and tooling splits
  // into one section per contiguous run. Only narration text is stream-only.
  return (
    <>
      {(blocks ?? []).map((b, idx) => {
        switch (b.kind) {
          case 'reasoning':
            // Only blocks at this root render — sub-agent reasoning renders
            // in the Agents panel under its dispatch, never as a top-level
            // thinking card.
            if ((b.parentToolCallId ?? null) !== rootId) return null;
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
                variant="stream"
              />
            );
          case 'tool': {
            // Children of another root nest under their own parent — skip
            // here. Non-first blocks of a run render with the run.
            if ((b.parentToolCallId ?? null) !== rootId) return null;
            const isFirstOfRun = toolRuns.some((r) => r[0]?.id === b.id);
            if (!isFirstOfRun) return null;
            return (
              <ToolChips
                key={b.id}
                calls={flattenRun(toolRuns.find((r) => r[0]?.id === b.id) ?? [], childrenByParent)}
                streaming={streaming}
                variant="stream"
                sessionId={sessionId}
                onViewFile={onViewFile}
                onViewDiff={onViewFileDiff}
              />
            );
          }
          case 'text':
            // Sub-agent narration renders in the Agents panel under its
            // dispatch — never inline in the main chat.
            if ((b.parentToolCallId ?? null) !== rootId) return null;
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
                  <TurnHeader blocks={blocks} streaming={streaming} stopReason={stopReason} totalMs={totalMs} />
                  <AnswerBlock
                    text={answerInfo.text}
                    streaming={streaming}
                    stopped={stopped}
                    hasProcessContent={hasProcessContent}
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
                className="text-[0.85rem] text-card-foreground/80 leading-relaxed mt-[5px] [&_p]:my-0.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-0.5 [&_ul:first-child]:mt-0 [&_ul:last-child]:mb-0 [&_li]:my-0 [&_pre]:my-1 [&_code]:text-[0.7857rem]"
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
    </>
  );
}, (prev, next) =>
  prev.blocks === next.blocks &&
  prev.streaming === next.streaming &&
  prev.stopped === next.stopped &&
  prev.stopReason === next.stopReason &&
  prev.sessionId === next.sessionId &&
  prev.rootId === next.rootId
);
