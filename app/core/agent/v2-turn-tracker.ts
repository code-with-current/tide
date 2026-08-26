/** Pure per-turn sequencer for the part-normalized (v2) event stream.
 *  Consumes the orchestrator's stream boundaries (text deltas keyed by legacy
 *  block id, tool start/end keyed by toolCallId) and produces SinkEvents in
 *  commit order. No sink/db dependency — the orchestrator owns emission and
 *  failure guarding. Close-out is idempotent: after finish/abort every method
 *  returns no events, so a double close (abortAllTurns + emitTurnEnd racing
 *  app quit) can't double-emit message.end and double-count usage. */

import type { ToolCallStatus } from '../../../src/types/index.js';
import type { SinkEvent } from './event-sink.js';
import { newV2PartId, orchestratorEventToSink, type OrchestratorUsage } from './orchestrator-events.js';

export interface V2ToolEnd {
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  status: ToolCallStatus;
  durationMs?: number;
}

export interface V2TurnTracker {
  /** Stream a text delta for the given legacy text-block id. Same id appends
   *  to the open part; a changed id commits the old part (block boundary) and
   *  opens a new one. Empty text opens no part. */
  textDelta(textBlockId: string, text: string): SinkEvent[];
  /** Tool call forming (tool-input-start): commits any open text part and
   *  arms a part id for the toolCallId. */
  toolStart(toolCallId: string): SinkEvent[];
  /** Tool result/error: commits the armed tool part. Unknown toolCallId
   *  (no matching start) is a defensive no-op. */
  toolEnd(toolCallId: string, call: V2ToolEnd): SinkEvent[];
  /** Close the turn: commit any open part, then message.end (usage) and
   *  turn.end. Subsequent calls return no events. */
  finish(usage: OrchestratorUsage): SinkEvent[];
  /** Close the turn from an abort path; usage defaults to zero. */
  abort(usage?: OrchestratorUsage): SinkEvent[];
}

export function createV2TurnTracker(opts: { sessionId: string; messageId: string }): V2TurnTracker {
  const { sessionId, messageId } = opts;
  let partIndex = 0;
  let openText: { partId: string; blockId: string; text: string } | null = null;
  const openTools = new Map<string, string>();
  let closed = false;

  function commitText(): SinkEvent[] {
    if (!openText) return [];
    const part = openText;
    openText = null;
    const event = orchestratorEventToSink(sessionId, messageId, part.partId, { type: 'text-end', text: part.text }, partIndex);
    partIndex++;
    return event ? [event] : [];
  }

  function close(usage: OrchestratorUsage): SinkEvent[] {
    if (closed) return [];
    closed = true;
    const end = orchestratorEventToSink(sessionId, messageId, undefined, { type: 'finish', usage });
    const boundary = orchestratorEventToSink(sessionId, messageId, undefined, { type: 'turn-end' });
    return [
      ...commitText(),
      ...(end ? [end] : []),
      ...(boundary ? [boundary] : []),
    ];
  }

  return {
    textDelta(textBlockId, text) {
      if (closed || !text) return [];
      const events: SinkEvent[] = [];
      if (!openText || openText.blockId !== textBlockId) {
        events.push(...commitText());
        openText = { partId: newV2PartId(), blockId: textBlockId, text: '' };
      }
      openText.text += text;
      const delta = orchestratorEventToSink(sessionId, messageId, openText.partId, { type: 'text-delta', text });
      if (delta) events.push(delta);
      return events;
    },
    toolStart(toolCallId) {
      if (closed) return [];
      const committed = commitText();
      openTools.set(toolCallId, newV2PartId());
      return committed;
    },
    toolEnd(toolCallId, call) {
      if (closed) return [];
      const partId = openTools.get(toolCallId);
      if (!partId) return [];
      openTools.delete(toolCallId);
      const event = orchestratorEventToSink(sessionId, messageId, partId, { type: 'tool-end', ...call }, partIndex);
      partIndex++;
      return event ? [event] : [];
    },
    finish(usage) {
      return close(usage);
    },
    abort(usage) {
      return close(usage ?? { inputTokens: 0, outputTokens: 0 });
    },
  };
}
