/** Pure translation from the orchestrator's stream vocabulary (AI SDK part
 *  names + the commit/boundary events the wiring derives) to typed sink
 *  events. Keeps emission logic testable without a DB or WebContents. */

import type { ToolCallStatus, Usage } from '../../../src/types/index.js';
import type { SinkEvent } from './event-sink.js';

/** Usage as the orchestrator reports it at turn end. Field names match
 *  SinkUsage exactly (reasoning/cache classes optional) so the wiring passes
 *  turn.usage through without adaptation. */
export type OrchestratorUsage = { inputTokens: number; outputTokens: number } & Partial<Omit<Usage, 'inputTokens' | 'outputTokens'>>;

/** Events the orchestrator wiring derives from its streaming path:
 *  - 'text-delta' — AI SDK stream part, verbatim
 *  - 'text-end' — a text part closes (tool starts, a new block opens, or the turn ends)
 *  - 'tool-end' — tool-result/tool-error landed; fields mirror the ToolCall
 *    the orchestrator assembles (arguments as `input`, per the SDK part)
 *  - 'finish' — turn-level usage (the SDK 'finish' part's totalUsage, folded
 *    into turn.usage); emitted once per turn, not per streamText call
 *  - 'turn-end' — turn boundary (emitTurnEnd) */
export type OrchestratorStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'text-end'; text: string }
  | {
      type: 'tool-end';
      toolName: string;
      input: Record<string, unknown>;
      output?: string;
      status: ToolCallStatus;
      durationMs?: number;
    }
  | { type: 'finish'; usage: OrchestratorUsage }
  | { type: 'turn-end' };

export function orchestratorEventToSink(
  sessionId: string,
  messageId: string,
  partId: string | undefined,
  event: OrchestratorStreamEvent,
  partIndex = 0,
): SinkEvent | undefined {
  switch (event.type) {
    case 'text-delta':
      return { type: 'part.delta', sessionId, messageId, partId, data: { text: event.text } };
    case 'text-end':
      return { type: 'part.commit', sessionId, messageId, partId, data: { kind: 'text', data: { text: event.text }, seq: partIndex } };
    case 'tool-end':
      return {
        type: 'part.commit',
        sessionId,
        messageId,
        partId,
        data: {
          kind: 'tool',
          data: { toolName: event.toolName, input: event.input, output: event.output, status: event.status, durationMs: event.durationMs },
          seq: partIndex,
        },
      };
    case 'finish':
      return { type: 'message.end', sessionId, messageId, data: { usage: event.usage } };
    case 'turn-end':
      return { type: 'turn.end', sessionId, messageId };
    default:
      return undefined;
  }
}

/** Chronologically sortable ids (time-first base36) — the message-window
 *  cursor orders by id, so ids must sort by creation time. */
export function newV2MessageId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newV2PartId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
