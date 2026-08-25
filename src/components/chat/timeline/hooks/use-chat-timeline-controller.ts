/**
 * Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/hooks/useChatTimelineController.ts — REDUCED (ruling R2).
 * The two exported pure functions are verbatim upstream. The hook is trimmed to
 * what Tide's timeline needs: upstream's ~985 lines manage OpenCode-server
 * pagination (load-earlier, prepend commits, underfilled-viewport auto-load,
 * pendingRevealWork, scroll/anchor plumbing) that Tide's
 * `virtualized-message-list` (own windowing + auto-follow) does not consume.
 *
 * upstream port seams:
 *  - Dropped from the hook: session subscription, `loadEarlier` callbacks,
 *    reveal-work plumbing, `MessageListHandle` ref, scroll/anchor state.
 *  - Input is props (`{ messages, streamingMessage, isStreaming }`), not stores.
 *  - `turnUiStates`/`toggleTurnGroup` are NEW Tide code (not ported): upstream
 *    keeps per-turn expand/collapse state in MessageList keyed by
 *    `activityRenderMode === 'summary'`; Tide has no such setting and defaults
 *    activity groups to COLLAPSED (task-6 handoff correction 4).
 *  - Projection options default to constants (no UI store): justification
 *    activity and turn changed files off, plan mode off — Task 8 may pass
 *    through real values.
 */

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
