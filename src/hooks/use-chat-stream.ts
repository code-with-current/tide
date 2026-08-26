/** Thin façade over per-session streaming state in useUi.streams[sessionId]; a mount-once IPC listener routes events by sessionId so sessions stream in parallel. */

import { useCallback, useEffect } from 'react';
import type { AgentEvent, RunTurnPayload } from '@/lib/agent/events';
import type { SessionStream } from '@/types';
import { useUi, freshStream } from '@/lib/stores/ui';
import { reduceStream } from '@/lib/stream/stream-reducer';
import { notifyPermissionRequired, notifyTurnEnd } from '@/lib/sounds';
import { hasRpc, onAgentEvent } from '@/lib/api/rpc';
import {
  chatAbort,
  chatApproveTools,
  chatRejectTools,
  chatSend,
  chatSubmitFollowup,
} from '@/lib/api/client';

export interface ChatStreamStartArgs {
  sessionId: string;
  messages: RunTurnPayload['messages'];
  modelId: string;
  providerId: string;
  autonomyMode: RunTurnPayload['autonomyMode'];
  thinkingLevel: RunTurnPayload['thinkingLevel'];
}

/** Optimistically remove resolved cards from the pending permission set so the UI stays snappy and parallel cards stay visible. */
function removePendingPermissionCards(sessionId: string, ids: string[]): void {
  useUi.getState().removePermissionCards(sessionId, ids);
}

/** Flip approved tool rows back to `running` so the inline permission cards
 *  unmount — the next tool_result for the same id lands the final status. */
function markApprovedToolCallsRunning(sessionId: string, ids: string[]): void {
  const stream = useUi.getState().streams[sessionId];
  if (!stream) return;
  const idSet = new Set(ids);
  const patch: Partial<SessionStream> = {};
  if (stream.toolCalls.some((c) => idSet.has(c.id) && c.status === 'awaiting_input')) {
    patch.toolCalls = stream.toolCalls.map((c) =>
      idSet.has(c.id) && c.status === 'awaiting_input' ? { ...c, status: 'running' as const } : c,
    );
  }
  const blocks = stream.blocks;
  if (blocks?.some((b) => b.kind === 'tool' && b.toolCallId != null && idSet.has(b.toolCallId) && b.status === 'awaiting_input')) {
    patch.blocks = blocks.map((b) =>
      b.kind === 'tool' && b.toolCallId != null && idSet.has(b.toolCallId) && b.status === 'awaiting_input'
        ? { ...b, status: 'running' as const }
        : b,
    );
  }
  if (patch.toolCalls || patch.blocks) useUi.getState().patchStream(sessionId, patch);
}

export function useChatStream(): {
  start: (args: ChatStreamStartArgs) => Promise<void>;
  abort: (sessionId: string) => void;
  approveToolCalls: (sessionId: string, toolCallIds: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) => void;
  rejectToolCalls: (sessionId: string, toolCallIds: string[], reason?: string) => void;
  submitFollowup: (sessionId: string, toolCallId: string, answer: string) => Promise<boolean>;
} {
  const start = useCallback(
    async (args: ChatStreamStartArgs) => {
      // Reset this session's stream entry to a fresh state. Other sessions'
      // entries are untouched — they keep streaming if they were.
      useUi.getState().resetStream(args.sessionId);
      useUi.getState().patchStream(args.sessionId, { isStreaming: true });
      useUi.getState().setSessionRunning(args.sessionId, true);

      if (hasRpc) {
        // Job pattern: the request resolves on acceptance; every outcome
        // after that (deltas, errors, turn_end) arrives as an agent event,
        // which alone may clear isStreaming. A pre-flight rejection is the
        // only synchronous failure.
        const res = await chatSend({
          sessionId: args.sessionId,
          messages: args.messages,
          modelId: args.modelId,
          providerId: args.providerId,
          autonomyMode: args.autonomyMode,
          thinkingLevel: args.thinkingLevel,
        });
        if (!res.accepted) {
          useUi.getState().patchStream(args.sessionId, {
            error: res.error,
            isStreaming: false,
          });
          useUi.getState().setSessionRunning(args.sessionId, false);
        }
        return;
      }

      // Browser dev (no backend): nothing streams — leave the mock UI as is.
    },
    [],
  );

  const abort = useCallback(
    (sessionId: string) => {
      if (!hasRpc) return;
      // Don't clear local state here — the orchestrator emits a turn_end with partial work that drives cleanup so the freeze effect can persist it.
      chatAbort(sessionId);
      // Just dismiss any pending permission prompt for this session.
      useUi.getState().patchStream(sessionId, { permissionRequest: null });
    },
    [],
  );

  const approveToolCalls = useCallback(
    (
      sessionId: string,
      toolCallIds: string[],
      newMode?: 'plan' | 'ask' | 'edit' | 'full',
      remember?: boolean,
    ) => {
      if (!hasRpc) return;
      chatApproveTools(sessionId, toolCallIds, newMode, remember);
      markApprovedToolCallsRunning(sessionId, toolCallIds);
      // Mode escalation auto-approves every other pending ask main-side —
      // dismiss their cards in the same pass so no dead cards linger.
      const dismissIds = newMode
        ? (useUi.getState().streams[sessionId]?.permissionRequest?.toolCalls ?? []).map((tc) => tc.id)
        : toolCallIds;
      removePendingPermissionCards(sessionId, dismissIds);
      // The main process mutates ctx.autonomyMode for the rest of the turn
      // when newMode is set — mirror that in the UI store so the chat
      // selector reflects the effective mode. (remember:* only adds a
      // permission rule, not a mode change, so it doesn't move the selector.)
      if (newMode) useUi.getState().setAutonomyMode(newMode);
    },
    [],
  );

  const rejectToolCalls = useCallback(
    (sessionId: string, toolCallIds: string[], reason?: string) => {
      if (!hasRpc) return;
      chatRejectTools(sessionId, toolCallIds, reason);
      removePendingPermissionCards(sessionId, toolCallIds);
    },
    [],
  );

  const submitFollowup = useCallback(
    async (sessionId: string, toolCallId: string, answer: string): Promise<boolean> => {
      if (!hasRpc) return false;
      try {
        // True = the paused turn's awaiting tool resolved. False = no pending
        // ask (turn already ended) — the caller decides how to deliver the
        // answer; dismissing the popup below happens either way.
        const resolved = await chatSubmitFollowup(sessionId, toolCallId, answer);
        return resolved === true;
      } catch {
        return false;
      } finally {
        // Dismiss any popup the FollowupPrompt component may have fired from
        // the persisted followup block — the live tool_result event will
        // update the block state. Without this the popup lingers.
        useUi.getState().dismissOptionsPopup(sessionId);
      }
    },
    [],
  );

  // ─── Single mount-once event listener ──────────────────────────────────────
  // Registered once for the hook's lifetime; routes every event by event.sessionId so concurrent sessions update independently. Maintains the new `blocks` view plus legacy fields (in sync until Tasks 12-14 land).
  useEffect(() => {
    if (!hasRpc) return;

    // Per-session event queue coalescing events into one reducer pass + commit per 50ms. Urgent events (turn_end/error/permission_required/followup_required) flush immediately. Fixes an out-of-order bug where tool events applied synchronously rendered before preceding text deltas.
    const FLUSH_MS = 50;
    const queues = new Map<string, AgentEvent[]>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const flushNow = (sid: string) => {
      const t = timers.get(sid);
      if (t) { clearTimeout(t); timers.delete(sid); }
      const batch = queues.get(sid);
      if (!batch || batch.length === 0) return;
      queues.set(sid, []);
      // One store mutation per batch — one React commit.
      useUi.setState((s) => {
        const cur = s.streams[sid] ?? freshStream();
        let next = cur;
        // Run the block-stream reducer over every event in the batch.
        for (const ev of batch) next = reduceStream(next, ev);
        // Also keep legacy fields in sync until Tasks 12-14 land.
        // We do this in the same setState so it's still one commit.
        for (const ev of batch) {
          next = applyLegacyEvent(next, ev);
        }
        return { streams: { ...s.streams, [sid]: next } };
      });
    };

    const onEvent = (event: AgentEvent) => {
      const sid = event.sessionId;
      if (event.type === 'turn_end') {
        notifyTurnEnd(sid, event.stopReason);
      } else if (event.type === 'permission_required') {
        notifyPermissionRequired(sid, event.toolCalls.map((tc) => tc.id));
      }
      const urgent = event.type === 'turn_end' || event.type === 'error'
                  || event.type === 'retry'
                  || event.type === 'compacting'
                  || event.type === 'permission_required'
                  || event.type === 'followup_required'
                  || event.type === 'dispatch_result';
      const arr = queues.get(sid) ?? [];
      arr.push(event);
      queues.set(sid, arr);
      if (urgent) { flushNow(sid); return; }
      if (timers.has(sid)) return;
      timers.set(sid, setTimeout(() => {
        timers.delete(sid);
        flushNow(sid);
      }, FLUSH_MS));
    };

    // Electrobun webview: the agentEvents RPC message.
    const unregister = onAgentEvent(onEvent);

    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      queues.clear();
      unregister();
    };
  }, []);

  return { start, abort, approveToolCalls, rejectToolCalls, submitFollowup };
}

// ─── Legacy-field back-compat bridge ─────────────────────────────────────
// Keeps the legacy text/toolCalls/timeline/turn/reasoning/finalMessage fields in sync with events until Tasks 12-14 rewire components to read from `blocks`. Runs in the same setState as the reducer; returns a new SessionStream.
function applyLegacyEvent(state: SessionStream, event: AgentEvent): SessionStream {
  switch (event.type) {
    case 'delta': {
      // Parented deltas are sub-agent narration (Agents panel) — the
      // parent's legacy text/timeline must not accumulate them.
      if (event.parentToolCallId) return state;
      // Append to legacy `text` + maintain the timeline's last text entry.
      // Clear the compacting flag — compaction finished, the model is now
      // streaming the next step. Content also dismisses the retry indicator —
      // the retried request is producing output again, so it succeeded.
      const timeline = appendTextToTimeline(state.timeline, event.text);
      return { ...state, text: state.text + event.text, timeline, compacting: false, retry: null };
    }
    case 'reasoning':
      if (event.parentToolCallId) return state;
      return { ...state, reasoning: state.reasoning + event.delta, retry: null };
    case 'tool_call_start': {
      const toolIndex = state.toolCalls.length;
      return {
        ...state,
        retry: null,
        toolCalls: [
          ...state.toolCalls,
          {
            id: event.toolCallId,
            messageId: event.messageId,
            toolName: event.toolName,
            arguments: {}, argPreview: '', status: 'pending',
            riskTier: 'read_only',
          },
        ],
        timeline: [...state.timeline, { type: 'tool', toolIndex }],
      };
    }
    case 'tool_call_delta': {
      return {
        ...state,
        toolCalls: state.toolCalls.map((c) => {
          if (c.id !== event.toolCallId) return c;
          if (c.status === 'running' && c.toolName === 'dispatch_agent') {
            const d = c.display;
            if (d?.kind === 'agent') {
              return { ...c, display: { ...d, report: (d.report ?? '') + event.delta } };
            }
            return {
              ...c,
              display: {
                kind: 'agent' as const,
                agentName: String(c.arguments?.name ?? ''),
                task: String(c.arguments?.task ?? ''),
                report: event.delta,
              },
            };
          }
          return { ...c, _partialInput: (c._partialInput ?? '') + event.delta };
        }),
      };
    }
    case 'tool_call':
      return {
        ...state,
        toolCalls: state.toolCalls.map((c) =>
          c.id === event.toolCallId
            ? { ...c, arguments: event.arguments, argPreview: event.argPreview, riskTier: event.riskTier }
            : c,
        ),
      };
    case 'tool_executing':
      return {
        ...state,
        toolCalls: state.toolCalls.map((c) =>
          c.id === event.toolCallId ? { ...c, status: 'running' } : c,
        ),
      };
    case 'tool_result':
      return {
        ...state,
        toolCalls: state.toolCalls.map((c) =>
          c.id === event.toolCallId
            ? {
                ...c,
                status: event.status,
                output: event.output,
                display: event.display,
                durationMs: event.durationMs,
                meta: event.meta,
              }
            : c,
        ),
      };
    case 'dispatch_result': {
      // A background dispatch finished. Fold the terminal state onto the
      // matching dispatch row, then inject the report as a synthetic queued
      // message (friendly display text; the model receives the XML wrapper
      // as promptText) so the parent turn picks it up via the queue drain.
      const tag = event.state === 'error' ? 'task_error' : 'task_result';
      const xml = [
        `<task id="${event.dispatchId}" state="${event.state}">`,
        `<summary>Background task ${event.state}: ${event.title ?? event.dispatchId}</summary>`,
        `<${tag}>`,
        event.report,
        `</${tag}>`,
        '</task>',
      ].join('\n');
      const display = `↻ ${event.title ?? 'background task'} — ${event.state}`;
      useUi.getState().enqueueMessage(event.sessionId, display, xml, true);
      return {
        ...state,
        toolCalls: state.toolCalls.map((c) => {
          const d = c.display;
          if (d?.kind === 'agent' && d.dispatchId === event.dispatchId) {
            return { ...c, display: { ...d, backgroundState: event.state } };
          }
          return c;
        }),
      };
    }
    case 'usage':
      return {
        ...state,
        usage: event.tokens,
        iteration: event.iteration,
        sessionCostUsd: event.runningTotalUsd ?? state.sessionCostUsd,
      };
    case 'permission_required': {
      // Append (dedupe by id) — parallel gated tools in one step each emit
      // their own permission_required; accumulate so all cards render and
      // each can be approved independently. Replacing here stranded the
      // others' awaits with no UI to resolve them.
      // Flag the gated rows in the legacy toolCalls mirror (blocks are patched
      // by the stream reducer) — the inline PermissionCard mounts only on
      // pending|awaiting_input, but tool_executing already marked them running.
      const gatedIds = new Set(event.toolCalls.map((t: { id: string }) => t.id));
      const toolCalls = state.toolCalls.some((c) => gatedIds.has(c.id) && c.status !== 'awaiting_input')
        ? state.toolCalls.map((c) =>
            gatedIds.has(c.id) && c.status !== 'awaiting_input' ? { ...c, status: 'awaiting_input' as const } : c,
          )
        : state.toolCalls;
      const base = toolCalls === state.toolCalls ? state : { ...state, toolCalls };
      const prev = base.permissionRequest;
      if (!prev) return { ...base, permissionRequest: { toolCalls: event.toolCalls, timeoutAt: event.timeoutAt } };
      const seen = new Set(prev.toolCalls.map((t) => t.id));
      const merged = [...prev.toolCalls, ...event.toolCalls.filter((t: { id: string }) => !seen.has(t.id))];
      return { ...base, permissionRequest: { toolCalls: merged, timeoutAt: event.timeoutAt ?? prev.timeoutAt } };
    }
    case 'followup_required':
      // Fire the options popup directly. Unlike persisted followup blocks
      // (which trigger the popup via FollowupPrompt's useEffect), the live
      // event arrives while the turn is paused — we surface the popup
      // immediately so the user can answer.
      useUi.getState().showOptionsPopup(event.sessionId, {
        question: event.question,
        multiple: event.multiple,
        options: event.options,
        optionDescriptions: event.optionDescriptions,
        messageId: event.toolCallId,
        toolCallId: event.toolCallId,
      });
      return state;
    case 'turn_end': {
      // Freeze the final message — the freeze effect watches this field.
      // The orchestrator's `blocks` is the canonical truth; legacy fields
      // mirror it for back-compat with existing components.
      return {
        ...state,
        isStreaming: false,
        stopReason: event.stopReason,
        permissionRequest: null,
        retry: null,
        compacting: false,
        finalMessage: {
          messageId: event.messageId,
          content: event.content ?? '',
          timeline: event.timeline,
          blocks: event.blocks,
          reasoning: event.reasoning,
          reasoningTokens: event.reasoningTokens,
          totalMs: event.totalMs,
          toolCalls: event.toolCalls,
          usage: event.usage,
          lastStepUsage: event.lastStepUsage,
        },
      };
    }
    case 'retry':
      // Orchestrator is retrying — keep streaming, clear the error, track the attempt.
      return {
        ...state,
        error: null,
        isStreaming: true,
        retry: { attempt: event.attempt, maxAttempts: event.maxAttempts, reason: event.reason },
      };
    case 'compacting': {
      // Autocompact is summarizing the conversation. Show the indicator.
      // When tokensAfter is present, compaction is done — store the counts
      // for the meter's "compacted N→M" annotation and update the live usage
      // so the context meter drops immediately instead of waiting for the
      // next step's UsageEvent.
      if (event.tokensAfter !== undefined) {
        const prevUsage = state.usage;
        const updatedUsage = prevUsage
          ? { ...prevUsage, inputTokens: event.tokensAfter }
          : { inputTokens: event.tokensAfter, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, calls: 0, costUsd: 0 };
        return {
          ...state,
          compacting: false,
          compactedTokens: { before: event.tokensBefore, after: event.tokensAfter },
          usage: updatedUsage,
        };
      }
      return { ...state, compacting: true };
    }
    case 'error':
      // Record the error but keep streaming — the orchestrator may retry. The
      // retry event clears this; turn_end ends the turn. Without this, the
      // error block would flash on (isStreaming=false) then off (retry clears
      // it) between attempts. error UI only shows once retries are exhausted.
      return { ...state, error: event.message };
    default:
      return state;
  }
}

/** Append a text chunk to the live timeline, starting a new entry if the last was a tool; copies only the last entry to avoid O(N) allocations per delta. */
function appendTextToTimeline(
  timeline: SessionStream['timeline'],
  chunk: string,
): SessionStream['timeline'] {
  if (!chunk) return timeline;
  const last = timeline[timeline.length - 1];
  if (last && last.type === 'text') {
    // Reuse all but the last entry (same reference); only clone the last.
    return [
      ...timeline.slice(0, -1),
      { type: 'text' as const, text: last.text + chunk },
    ];
  }
  return [...timeline, { type: 'text', text: chunk }];
}
