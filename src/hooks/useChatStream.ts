/**
 * Thin façade over the per-session streaming state in the UI store.
 *
 * Previously this hook held one blob of streaming state (streamingText,
 * streamingToolCalls, etc.) and its IPC listener dropped events for any
 * session that wasn't the most recently started one — so two sessions
 * couldn't stream in parallel.
 *
 * Now all streaming state lives in `useUi.streams[sessionId]` (keyed by
 * session). This hook:
 *   - Wires a single mount-once IPC listener that routes events by
 *     event.sessionId into the right session's store entry.
 *   - Exposes start/abort/approve/reject actions that take an explicit
 *     sessionId argument.
 *   - Exposes nothing else — MainScreen reads streaming fields directly
 *     from the store via selectors.
 *
 * The per-session microtask coalescer ensures bursts of tokens for one
 * session don't stomp another session's buffer.
 */

import { useCallback, useEffect } from 'react';
import type { AgentEvent, RunTurnPayload } from '@/lib/agent/events';
import type { SessionStream } from '@/types';
import { useUi, freshStream } from '@/lib/stores/ui';
import { reduceStream } from '@/lib/stream/streamReducer';

export interface ChatStreamStartArgs {
  sessionId: string;
  messages: RunTurnPayload['messages'];
  modelId: string;
  providerId: string;
  autonomyMode: RunTurnPayload['autonomyMode'];
  thinkingLevel: RunTurnPayload['thinkingLevel'];
}

/**
 * Optimistically remove resolved cards from the pending permission set. The
 * server resolves the tool independently; this keeps the UI snappy and lets
 * parallel cards remain visible while one is acted on (Phase 2 batched queue —
 * tool_result no longer wipes permissionRequest, so approve/reject must filter).
 */
function removePendingPermissionCards(sessionId: string, ids: string[]): void {
  useUi.getState().removePermissionCards(sessionId, ids);
}

export function useChatStream(): {
  start: (args: ChatStreamStartArgs) => Promise<void>;
  abort: (sessionId: string) => void;
  approveToolCalls: (sessionId: string, toolCallIds: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) => void;
  rejectToolCalls: (sessionId: string, toolCallIds: string[], reason?: string) => void;
  submitFollowup: (sessionId: string, toolCallId: string, answer: string) => void;
} {
  const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;

  const start = useCallback(
    async (args: ChatStreamStartArgs) => {
      if (!ipc) return;
      // Reset this session's stream entry to a fresh state. Other sessions'
      // entries are untouched — they keep streaming if they were.
      useUi.getState().resetStream(args.sessionId);
      useUi.getState().patchStream(args.sessionId, { isStreaming: true });
      useUi.getState().setSessionRunning(args.sessionId, true);

      try {
        await ipc.runTurn({
          sessionId: args.sessionId,
          messages: args.messages,
          modelId: args.modelId,
          providerId: args.providerId,
          autonomyMode: args.autonomyMode,
          thinkingLevel: args.thinkingLevel,
        });
      } catch (err: any) {
        useUi.getState().patchStream(args.sessionId, {
          error: err?.message || 'Failed to start turn',
          isStreaming: false,
        });
      } finally {
        // Always clear the running indicator when the turn's IPC call
        // returns — covers the case where the turn ends with no result and
        // no throw (no finalMessage, so the MainScreen freeze effect never
        // fires). Without this, the session chat indicator stays stuck on
        // "processing" after a no-result turn. setSessionRunning is a no-op
        // when the state already matches, so this is safe alongside the
        // finalMessage effect's own clear.
        useUi.getState().setSessionRunning(args.sessionId, false);
        // Also ensure isStreaming clears if no turn_end event arrived.
        if (useUi.getState().streams[args.sessionId]?.isStreaming) {
          useUi.getState().patchStream(args.sessionId, { isStreaming: false });
        }
      }
    },
    [ipc],
  );

  const abort = useCallback(
    (sessionId: string) => {
      if (!ipc) return;
      // Tell the main process to abort. Do NOT clear local streaming state
      // here — the orchestrator's catch block emits a turn_end with the
      // partial work accumulated so far, and that event drives the cleanup
      // (isStreaming false, finalMessage set) so the freeze effect can
      // persist the partial message before the bubble disappears.
      ipc.abortTurn(sessionId);
      // Just dismiss any pending permission prompt for this session.
      useUi.getState().patchStream(sessionId, { permissionRequest: null });
    },
    [ipc],
  );

  const approveToolCalls = useCallback(
    (
      sessionId: string,
      toolCallIds: string[],
      newMode?: 'plan' | 'ask' | 'edit' | 'full',
      remember?: boolean,
    ) => {
      if (!ipc) return;
      ipc.approveToolCalls(sessionId, toolCallIds, newMode, remember);
      removePendingPermissionCards(sessionId, toolCallIds);
      // The main process mutates ctx.autonomyMode for the rest of the turn
      // when newMode is set — mirror that in the UI store so the chat
      // selector reflects the effective mode. (remember:* only adds a
      // permission rule, not a mode change, so it does not move the selector.)
      if (newMode) useUi.getState().setAutonomyMode(newMode);
    },
    [ipc],
  );

  const rejectToolCalls = useCallback(
    (sessionId: string, toolCallIds: string[], reason?: string) => {
      if (!ipc) return;
      ipc.rejectToolCalls(sessionId, toolCallIds, reason);
      removePendingPermissionCards(sessionId, toolCallIds);
    },
    [ipc],
  );

  const submitFollowup = useCallback(
    (sessionId: string, toolCallId: string, answer: string) => {
      if (!ipc) return;
      ipc.submitFollowup(sessionId, toolCallId, answer);
      // Dismiss any popup the FollowupPrompt component may have fired from
      // the persisted followup block — the live tool_result event will
      // update the block state. Without this the popup lingers.
      useUi.getState().dismissOptionsPopup(sessionId);
    },
    [ipc],
  );

  // ─── Single mount-once IPC listener ──────────────────────────────────────
  // Registered exactly once for the hook's lifetime. Routes every event to
  // the per-session entry in the store by event.sessionId. No event is
  // dropped — concurrent streams for different sessions update independently.
  //
  // The listener maintains TWO parallel views of the streaming state:
  //   1. `blocks` — the new canonical block-stream model (driven by
  //      streamReducer, one commit per flush, ordering is structural).
  //   2. The legacy `text`/`toolCalls`/`timeline`/`turn`/`reasoning` fields
  //      — kept in sync until Tasks 12-14 rewrite the components to read
  //      from `blocks`. Once that lands, the legacy maintenance dies.
  useEffect(() => {
    if (!ipc) return;

    // Per-session event queue. Events accumulate here in arrival order;
    // a 50ms timer coalesces them into one reducer pass + one store
    // commit. Urgent events (turn_end, error, permission_required) flush
    // immediately — they're user-visible state transitions.
    //
    // This fixes the prior out-of-order bug: the old code flushed text
    // deltas via setTimeout but applied tool events synchronously, so a
    // tool that arrived between two text deltas would render before the
    // text that should have preceded it. With the queue, ordering is
    // structural: events are applied in arrival order, period.
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

    ipc.onAgentEvent((event: AgentEvent) => {
      const sid = event.sessionId;
      const urgent = event.type === 'turn_end' || event.type === 'error'
                  || event.type === 'retry'
                  || event.type === 'permission_required'
                  || event.type === 'followup_required';
      const arr = queues.get(sid) ?? [];
      arr.push(event);
      queues.set(sid, arr);
      if (urgent) { flushNow(sid); return; }
      if (timers.has(sid)) return;
      timers.set(sid, setTimeout(() => {
        timers.delete(sid);
        flushNow(sid);
      }, FLUSH_MS));
    });

    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      queues.clear();
      if (ipc) ipc.removeAllAgentListeners();
    };
  }, [ipc]);

  return { start, abort, approveToolCalls, rejectToolCalls, submitFollowup };
}

// ─── Legacy-field back-compat bridge ─────────────────────────────────────
//
// The block-stream reducer (above) maintains `blocks` — the new canonical
// shape. But until Tasks 12-14 land, the renderer's ThinkingSection,
// ProcessSection, AnswerBlock, etc. still read the legacy `text`/
// `toolCalls`/`timeline`/`turn`/`reasoning`/`finalMessage` fields. This
// helper keeps those fields in sync with the events.
//
// DEATH MARCH: every task that rewires a component to read from blocks
// removes one field from this helper. Once all components are migrated,
// this whole function goes away and only the reducer drives state.
//
// Runs INSIDE the same setState as the reducer, so it's still one commit
// per batch. Returns a new SessionStream; never mutates its argument.
function applyLegacyEvent(state: SessionStream, event: AgentEvent): SessionStream {
  switch (event.type) {
    case 'delta': {
      // Append to legacy `text` + maintain the timeline's last text entry.
      // Clear the compacting flag — compaction finished, the model is now
      // streaming the next step.
      const timeline = appendTextToTimeline(state.timeline, event.text);
      return { ...state, text: state.text + event.text, timeline, compacting: false };
    }
    case 'reasoning':
      return { ...state, reasoning: state.reasoning + event.delta };
    case 'tool_call_start': {
      const toolIndex = state.toolCalls.length;
      return {
        ...state,
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
      const prev = state.permissionRequest;
      if (!prev) return { ...state, permissionRequest: { toolCalls: event.toolCalls, timeoutAt: event.timeoutAt } };
      const seen = new Set(prev.toolCalls.map((t) => t.id));
      const merged = [...prev.toolCalls, ...event.toolCalls.filter((t: { id: string }) => !seen.has(t.id))];
      return { ...state, permissionRequest: { toolCalls: merged, timeoutAt: event.timeoutAt ?? prev.timeoutAt } };
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
          content: event.content ?? '',
          timeline: event.timeline,
          blocks: event.blocks,
          reasoning: event.reasoning,
          reasoningTokens: event.reasoningTokens,
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
    case 'compacting':
      // Autocompact is summarizing the conversation. Show a brief indicator.
      return { ...state, compacting: true };
    case 'error':
      return { ...state, error: event.message, isStreaming: false, retry: null, permissionRequest: null };
    default:
      return state;
  }
}

/** Append a text chunk to the live timeline. If the last timeline entry is
 *  a tool (or empty), start a new text entry. Returns a new array; never
 *  mutates the input.
 *
 *  Performance: only the LAST entry is copied — the rest are reused by
 *  reference. This avoids O(N) object allocations per delta on long
 *  conversations with many timeline entries. */
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
