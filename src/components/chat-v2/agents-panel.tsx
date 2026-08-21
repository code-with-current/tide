/** AgentsPanel — docked sub-agent dispatch stream, opened only by dispatch-row
 *  clicks in the chat (which focus the dispatch and flip agentsPanelOpen) and
 *  closed by the header X. Focus is kept on close so reopening returns.
 *
 *  Data path: sub-agent tool events are re-tagged with parentToolCallId and
 *  ride the PARENT session's event stream (streams[childSessionId] is never
 *  populated live), so the body reads the dispatch ToolBlock and its nested
 *  child blocks from the parent's live stream blocks, falling back to the
 *  persisted message blocks once the live stream resets on the next turn. */

import { useMemo, useRef } from 'react';
import { Bot, Loader2, X } from 'lucide-react';
import type { Block, Session, ToolBlock } from '@/types';
import { cn, formatRelative } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import { useSession, useDispatches } from '@/lib/queries';
import { useFollowScroll } from '@/hooks/use-follow-scroll';
import { ThinkingBlock } from './thinking-block';
import { ToolChips, AgentStatusChip } from './tool-chips';
import { agentStatusOf } from './agent-status';
import { groupToolRuns, flattenRun } from './stream-runs';

/** Find the focused dispatch's block list — live stream first (freshest,
 *  covers in-flight dispatches), then persisted message blocks (the live
 *  entry is reset at the start of every new turn). Dispatch and children
 *  always come from the SAME list so nesting stays consistent. */
function resolveBlockList(
  focus: string,
  live: Block[] | undefined,
  messages: Session['messages'] | undefined,
): Block[] | null {
  if (live?.some((b) => b.kind === 'tool' && b.toolCallId === focus)) return live;
  for (const m of messages ?? []) {
    if (m.blocks?.some((b) => b.kind === 'tool' && b.toolCallId === focus)) return m.blocks;
  }
  return null;
}

/** Map a persisted dispatch header (keyed by child session id) back to the
 *  dispatch ToolBlock id the stream view focuses on. */
function findCallByDispatchId(
  dispatchId: string,
  live: Block[] | undefined,
  messages: Session['messages'] | undefined,
): string | null {
  const lists = [live, ...(messages ?? []).map((m) => m.blocks)];
  for (const list of lists) {
    for (const b of list ?? []) {
      if (b.kind === 'tool' && b.display?.kind === 'agent' && b.display.dispatchId === dispatchId) {
        return b.toolCallId;
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
  const { data: session } = useSession(sessionId);
  const { data: dispatches } = useDispatches(sessionId);

  const resolved = useMemo(() => {
    if (!focus) return null;
    const list = resolveBlockList(focus, liveBlocks, session?.messages);
    if (!list) return null;
    const dispatch = list.find((b): b is ToolBlock => b.kind === 'tool' && b.toolCallId === focus);
    if (!dispatch) return null;
    return { list, dispatch };
  }, [focus, liveBlocks, session]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const status = resolved ? agentStatusOf(resolved.dispatch) : 'running';
  const running = status === 'running';
  useFollowScroll(bodyRef, running);

  const d = resolved?.dispatch.display?.kind === 'agent' ? resolved.dispatch.display : undefined;
  const agentName = d?.agentName ?? String(resolved?.dispatch.arguments?.name ?? 'agent');
  const task = d?.task ?? String(resolved?.dispatch.arguments?.task ?? '');
  const report = d?.report ?? resolved?.dispatch.report ?? resolved?.dispatch.output ?? '';
  const childCount = resolved
    ? resolved.list.filter((b) => b.kind === 'tool' && b.parentToolCallId === focus).length
    : 0;
  const { runs, childrenByParent } = useMemo(
    () => groupToolRuns(resolved?.list, focus),
    [resolved, focus],
  );

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 overflow-x-hidden bg-card">
      {/* Header — agent badge, status, task (truncated), usage, close.
          Focus survives close so reopening returns to the same dispatch. */}
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
                {childCount > 0 && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    · {childCount} tool {childCount === 1 ? 'call' : 'calls'}
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
            onClick={() => setAgentsPanelOpen(false)}
            className="shrink-0 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
        {task && (
          <p className="line-clamp-2 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.6] text-muted-foreground">
            {task}
          </p>
        )}
      </div>

      {/* Body — the dispatch's live tool stream, report last. Same stream
          blocks as the main chat (ThinkingBlock/ToolChips variant="stream"),
          auto-following while the dispatch runs. */}
      <div ref={bodyRef} className="flex-1 min-h-0 scroll min-w-0 overflow-y-auto">
        {resolved ? (
          <div className="flex flex-col gap-[5px] px-2 py-2">
            {d?.reasoning && (
              <ThinkingBlock text={d.reasoning} streaming={running} variant="stream" />
            )}
            {runs.map((run) => (
              <ToolChips
                key={run[0]?.id}
                calls={flattenRun(run, childrenByParent)}
                streaming={running}
                variant="stream"
                sessionId={sessionId}
              />
            ))}
            {report && (
              <p className="whitespace-pre-wrap rounded-md bg-secondary/40 px-2 py-1.5 text-[12px] leading-[1.65] text-foreground/85">
                {report}
              </p>
            )}
            {running && childCount === 0 && (
              <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground/70">
                <Loader2 className="size-3 animate-spin" />
                waiting for the agent's first tool call…
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
              const blockId = findCallByDispatchId(h.id, liveBlocks, session?.messages);
              return (
                <button
                  key={h.id}
                  type="button"
                  disabled={!blockId}
                  onClick={() => blockId && setFocusedDispatch(sessionId, blockId)}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
                    blockId
                      ? 'cursor-pointer hover:bg-secondary/60'
                      : 'cursor-default opacity-50',
                  )}
                >
                  <Bot className="size-3 shrink-0 text-purple-400" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/80">
                    {h.title}
                  </span>
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
