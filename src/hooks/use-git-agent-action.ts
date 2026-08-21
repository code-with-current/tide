/** useGitAgentAction — dispatch a built-in sub-agent (e.g. commit-writer)
 *  from Git UI. There is no direct renderer→dispatch IPC: the mechanism is a
 *  chat turn whose prompt carries the same agent-mention hint the composer
 *  injects, so the orchestrator calls dispatch_agent and the report streams
 *  back over the normal agent event stream. This hook starts that turn and
 *  mirrors the dispatch's report out of the shared stream store (maintained
 *  by useChatStream's mount-once listener) — it never registers its own IPC
 *  listener, so cleanup is a plain store unsubscribe.
 *
 *  The turn is visible in the session's chat (user line + dispatch row +
 *  report); MainScreen's freeze effect persists the assistant message as
 *  usual. */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@/lib/api/client';
import { useUi } from '@/lib/stores/ui';
import type { ToolCall } from '@/types';

export interface GitAgentDispatchArgs {
  /** Session the dispatch turn runs on. Dispatch needs one — absent means no-op. */
  sessionId: string | null | undefined;
  /** Built-in agent name (must exist in the dispatch_agent catalog). */
  agent: string;
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
    if (!args.sessionId) {
      console.warn('useGitAgentAction: agent dispatch requires an active session');
      return { status: 'error' };
    }
    if (useUi.getState().streams[args.sessionId]?.isStreaming) {
      console.warn('useGitAgentAction: session already streaming — not dispatching');
      return { status: 'error' };
    }

    const sid = args.sessionId;
    activeSidRef.current = sid;
    setState({ status: 'running', report: '', error: null });

    // Watch the shared stream store for this dispatch's report + completion.
    let prevStream = useUi.getState().streams[sid];
    const finish = (next: GitAgentActionState) => {
      cleanup();
      setState(next);
    };
    unsubscribeRef.current = useUi.subscribe((s) => {
      const stream = s.streams[sid];
      if (stream === prevStream || !stream) return;
      prevStream = stream;
      const report = dispatchReportOf(stream.toolCalls, args.agent);
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

    void (async () => {
      try {
        const session = await api.getSession(sid);
        const agents = await api.listAgents().catch(() => []);
        const description = agents.find((a) => a.name === args.agent)?.description;

        const displayText = `✨ @${args.agent} — ${args.task.split('\n')[0].slice(0, 120)}`;
        const promptText = [
          description
            ? `[User wants to use the "${args.agent}" agent — ${description} Dispatch via the dispatch_agent tool if the task matches, or apply its approach directly.]`
            : `[User wants to use the "${args.agent}" agent.]`,
          `<task>\n${args.task}\n</task>`,
          `Dispatch the "${args.agent}" agent with the task above via the dispatch_agent tool instead of answering it yourself.`,
        ].join('\n\n');

        await api.addMessage(sid, 'user', displayText);

        const history = (session?.messages ?? [])
          .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .map((m: { role: string; content: string }) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        useUi.getState().resetStream(sid);
        useUi.getState().patchStream(sid, { isStreaming: true });
        useUi.getState().setSessionRunning(sid, true);
        prevStream = useUi.getState().streams[sid];

        await ipc.runTurn({
          sessionId: sid,
          messages: [
            { role: 'system', content: 'You are Tide, an agentic coding assistant. Carry out the user\'s request using your tools.' },
            ...history,
            { role: 'user', content: promptText },
          ],
          modelId: session?.modelId ?? '',
          providerId: session?.providerId ?? '',
          autonomyMode: session?.autonomyMode ?? 'ask',
          thinkingLevel: session?.thinkingLevel ?? 'medium',
        });

        // runTurn resolved but no turn_end landed (empty turn) — settle with
        // whatever report arrived, mirroring useChatStream's finally guard.
        if (activeSidRef.current === sid) {
          const stream = useUi.getState().streams[sid];
          if (stream?.isStreaming) {
            useUi.getState().patchStream(sid, { isStreaming: false });
            finish({ status: 'done', report: dispatchReportOf(stream.toolCalls, args.agent), error: null });
          }
        }
      } catch (err: any) {
        if (activeSidRef.current === sid) {
          useUi.getState().patchStream(sid, { isStreaming: false });
          useUi.getState().setSessionRunning(sid, false);
          finish({ status: 'error', report: '', error: err?.message ?? String(err) });
        }
      }
    })();

    return { status: 'running' };
  }, [ipc, cleanup]);

  const reset = useCallback(() => {
    cleanup();
    setState(IDLE);
  }, [cleanup]);

  return { run, state, reset };
}
