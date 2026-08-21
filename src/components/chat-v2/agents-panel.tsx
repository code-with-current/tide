/** AgentsPanel — docked sub-agent dispatch stream, opened only by dispatch-row
 *  clicks in the chat (which focus the dispatch and flip agentsPanelOpen) and
 *  closed by the header X. Focus is kept on close so reopening returns.
 *
 *  Data path: sub-agent events (tool + narration + reasoning) are re-tagged
 *  with parentToolCallId and ride the PARENT session's event stream
 *  (streams[childSessionId] is never populated live), so the body reads the
 *  dispatch ToolBlock and its nested child blocks from the parent's live
 *  stream blocks, falling back to the persisted message blocks once the live
 *  stream resets on the next turn. Children render interleaved in emission
 *  order via agentStream() — the same anatomy as the main chat's stream
 *  branch, rooted at the dispatch instead of the session. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { Bot, Loader2, X } from 'lucide-react';
import type { Block, Session, ToolBlock } from '@/types';
import { cn, formatRelative } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { useSession, useDispatches } from '@/lib/queries';
import { useFollowScroll } from '@/hooks/use-follow-scroll';
import { ThinkingBlock } from './thinking-block';
import { ToolChips, AgentStatusChip } from './tool-chips';
import { agentStatusOf } from './agent-status';
import { flattenRun } from './stream-runs';
import { agentStream } from './agent-stream';

const NARRATION_CLASSES =
  'text-[0.85rem] text-card-foreground/80 leading-relaxed mt-[5px] [&_p]:my-0.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-0.5 [&_ul:first-child]:mt-0 [&_ul:last-child]:mb-0 [&_li]:my-0 [&_pre]:my-1 [&_code]:text-[11px]';

function formatSecs(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

/** Live wall-clock timer — ElapsedBadge's mount-scoped tick pattern: mounted
 *  only while the dispatch runs, so the clock starts when watching starts and
 *  the interval never outlives the run. */
function LiveElapsed() {
  const [startedAt] = useState(() => Date.now());
  const [, force] = useState(0);
  useEffect(() => {
    const i = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
      {formatSecs(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))}
    </span>
  );
}

/** Find the focused dispatch's block list — live stream first (freshest,
 *  covers in-flight dispatches), then persisted message blocks (the live
 *  entry is reset at the start of every new turn). Dispatch and children
 *  always come from the SAME list so nesting stays consistent. */
function resolveBlockList(
  focus: string,
  live: Block[] | undefined,
  messages: Session['messages'] | undefined,
): { list: Block[]; live: boolean } | null {
  if (live?.some((b) => b.kind === 'tool' && b.toolCallId === focus)) return { list: live, live: true };
  for (const m of messages ?? []) {
    if (m.blocks?.some((b) => b.kind === 'tool' && b.toolCallId === focus)) return { list: m.blocks, live: false };
  }
  return null;
}

/** Map a persisted dispatch header (keyed by child session id) back to the
 *  dispatch ToolBlock the stream view focuses on. */
function findDispatchBlock(
  dispatchId: string,
  live: Block[] | undefined,
  messages: Session['messages'] | undefined,
): ToolBlock | null {
  const lists = [live, ...(messages ?? []).map((m) => m.blocks)];
  for (const list of lists) {
    for (const b of list ?? []) {
      if (b.kind === 'tool' && b.display?.kind === 'agent' && b.display.dispatchId === dispatchId) {
        return b;
      }
    }
  }
  return null;
}

export function AgentsPanel({ sessionId }: { sessionId: string }) {
  const focus = useUi((s) => s.focusedDispatchId[sessionId] ?? null);
  const setFocusedDispatch = useUi((s) => s.setFocusedDispatch);
  const setAgentsPanelOpen = useUi((s) => s.setAgentsPanelOpen);
  const liveBlocks = useUi((s) => s.streams[sessionId]?.blocks);
  const parentStreaming = useUi((s) => s.streams[sessionId]?.isStreaming ?? false);
  const { data: session } = useSession(sessionId);
  const { data: dispatches } = useDispatches(sessionId);

  const resolved = useMemo(() => {
    if (!focus) return null;
    const found = resolveBlockList(focus, liveBlocks, session?.messages);
    if (!found) return null;
    const dispatch = found.list.find((b): b is ToolBlock => b.kind === 'tool' && b.toolCallId === focus);
    if (!dispatch) return null;
    return { ...found, dispatch };
  }, [focus, liveBlocks, session]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const status = resolved ? agentStatusOf(resolved.dispatch) : 'running';
  const running = status === 'running';
  // Keep following while the dispatch runs; a live dispatch also follows while
  // the parent turn streams — its report can still grow after the sub-agent's
  // last tool result lands.
  useFollowScroll(bodyRef, running || (resolved?.live === true && parentStreaming));

  const [taskExpanded, setTaskExpanded] = useState(false);
  useEffect(() => {
    setTaskExpanded(false);
  }, [focus]);

  const d = resolved?.dispatch.display?.kind === 'agent' ? resolved.dispatch.display : undefined;
  const agentName = d?.agentName ?? String(resolved?.dispatch.arguments?.name ?? 'agent');
  const task = d?.task ?? String(resolved?.dispatch.arguments?.task ?? '');
  const report = d?.report ?? resolved?.dispatch.report ?? resolved?.dispatch.output ?? '';
  const stream = useMemo(() => agentStream(resolved?.list, focus ?? ''), [resolved, focus]);
  const toolCount = stream.segments.reduce((n, s) => n + (s.type === 'tools' ? s.run.length : 0), 0);
  const hasReasoning = stream.segments.some((s) => s.type === 'reasoning');
  // Mirror of block-list's stream branch: only the last block in the whole
  // parent list is actively emitting — a later parent block means the child's
  // reasoning stopped growing.
  const lastBlockId = resolved ? resolved.list[resolved.list.length - 1]?.id : undefined;

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 overflow-x-hidden bg-card">
      {/* Header — agent badge, status, elapsed, task (clamped, click
          expands), usage, close. Focus survives close so reopening returns
          to the same dispatch. */}
      <div className="flex flex-col gap-1.5 border-b border-border px-3 py-2.5">
        <div className="flex items-start gap-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {resolved ? (
              <>
                <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10.5px] font-medium text-primary">
                  {agentName}
                </span>
                {!!resolved.dispatch.arguments?.resumeFrom && (
                  <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10.5px] text-muted-foreground">↻ resumed</span>
                )}
                <AgentStatusChip status={status} />
                {running ? (
                  <LiveElapsed />
                ) : resolved.dispatch.durationMs != null ? (
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                    {formatSecs(Math.round(resolved.dispatch.durationMs / 1000))}
                  </span>
                ) : null}
                {toolCount > 0 && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    · {toolCount} tool {toolCount === 1 ? 'call' : 'calls'}
                  </span>
                )}
                {!!d?.usage && (
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                    {(d.usage.inputTokens / 1000).toFixed(1)}k in · {(d.usage.outputTokens / 1000).toFixed(1)}k out
                  </span>
                )}
              </>
            ) : (
              <span className="text-[12px] font-medium text-foreground/80">Agents</span>
            )}
          </div>
          <button
            type="button"
            aria-label="Close agents panel"
            onClick={() => {
              // Reopen the right panel only if opening this panel displaced it.
              const restore = useUi.getState().agentsPanelRestoreRightPanel;
              useUi.setState({ agentsPanelRestoreRightPanel: false });
              setAgentsPanelOpen(false);
              if (restore) {
                useTabs.getState().setActive(sessionId, 'inspector');
                useUi.getState().setRightPanel(true);
              }
            }}
            className="shrink-0 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        {task && (
          <button
            type="button"
            onClick={() => setTaskExpanded((v) => !v)}
            title={task}
            className={cn(
              'min-w-0 text-left font-mono text-[11.5px] leading-[1.6] text-muted-foreground transition-colors hover:text-foreground/80',
              !taskExpanded && 'line-clamp-2',
            )}
          >
            <span className="whitespace-pre-wrap">{task}</span>
          </button>
        )}
      </div>

      {/* Body — the dispatch's child stream in emission order: reasoning,
          narration, and tool runs interleaved exactly like the main stream,
          with the dispatch report as rich markdown last. Auto-follows while
          the dispatch runs. */}
      <div ref={bodyRef} className="flex-1 min-h-0 scroll min-w-0 overflow-y-auto">
        {resolved ? (
          <div className="flex flex-col gap-[5px] px-2 py-2">
            {/* Legacy fallback: persisted dispatch displays carry a reasoning
                summary even when no parented reasoning blocks were recorded. */}
            {d?.reasoning && !hasReasoning && (
              <ThinkingBlock text={d.reasoning} streaming={running} variant="stream" />
            )}
            {stream.segments.map((seg) => {
              if (seg.type === 'reasoning') {
                if (!seg.block.text.trim()) return null;
                return (
                  <ThinkingBlock
                    key={seg.block.id}
                    text={seg.block.text}
                    tokens={seg.block.tokens}
                    ms={seg.block.ms}
                    streaming={running && seg.block.id === lastBlockId}
                    variant="stream"
                  />
                );
              }
              if (seg.type === 'text') {
                if (!seg.block.text.trim()) return null;
                return (
                  <div key={seg.block.id} className={NARRATION_CLASSES}>
                    <Streamdown mode="static" remarkPlugins={[remarkGfm]} controls={false} animated={false}>
                      {seg.block.text.trim()}
                    </Streamdown>
                  </div>
                );
              }
              return (
                <ToolChips
                  key={seg.run[0]?.id}
                  calls={flattenRun(seg.run, stream.childrenByParent)}
                  streaming={running}
                  variant="stream"
                  sessionId={sessionId}
                />
              );
            })}
            {report && (
              <div className={cn(NARRATION_CLASSES, 'text-card-foreground')}>
                <Streamdown mode="static" remarkPlugins={[remarkGfm]} controls={false} animated={false}>
                  {report}
                </Streamdown>
              </div>
            )}
            {running && stream.segments.length === 0 && !d?.reasoning && (
              <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground/70">
                <Loader2 className="size-3 animate-spin" />
                waiting for the agent's first output…
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
            <Bot className="size-4 text-muted-foreground/50" />
            <p className="text-[11.5px] leading-snug text-muted-foreground/70">
              Click a dispatch row to view its stream.
            </p>
          </div>
        )}
        {!resolved && (dispatches ?? []).length > 0 && (
          <div className="flex flex-col gap-0.5 px-2 pb-3">
            {(dispatches ?? []).map((h) => {
              const block = findDispatchBlock(h.id, liveBlocks, session?.messages);
              const bd = block?.display?.kind === 'agent' ? block.display : undefined;
              const name = bd?.agentName ?? String(block?.arguments?.name ?? 'agent');
              const rowTask = (bd?.task ?? '').replace(/\s+/g, ' ').trim();
              return (
                <button
                  key={h.id}
                  type="button"
                  disabled={!block}
                  onClick={() => block && setFocusedDispatch(sessionId, block.toolCallId)}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
                    block
                      ? 'cursor-pointer hover:bg-secondary/60'
                      : 'cursor-default opacity-50',
                  )}
                >
                  <Bot className="size-3 shrink-0 text-purple-400" />
                  <span className="min-w-0 shrink-0 truncate text-[12px] font-medium text-foreground/80">
                    {block ? name : h.title}
                  </span>
                  {rowTask && (
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80">
                      {rowTask}
                    </span>
                  )}
                  {block && <AgentStatusChip status={agentStatusOf(block)} />}
                  <span className="shrink-0 text-[10.5px] text-muted-foreground/70">
                    {formatRelative(h.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
