import React from 'react';

import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import type { TurnProjectionResult } from '../lib/turns/types';
import {
  buildTurnWindowModel,
  type TurnWindowModel,
} from '../lib/turns/window-turns';
import { buildLiveStreamingEntry, type StreamingTailEntry } from '../lib/turns/streaming-tail-entry';
import { useTurnRecords } from './use-turn-records';

export const shouldAutoLoadEarlierForUnderfilledPinnedViewport = (input: {
  sessionId: string | null;
  isPinned: boolean;
  canLoadEarlier: boolean;
  isLoadingOlder: boolean;
  pendingRevealWork: boolean;
  scrollHeight: number;
  clientHeight: number;
}): boolean => {
  if (!input.sessionId) return false;
  if (!input.isPinned || !input.canLoadEarlier) return false;
  if (input.isLoadingOlder || input.pendingRevealWork) return false;
  return input.scrollHeight <= input.clientHeight + 1;
};

export const isOlderHistoryPrependCommit = (input: {
  previousOldestId: string | null;
  previousNewestId: string | null;
  currentOldestId: string | null;
  currentNewestId: string | null;
}): boolean => Boolean(
  input.previousOldestId
  && input.currentOldestId
  && input.currentOldestId !== input.previousOldestId
  && input.previousNewestId
  && input.currentNewestId
  && input.currentNewestId === input.previousNewestId,
);

export interface TurnUiState {
  isExpanded: boolean;
}

interface UseChatTimelineControllerOptions {
  messages: ChatMessageEntry[];
  streamingMessage?: ChatMessageEntry;
  isStreaming: boolean;
  /** Optional projection passthrough (see header: constants, not store reads). */
  sessionKey?: string;
  showTextJustificationActivity?: boolean;
  showTurnChangedFiles?: boolean;
  planModeEnabled?: boolean;
}

export interface UseChatTimelineControllerResult {
  turnRecords: TurnProjectionResult;
  staticTurns: TurnRecord[];
  streamingTurn: TurnRecord | undefined;
  streamingTailEntry: StreamingTailEntry | null;
  turnWindowModel: TurnWindowModel;
  turnUiStates: ReadonlyMap<string, TurnUiState>;
  toggleTurnGroup: (turnId: string) => void;
}

export const useChatTimelineController = ({
  messages,
  streamingMessage,
  isStreaming,
  sessionKey,
  showTextJustificationActivity = false,
  showTurnChangedFiles = false,
  planModeEnabled = false,
}: UseChatTimelineControllerOptions): UseChatTimelineControllerResult => {
  const { projection, staticTurns, streamingTurn } = useTurnRecords(messages, {
    sessionKey,
    showTextJustificationActivity,
    showTurnChangedFiles,
    planModeEnabled,
  });

  const [turnUiStates, setTurnUiStates] = React.useState<Map<string, TurnUiState>>(() => new Map());

  React.useEffect(() => {
    setTurnUiStates(new Map());
  }, [sessionKey]);

  // New Tide state (header note above): default collapsed, per-turn toggle.
  const toggleTurnGroup = React.useCallback((turnId: string) => {
    setTurnUiStates((previous) => {
      const next = new Map(previous);
      const current = next.get(turnId) ?? { isExpanded: false };
      next.set(turnId, { isExpanded: !current.isExpanded });
      return next;
    });
  }, []);

  const turnWindowModel = React.useMemo(() => buildTurnWindowModel(messages), [messages]);

  const streamingTailEntry = React.useMemo<StreamingTailEntry | null>(() => {
    if (!isStreaming) {
      return null;
    }
    if (streamingTurn) {
      return buildLiveStreamingEntry(
        { kind: 'turn', key: `turn-${streamingTurn.turnId}`, turn: streamingTurn, isLastTurn: true },
        {
          activeStreamingMessageId: streamingMessage?.info.id ?? null,
          liveParts: streamingMessage?.parts ?? [],
          showTextJustificationActivity,
          showTurnChangedFiles,
          mergeHiddenUserTurns: { planModeEnabled },
        },
      );
    }
    if (streamingMessage) {
      return buildLiveStreamingEntry(
        { kind: 'ungrouped', key: `message-${streamingMessage.info.id}`, message: streamingMessage },
        {
          activeStreamingMessageId: streamingMessage.info.id,
          liveParts: streamingMessage.parts,
          showTextJustificationActivity,
          showTurnChangedFiles,
          mergeHiddenUserTurns: { planModeEnabled },
        },
      );
    }
    return null;
  }, [isStreaming, planModeEnabled, showTextJustificationActivity, showTurnChangedFiles, streamingMessage, streamingTurn]);

  return {
    turnRecords: projection,
    staticTurns,
    streamingTurn,
    streamingTailEntry,
    turnWindowModel,
    turnUiStates,
    toggleTurnGroup,
  };
};
