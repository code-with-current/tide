/** Tide→OpenChamber adapter — NEW code (the port's seam), not upstream. Maps Tide `Message`/`Block` onto the vendored `OcMessage`/`OcPart` shapes consumed by the ported turn projection in `lib/turns/`.
 *
 * Mapping contract (task brief, verbatim):
 * - TextBlock      → { type: 'text', text } (narration + answer both)
 * - ReasoningBlock → { type: 'reasoning', text, metadata: { durationMs, tokens } }
 * - ToolBlock      → { type: 'tool', tool: toolName, toolCallId, state, input: arguments, output, error, metadata: { durationMs, riskTier, category, report, display, argPreview, parentToolCallId } }
 * - FollowupBlock  → { type: 'followup', toolCallId, mode }
 * - Message without blocks → single text part from content (legacy)
 *
 * Tide extras stashed for downstream renderers: text parts carry
 * `metadata.isAnswer` / `metadata.parentToolCallId`; tool metadata also carries
 * `partialInput` (the streaming shimmer preview).
 *
 * Tide tool `status` strings pass through unmapped as `state.status`:
 * 'pending' | 'running' | 'awaiting_input' | 'executed' | 'failed' |
 * 'rejected' | 'timeout' | 'aborted' | 'partial'. Note they do NOT match
 * OpenCode's ('completed' etc.) — consumers must check the Tide vocabulary.
 * Failure text lives in ToolBlock.output (no separate error field), so `error`
 * mirrors `output` for the failure statuses Tide itself treats as failed
 * (src/lib/stream/block-state.ts FAILED_STATUSES).
 */

import type { Block, Message, ToolBlock } from '@/types';

import type { OcMessage, OcPart } from '../types/opencode-parts';
import { projectTurnRecords } from './turns/project-turn-records';
import type { ChatMessageEntry, TurnProjectionResult } from './turns/types';

const FAILED_STATUSES = new Set(['failed', 'rejected', 'timeout', 'aborted']);

const toEpochMs = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

export function blockToPart(b: Block): OcPart {
  switch (b.kind) {
    case 'text':
      return {
        id: b.id,
        type: 'text',
        text: b.text,
        metadata: {
          isAnswer: b.isAnswer,
          ...(b.parentToolCallId ? { parentToolCallId: b.parentToolCallId } : {}),
        },
      };
    case 'reasoning':
      return {
        id: b.id,
        type: 'reasoning',
        text: b.text,
        metadata: {
          ...(b.ms !== undefined ? { durationMs: b.ms } : {}),
          ...(b.tokens !== undefined ? { tokens: b.tokens } : {}),
          ...(b.parentToolCallId ? { parentToolCallId: b.parentToolCallId } : {}),
        },
      };
    case 'tool': {
      const metadata = buildToolMetadata(b);
      const error = FAILED_STATUSES.has(b.status) ? b.output : undefined;
      return {
        id: b.id,
        type: 'tool',
        tool: b.toolName,
        toolCallId: b.toolCallId,
        state: {
          status: b.status,
          input: b.arguments,
          output: b.output,
          error,
          metadata,
        },
        input: b.arguments,
        output: b.output,
        error,
        metadata,
      };
    }
    case 'followup':
      return {
        id: b.id,
        type: 'followup',
        toolCallId: b.toolCallId,
        mode: b.mode,
      };
  }
}

function buildToolMetadata(b: ToolBlock): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    category: b.category,
    riskTier: b.riskTier,
    argPreview: b.argPreview,
  };
  if (b.durationMs !== undefined) metadata.durationMs = b.durationMs;
  if (b.report !== undefined) metadata.report = b.report;
  if (b.display !== undefined) metadata.display = b.display;
  if (b.partialInput !== undefined) metadata.partialInput = b.partialInput;
  if (b.parentToolCallId) metadata.parentToolCallId = b.parentToolCallId;
  return metadata;
}

/** True for parts mirrored from a dispatched sub-agent (src/types/block.ts
 *  invariant: children carry parentToolCallId). Top-level render paths —
 *  message-body's flat loop and the turn-activity projection — must skip
 *  these; they render nested inside their dispatch_agent ToolPart via
 *  AgentNestingContext, and rendering them again at top level leaks the
 *  sub-agent's activity outside the agent block. */
export function hasParentToolCall(part: OcPart): boolean {
  const parentId = part.metadata?.parentToolCallId;
  return typeof parentId === 'string' && parentId !== '';
}

export function toChatMessageEntry(msg: Message): ChatMessageEntry {
  const created = toEpochMs(msg.createdAt);
  const isAssistant = msg.role === 'assistant';
  const info: OcMessage = {
    id: msg.id,
    role: msg.role,
    time: {
      created,
      // Committed assistant messages always carry a completion stamp so
      // projectTurnRecords derives isStreaming=false; only the in-flight
      // streaming entry (see projectTideTurns) stays uncompleted.
      ...(isAssistant ? { completed: created + (msg.totalMs ?? 0) } : {}),
    },
    ...(isAssistant ? { finish: normalizeFinish(msg.stopReason) } : {}),
    ...(msg.mentions ? { mentions: msg.mentions } : {}),
    ...(msg.attachments ? { attachments: msg.attachments } : {}),
  };
  const parts: OcPart[] = msg.blocks && msg.blocks.length > 0
    ? msg.blocks.map(blockToPart)
    : [{ type: 'text', text: msg.content }];
  return { info, parts };
}

/**
 * Tide's StopReason vocabulary ('end_turn' | 'max_tokens' | 'content_filter' |
 * 'iteration_limit' | 'aborted' | 'refusal' — orchestrator.stopReasonFor)
 * never contains 'stop', but upstream's turn footer gates on
 * `finish === 'stop'` (message-body hasStopFinish) — without this mapping a
 * completed turn renders without its timestamp/changed-files footer.
 */
const normalizeFinish = (stopReason: string | null | undefined): string => {
  switch (stopReason) {
    case 'max_tokens':
    case 'iteration_limit':
      return 'length';
    case 'aborted':
      return 'aborted';
    case 'refusal':
    case 'content_filter':
      return 'error';
    default:
      return 'stop';
  }
};

export interface ProjectTideTurnsOptions {
  showTextJustificationActivity?: boolean;
  showTurnChangedFiles?: boolean;
  previousProjection?: TurnProjectionResult | null;
}

/**
 * Builds OpenChamber entries from Tide messages — the timeline's production
 * path (static and in-flight messages alike).
 *
 * `parentID` (which upstream gets from the OpenCode session shape) is assigned
 * sequentially: each user message starts a turn and every following non-user
 * message attaches to it until the next user message. The in-flight
 * `streamingMessage` appends to the last turn — if the last message is a user
 * message, it opens that new turn. Without parentID, projectTurnRecords drops
 * assistant messages — completed turns rendered empty.
 *
 * `TurnStreamState` derives from these props, not timestamps: the streaming
 * entry is stripped of its completion stamp while `isStreaming` is true, and
 * `stopReason` (e.g. 'aborted', 'refusal') overrides its finish reason once
 * the turn ends.
 */
export function buildChatMessageEntries(
  messages: Message[],
  streamingMessage?: Message | null,
  isStreaming: boolean = streamingMessage != null,
  stopReason: string | null = streamingMessage?.stopReason ?? null,
): ChatMessageEntry[] {
  const entries: ChatMessageEntry[] = [];
  let lastUserId: string | undefined;

  for (const msg of messages) {
    const entry = toChatMessageEntry(msg);
    if (msg.role === 'user') {
      lastUserId = msg.id;
    } else if (lastUserId) {
      entry.info.parentID = lastUserId;
    }
    entries.push(entry);
  }

  if (streamingMessage) {
    const entry = toChatMessageEntry(streamingMessage);
    if (lastUserId) {
      entry.info.parentID = lastUserId;
    }
    if (isStreaming) {
      entry.info.time.completed = undefined;
      entry.info.finish = undefined;
    }
    if (stopReason) {
      entry.info.finish = normalizeFinish(stopReason);
    }
    entries.push(entry);
  }

  return entries;
}

export function projectTideTurns(
  messages: Message[],
  streamingMessage: Message | null,
  isStreaming: boolean = streamingMessage != null,
  stopReason: string | null = streamingMessage?.stopReason ?? null,
  options?: ProjectTideTurnsOptions,
): TurnProjectionResult {
  const entries = buildChatMessageEntries(messages, streamingMessage, isStreaming, stopReason);
  return projectTurnRecords(entries, {
    showTextJustificationActivity: options?.showTextJustificationActivity ?? false,
    showTurnChangedFiles: options?.showTurnChangedFiles ?? false,
    previousProjection: options?.previousProjection ?? null,
  });
}
