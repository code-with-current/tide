/** AgentsTab — sub-agent dispatch stream as a right-panel tab, opened only by
 *  dispatch-row clicks in the chat (which focus the dispatch and activate the
 *  agents tab) and closed by the header X. Focus is kept on close so
 *  reopening returns.
 *
 *  Data path: sub-agent events (tool + narration + reasoning) are re-tagged
 *  with parentToolCallId and ride the PARENT session's event stream
 *  (streams[childSessionId] is never populated live), so the body reads the
 *  dispatch ToolBlock and its nested child blocks from the parent's live
 *  stream blocks, falling back to the persisted message blocks once the live
 *  stream resets on the next turn. Children render via ChatMessage
 *  (same renderer as the main chat), with the dispatch report as the answer
 *  part last. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, X } from 'lucide-react';
import type { Block, Session, ToolBlock } from '@/types';
import { cn, formatRelative } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { useSession, useDispatches, useWorkspaces } from '@/lib/queries';
import { useFollowScroll } from '@/hooks/use-follow-scroll';
import { PixelLoader } from '@/components/ui/pixel-loader';
import { agentStatusOf, agentSessionDisplayName } from '@/components/blocks/agent-status';
import { blockToPart } from '@/components/chat/timeline/lib/tide-adapter';
import { ChatMessage } from '@/components/chat/timeline/chat-message';

/** Ported-row status cue (replaces the legacy AgentStatusChip): orbit loader
 *  while running, colored dot once finalized — matches tool-part's cues. */
function AgentStatusDot({ status }: { status: ReturnType<typeof agentStatusOf> }) {
  if (status === 'running') return <PixelLoader variant="orbit" size="xs" />;
  const color =
    status === 'done' ? 'var(--status-success)'
    : status === 'error' ? 'var(--status-error)'
    : 'var(--muted-foreground)';
  return (
    <span
      className="inline-block size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      title={status}
    />
  );
}

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
    <span className="shrink-0 font-mono text-[0.75rem] tabular-nums text-muted-foreground">
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

export function AgentsTab({ sessionId }: { sessionId: string }) {
  const focus = useUi((s) => s.focusedDispatchId[sessionId] ?? null);
  const setFocusedDispatch = useUi((s) => s.setFocusedDispatch);
  const liveBlocks = useUi((s) => s.streams[sessionId]?.blocks);
  const parentStreaming = useUi((s) => s.streams[sessionId]?.isStreaming ?? false);
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const { data: session } = useSession(sessionId);
  const { data: dispatches } = useDispatches(sessionId);
  const { data: workspaces } = useWorkspaces();
  const directory = workspaces?.find((w) => w.id === activeWorkspaceId)?.path;

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
  const { engaged } = useFollowScroll(bodyRef, running || (resolved?.live === true && parentStreaming));

  const [idCopied, setIdCopied] = useState(false);

  const [taskExpanded, setTaskExpanded] = useState(false);
  useEffect(() => {
    setTaskExpanded(false);
  }, [focus]);

  const d = resolved?.dispatch.display?.kind === 'agent' ? resolved.dispatch.display : undefined;
  const agentName = d?.agentName ?? String(resolved?.dispatch.arguments?.name ?? 'agent');
  const dispatchTitle =
    d?.title ?? (typeof resolved?.dispatch.arguments?.title === 'string' && resolved.dispatch.arguments.title.trim().length > 0
      ? resolved.dispatch.arguments.title
      : undefined);
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

  /** Child blocks → ported message entry. The dispatch report rides as an
   *  isAnswer text part and the persisted reasoning summary as a reasoning
   *  part, so ChatMessage renders everything with chat parity. */
  const entry = useMemo(() => {
    if (!resolved) return null;
    const childBlocks = resolved.list.filter(
      (b) => b.kind !== 'followup' && b.parentToolCallId === focus,
    );
    const synth: Block[] = [];
    if (d?.reasoning && !hasReasoning) {
      synth.push({ kind: 'reasoning', id: `${focus}-legacy-reasoning`, text: d.reasoning, createdAtSeq: 0, modifiedAtSeq: 0 });
    }
    if (report) {
      synth.push({ kind: 'text', id: `${focus}-report`, text: report, isAnswer: true, createdAtSeq: 0, modifiedAtSeq: 0 });
    }
    return {
      info: {
        id: `agent-${focus}`,
        role: 'assistant' as const,
        time: { created: Date.now() },
      },
      parts: [...childBlocks, ...synth].map((b) => {
        // Strip parentToolCallId: this tab IS the dispatch scope — there is
        // no dispatch_agent row here for nested parts to render inside, and
        // message-body filters hasParentToolCall parts from the top level.
        const part = blockToPart(b);
        delete part.metadata?.parentToolCallId;
        return part;
      }),
    };
  }, [resolved, focus, d?.reasoning, report, hasReasoning]);

  return (
    <div className="tide-chat flex flex-col h-full min-h-0 min-w-0 overflow-x-hidden bg-card">
      {/* Header — agent badge, status, elapsed, task (clamped, click
          expands), usage, close. Focus survives close so reopening returns
          to the same dispatch. */}
      <div className="flex flex-col gap-1.5 border-b border-border bg-sidebar px-3 py-2.5">
        <div className="flex items-start gap-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {resolved ? (
              <>
                <span
                  className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[0.75rem] font-medium text-primary"
                  title={task}
                >
                  {agentSessionDisplayName(agentName, dispatchTitle)}
                </span>
                {!!resolved.dispatch.arguments?.resumeFrom && (
                  <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[0.75rem] text-muted-foreground">↻ resumed</span>
                )}
                <AgentStatusDot status={status} />
                {running ? (
                  <LiveElapsed />
                ) : resolved.dispatch.durationMs != null ? (
                  <span className="shrink-0 font-mono text-[0.75rem] tabular-nums text-muted-foreground">
                    {formatSecs(Math.round(resolved.dispatch.durationMs / 1000))}
                  </span>
                ) : null}
                {toolCount > 0 && (
                  <span className="shrink-0 text-[0.7857rem] text-muted-foreground">
                    · {toolCount} tool {toolCount === 1 ? 'call' : 'calls'}
                  </span>
                )}
                {!!d?.usage && (
                  <span className="shrink-0 font-mono text-[0.75rem] text-muted-foreground">
                    {(d.usage.inputTokens / 1000).toFixed(1)}k in · {(d.usage.outputTokens / 1000).toFixed(1)}k out
                  </span>
                )}
                {(d?.dispatchId || focus) && (
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(d?.dispatchId ?? focus ?? '').then(() => {
                        setIdCopied(true);
                        setTimeout(() => setIdCopied(false), 1500);
                      });
                    }}
                    title={`${d?.dispatchId ?? focus} — click to copy`}
                    className="shrink-0 max-w-[8rem] truncate font-mono text-[0.6875rem] text-muted-foreground/50 transition-colors hover:text-foreground"
                  >
                    {idCopied ? 'Copied ✓' : d?.dispatchId ?? focus}
                  </button>
                )}
              </>
            ) : (
              <span className="text-[0.8571rem] font-medium text-foreground/80">Agents</span>
            )}
          </div>
          <button
            type="button"
            aria-label="Close agents tab"
            onClick={() => {
              useTabs.getState().setActive(sessionId, 'files');
              useUi.getState().setRightPanel(false);
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
              'min-w-0 text-left font-mono text-[0.8214rem] leading-[1.6] text-muted-foreground transition-colors hover:text-foreground/80',
              !taskExpanded && 'line-clamp-2',
            )}
          >
            <span className="whitespace-pre-wrap">{task}</span>
          </button>
        )}
      </div>

      {/* Body — the dispatch's child blocks projected into a synthetic
          assistant entry and rendered through ChatMessage (same
          renderer as the main timeline), report riding as the answer part.
          Auto-follows while the dispatch runs; the floating button returns to
          the live tail after scrolling up. */}
      <div className="relative flex-1 min-h-0 min-w-0">
      <div ref={bodyRef} className="absolute inset-0 scroll overflow-y-auto px-6 py-3">
        {resolved && entry ? (
          <ChatMessage
            entry={entry}
            isStreamingRow={running}
            sessionId={sessionId}
            directory={directory}
          />
        ) : null}
        {resolved ? (
          <div className="flex flex-col gap-0">
            {running && !root.any && !d?.reasoning && (
              <div className="flex items-center gap-1.5 px-1 text-[0.7857rem] text-muted-foreground/70">
                <PixelLoader variant="orbit" size="xs" />
                waiting for the agent's first output…
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
            <Bot className="size-4 text-muted-foreground/50" />
            <p className="text-[0.8214rem] leading-snug text-muted-foreground/70">
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
                  <Bot className="tool-tint size-3 shrink-0 text-purple-400" />
                  <span className="min-w-0 shrink-0 truncate text-[0.8571rem] font-medium text-foreground/80">
                    {block ? agentSessionDisplayName(name, bd?.title) : h.title}
                  </span>
                  {rowTask && (
                    <span className="min-w-0 flex-1 truncate font-mono text-[0.7857rem] text-muted-foreground/80">
                      {rowTask}
                    </span>
                  )}
                  {block && <AgentStatusDot status={agentStatusOf(block)} />}
                  <span className="shrink-0 text-[0.75rem] text-muted-foreground/70">
                    {formatRelative(h.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {!engaged && (
        <button
          type="button"
          aria-label="Scroll to bottom"
          onClick={() => {
            const el = bodyRef.current;
            if (!el) return;
            el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2.5 py-1 rounded-full bg-secondary border border-border shadow-lg text-[0.75rem] text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-150"
        >
          <ChevronDown className="size-3.5" />
          Live
        </button>
      )}
      </div>
    </div>
  );
}
