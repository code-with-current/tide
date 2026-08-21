/** AgentsPanel — docked sub-agent dispatch stream, opened only by dispatch-row
 *  clicks in the chat (which focus the dispatch and flip agentsPanelOpen) and
 *  closed by the header X. Focus is kept on close so reopening returns.
 *
 *  Data path: sub-agent events (tool + narration + reasoning) are re-tagged
 *  with parentToolCallId and ride the PARENT session's event stream
 *  (streams[childSessionId] is never populated live), so the body reads the
 *  dispatch ToolBlock and its nested child blocks from the parent's live
 *  stream blocks, falling back to the persisted message blocks once the live
 *  stream resets on the next turn. Children render via StreamBlocks — the
 *  main chat's stream renderer (block-list's stream branch) rooted at the
 *  dispatch instead of the session — so spacing and behavior match the chat
 *  exactly, with the dispatch report as an AnswerBlock last. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Loader2, X } from 'lucide-react';
import type { Block, Session, ToolBlock } from '@/types';
import { cn, formatRelative } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { useSession, useDispatches } from '@/lib/queries';
import { useFollowScroll } from '@/hooks/use-follow-scroll';
import { ThinkingBlock } from './thinking-block';
import { AgentStatusChip } from './tool-chips';
import { agentStatusOf } from './agent-status';
import { StreamBlocks } from '@/components/chat/turn/stream-blocks';
import { AnswerBlock } from '@/components/chat/blocks/answer-block';

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
  // Root-scoped stats over the dispatch's children — drives the header count,
  // the legacy-reasoning fallback, and the waiting indicator.
  const root = useMemo(() => {
    const list = resolved?.list;
    if (!list) return { tools: 0, reasoning: false, any: false };
    let tools = 0;
    let reasoning = false;
    let any = false;
    for (const b of list) {
      if (b.kind !== 'tool' && b.kind !== 'text' && b.kind !== 'reasoning') continue;
      if ((b.parentToolCallId ?? null) !== focus) continue;
      any = true;
      if (b.kind === 'tool') tools++;
      else if (b.kind === 'reasoning') reasoning = true;
    }
    return { tools, reasoning, any };
  }, [resolved, focus]);
  const toolCount = root.tools;
  const hasReasoning = root.reasoning;

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

      {/* Body — the dispatch's child stream via StreamBlocks (the main chat's
          stream renderer rooted at the dispatch), with the dispatch report as
          an AnswerBlock last. Spacing mirrors the chat: the scroll container
          carries the timeline's px-6 py-3, the content column TurnBlock's
          flex flex-col gap-0. Auto-follows while the dispatch runs. */}
      <div ref={bodyRef} className="flex-1 min-h-0 scroll min-w-0 overflow-y-auto px-6 py-3">
        {resolved ? (
          <div className="flex flex-col gap-0">
            {/* Legacy fallback: persisted dispatch displays carry a reasoning
                summary even when no parented reasoning blocks were recorded. */}
            {d?.reasoning && !hasReasoning && (
              <ThinkingBlock text={d.reasoning} streaming={running} variant="stream" />
            )}
            <StreamBlocks
              blocks={resolved.list}
              streaming={running}
              sessionId={sessionId}
              rootId={focus}
            />
            {report && (
              <AnswerBlock
                text={report}
                streaming={running}
                hasProcessContent={root.any || !!d?.reasoning}
                elapsedMs={resolved.dispatch.durationMs}
              />
            )}
            {running && !root.any && !d?.reasoning && (
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
