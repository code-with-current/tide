/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/turns/streamingTailEntry.ts. Tide adaptation: upstream's `getNormalizedMessageForDisplay` (lib/messageDisplayNormalization.ts) is stubbed as an identity function — it depends on synthetic-part display filtering that is not ported yet; the stub boundary is noted in the port report. */

import type { OcPart } from '../../types/opencode-parts';

import { projectTurnRecords } from './project-turn-records';
import type { ChatMessageEntry, TurnRecord } from './types';

const getNormalizedMessageForDisplay = (message: ChatMessageEntry): ChatMessageEntry => message;

export type StreamingTailEntry =
  | {
    kind: 'ungrouped';
    key: string;
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
  }
  | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type BuildLiveStreamingEntryOptions = {
  activeStreamingMessageId: string | null | undefined;
  liveParts: OcPart[];
  showTextJustificationActivity: boolean;
  showTurnChangedFiles: boolean;
  mergeHiddenUserTurns?: { planModeEnabled: boolean };
};

const withLiveParts = (
  message: ChatMessageEntry,
  activeStreamingMessageId: string,
  liveParts: OcPart[],
): ChatMessageEntry => {
  if (message.info.id !== activeStreamingMessageId || message.parts === liveParts) {
    return message;
  }

  return getNormalizedMessageForDisplay({
    ...message,
    parts: liveParts,
  });
};

export const buildLiveStreamingEntry = <TEntry extends StreamingTailEntry>(
  entry: TEntry,
  options: BuildLiveStreamingEntryOptions,
): TEntry => {
  const activeStreamingMessageId = options.activeStreamingMessageId;
  if (!activeStreamingMessageId) {
    return entry;
  }

  if (entry.kind === 'ungrouped') {
    const message = withLiveParts(entry.message, activeStreamingMessageId, options.liveParts);
    if (message === entry.message) {
      return entry;
    }
    return {
      ...entry,
      message,
    };
  }

  let changed = false;
  const assistantMessages = entry.turn.assistantMessages.map((message) => {
    const next = withLiveParts(message, activeStreamingMessageId, options.liveParts);
    if (next !== message) {
      changed = true;
    }
    return next;
  });

  if (!changed) {
    return entry;
  }

  // Re-project from the turn's full ordered message records (not just
  // userMessage + assistants) so hidden user messages merged into this turn
  // keep parenting their assistant replies.
  const liveMessageById = new Map(assistantMessages.map((message) => [message.info.id, message]));
  const sourceMessages = entry.turn.messages.length > 0
    ? entry.turn.messages
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((record) => liveMessageById.get(record.messageId) ?? record.message)
    : [entry.turn.userMessage, ...assistantMessages];

  const projection = projectTurnRecords(sourceMessages, {
    showTextJustificationActivity: options.showTextJustificationActivity,
    showTurnChangedFiles: options.showTurnChangedFiles,
    mergeHiddenUserTurns: options.mergeHiddenUserTurns,
  });
  const turn = projection.turns[0] ?? {
    ...entry.turn,
    assistantMessages,
    assistantMessageIds: assistantMessages.map((message) => message.info.id),
  };

  return {
    ...entry,
    turn,
  };
};
