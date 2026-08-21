/** useGitAgentAction — dispatch a built-in sub-agent (e.g. commit-writer)
 *  from Git UI, or (agent omitted) run a plain model turn — on a HIDDEN
 *  utility session so git tooling never leaks turns into the user's active
 *  chat. There is no direct renderer→dispatch IPC: the mechanism is a chat
 *  turn whose prompt carries the same agent-mention hint the composer
 *  injects, so the orchestrator calls dispatch_agent and the report streams
 *  back over the normal agent event stream. This hook starts that turn on
 *  the utility session and mirrors the dispatch's report (falling back to
 *  the assistant text when the model answers inline instead of dispatching)
 *  out of the shared stream store — it never registers its own IPC
 *  listener, so cleanup is a plain store unsubscribe.
 *
 *  Utility sessions are created with kind 'subagent' (excluded from session
 *  lists and dispatch lists — invisible everywhere) at autonomy 'full' so
 *  the dispatch never waits on a permission card that can't render. One
 *  per workspace per app run. */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@/lib/api/client';
import { useUi } from '@/lib/stores/ui';
import type { SessionStream, ToolCall } from '@/types';

export interface GitAgentDispatchArgs {
  /** Workspace the utility session belongs to. */
  workspaceId: string;
  /** Built-in agent name (must exist in the dispatch_agent catalog). Omit for
   *  a plain model turn — no dispatch hint, assistant text mirrors as report. */
  agent?: string;
  /** Full task text handed to the agent. */
  task: string;
}

export interface GitAgentActionState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** Dispatch report — grows while streaming, final once done. */
  report: string;
  error: string | null;
}

export type GitAgentRunResult = { status: 'running' | 'done' | 'error'; report?: string };

const IDLE: GitAgentActionState = { status: 'idle', report: '', error: null };

/** Latest dispatch_agent report for `agent` (last matching call wins). */
function dispatchReportOf(toolCalls: ToolCall[] | undefined, agent: string): string {
  let report = '';
  for (const tc of toolCalls ?? []) {
    if (tc.toolName !== 'dispatch_agent') continue;
    const name = String(tc.arguments?.name ?? '');
    if (name && name !== agent) continue;
    const d = tc.display;
    if (d?.kind === 'agent' && d.report) report = d.report;
    else if (tc.output) report = tc.output;
  }
  return report;
}

const utilitySessions = new Map<string, Promise<string>>();

/** Find-or-create this workspace's hidden git-tools session. Model settings
 *  copy the active session (or the composer's selected model) so the turn
 *  bills to the provider the user actually uses. */
async function ensureUtilitySession(workspaceId: string): Promise<string> {
  const cached = utilitySessions.get(workspaceId);
  if (cached) return cached;
  const created = (async () => {
    let modelId = '';
    let providerId: string | undefined;
    const activeId = useUi.getState().activeSessionId;
    if (activeId) {
      const s = await api.getSession(activeId).catch(() => null);
      modelId = s?.modelId ?? '';
      providerId = s?.providerId ?? undefined;
    }
    if (!modelId) {
      const ui = useUi.getState();
      modelId = ui.selectedModelId ?? '';
      providerId = ui.selectedProviderId ?? undefined;
    }
    const s = await api.createSession(workspaceId, '✨ Git tools', modelId, {
      kind: 'subagent',
      autonomyMode: 'full',
      thinkingLevel: 'low',
      ...(providerId ? { providerId } : {}),
    });
    return s.id as string;
  })();
  utilitySessions.set(workspaceId, created);
  created.catch(() => utilitySessions.delete(workspaceId));
  return created;
}

export function useGitAgentAction(): {
  run: (args: GitAgentDispatchArgs) => GitAgentRunResult;
  state: GitAgentActionState;
  reset: () => void;
} {
  const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;
  const [state, setState] = useState<GitAgentActionState>(IDLE);
  // Store unsubscribe for the in-flight dispatch watch (also the unmount handle).
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const activeSidRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    activeSidRef.current = null;
  }, []);

  // Abort the turn WE started if the consumer unmounts mid-dispatch.
  useEffect(() => () => {
    const sid = activeSidRef.current;
    cleanup();
    if (sid && ipc && useUi.getState().streams[sid]?.isStreaming) ipc.abortTurn(sid);
  }, [cleanup, ipc]);

  const run = useCallback((args: GitAgentDispatchArgs): GitAgentRunResult => {
    if (!ipc) {
      console.warn('useGitAgentAction: IPC unavailable (browser dev mode)');
      return { status: 'error' };
    }
    setState({ status: 'running', report: '', error: null });

    void (async () => {
      try {
        const sid = await ensureUtilitySession(args.workspaceId);
        if (useUi.getState().streams[sid]?.isStreaming) {
          throw new Error('a git tool action is already running');
        }
        activeSidRef.current = sid;

        const session = await api.getSession(sid);
        const agents = args.agent ? await api.listAgents().catch(() => []) : [];
        const description = args.agent ? agents.find((a) => a.name === args.agent)?.description : undefined;

        const firstLine = args.task.split('\n')[0].slice(0, 120);
        const displayText = args.agent ? `✨ @${args.agent} — ${firstLine}` : `✨ ${firstLine}`;
        const promptText = args.agent
          ? [
              description
                ? `[User wants to use the "${args.agent}" agent — ${description} Dispatch via the dispatch_agent tool.]`
                : `[User wants to use the "${args.agent}" agent.]`,
              `<task>\n${args.task}\n</task>`,
              `Dispatch the "${args.agent}" agent with the task above via the dispatch_agent tool. Do not perform the task yourself and do not answer it directly.`,
            ].join('\n\n')
          : args.task;

        await api.addMessage(sid, 'user', displayText);

        // Self-contained tasks — no prior history keeps every action cheap
        // and stops git-tool prompts from cross-contaminating.
        const history: { role: 'user' | 'assistant'; content: string }[] = [];

        useUi.getState().resetStream(sid);
        useUi.getState().patchStream(sid, { isStreaming: true });
        useUi.getState().setSessionRunning(sid, true);

        // Watch the shared stream store for this dispatch's report + completion.
        let prevStream = useUi.getState().streams[sid];
        const finish = (next: GitAgentActionState) => {
          cleanup();
          setState(next);
        };
        const reportOf = (stream: SessionStream) => {
          if (!args.agent) return stream.text;
          // The model occasionally answers inline despite the imperative
          // dispatch instruction — its text IS the requested output then.
          return dispatchReportOf(stream.toolCalls, args.agent) || stream.text;
        };
        unsubscribeRef.current = useUi.subscribe((s) => {
          const stream = s.streams[sid];
          if (stream === prevStream || !stream) return;
          prevStream = stream;
          const report = reportOf(stream);
          if (stream.finalMessage && !stream.isStreaming) {
            const failed = !!stream.error || stream.stopReason === 'aborted';
            finish(failed
              ? { status: 'error', report, error: stream.error ?? `turn ${stream.stopReason ?? 'ended'}` }
              : { status: 'done', report, error: null });
            return;
          }
          if (stream.error) {
            finish({ status: 'error', report, error: stream.error });
            return;
          }
          setState((cur) => (cur.status === 'running' ? { ...cur, report } : cur));
        });

        await ipc.runTurn({
          sessionId: sid,
          messages: [
            { role: 'system', content: 'You are Tide, an agentic coding assistant. Carry out the user\'s request using your tools.' },
            ...history,
            { role: 'user', content: promptText },
          ],
          modelId: session?.modelId ?? '',
          providerId: session?.providerId ?? '',
          autonomyMode: 'full',
          thinkingLevel: 'low',
        });

        // runTurn resolved but no turn_end landed (empty turn) — settle with
        // whatever report arrived, mirroring useChatStream's finally guard.
        if (activeSidRef.current === sid) {
          const stream = useUi.getState().streams[sid];
          if (stream?.isStreaming) {
            useUi.getState().patchStream(sid, { isStreaming: false });
            finish({ status: 'done', report: reportOf(stream), error: null });
          }
        }
      } catch (err: any) {
        if (activeSidRef.current) {
          useUi.getState().patchStream(activeSidRef.current, { isStreaming: false });
          useUi.getState().setSessionRunning(activeSidRef.current, false);
        }
        cleanup();
        setState({ status: 'error', report: '', error: err?.message ?? String(err) });
      }
    })();

    return { status: 'running' };
  }, [cleanup, ipc]);

  const reset = useCallback(() => {
    cleanup();
    setState(IDLE);
  }, [cleanup]);

  return { run, state, reset };
}
