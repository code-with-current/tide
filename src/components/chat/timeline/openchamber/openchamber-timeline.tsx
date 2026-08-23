/** OpenChamberTimeline — drop-in replacement for ChatTimeline ported from
 *  openchamber/openchamber (MIT): `MessageList.tsx` + `useChatAutoFollow.ts`,
 *  adapted to Tide's Message/ChatMessage model.
 *
 *  Task 8: rows are now the OpenChamber turn model. Tide `Message[]` is
 *  projected via `toChatMessageEntry` (lib/tide-adapter) into
 *  `ChatMessageEntry[]`, folded into turns by `useChatTimelineController`
 *  (T6), and rendered as `TimelineRow[]` (divider | turn | streaming tail)
 *  inside `VirtualizedMessageList`. Row content is `TurnItemMemoized` +
 *  `OpenChamberChatMessage` — the ported OpenChamber chat entry renderer.
 *
 *  Differences from the previous ChatTimeline implementation:
 *  - Bottom anchoring lives in @tanstack/virtual-core (`anchorTo: 'end'`),
 *    so there is no pin spacer, no sentinel, no eased chase — one instant
 *    scrollTop writer (the ResizeObserver) instead of three racing ones.
 *  - Session switches restore real row measurements from a per-session
 *    snapshot cache instead of re-estimating.
 *  - Send behavior follows the tail (OpenChamber model), not the previous
 *    pin-user-message-to-top choreography.
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Message } from '@/types';
import { useChatAutoFollow } from './use-chat-auto-follow';
import { VirtualizedMessageList, type TimelineRow } from './virtualized-message-list';
import { useChatTimelineController } from './hooks/use-chat-timeline-controller';
import { buildChatMessageEntries } from './lib/tide-adapter';
import { TurnItemMemoized } from './components/turn-item';
import { OpenChamberChatMessage } from './chat-message';
import { ChatEmptyStateMemoized } from './chat-empty-state';
import { TurnWorkingFooter } from '@/components/chat/turn/turn-header';
import { CompactedDivider } from '../../blocks/compacted-divider';
import type { Turn } from './lib/turns/types';
import type { StreamingTailEntry } from './lib/turns/streaming-tail-entry';
import { cn } from '@/lib/utils';
import './openchamber-chat.css';
// katex base stylesheet — `.oc-chat .katex` overrides in openchamber-chat.css
// assume it is loaded (declared dependency; upstream imports it globally).
import 'katex/dist/katex.min.css';

export interface OpenChamberTimelineProps {
  messages: Message[];
  streamingMessage: Message | null;
  isStreaming: boolean;
  pendingToolCallIds?: string[];
  /** Accepted for ChatTimeline prop parity but unconsumed by the turn model:
   *  OpenChamberChatMessage derives finish state from parts. Still threaded
   *  into the streaming entry conversion below (finish override once the turn
   *  ends), so it is NOT dead — task-8 seam note. */
  stopReason?: string | null;
  sessionId?: string | null;
  sessionLoading?: boolean;
  onApproveToolCalls?: (ids: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) => void;
  onRejectToolCalls?: (ids: string[], reason?: string) => void;
  /** Tide wiring (task 8): live-pause followup answers (QuestionCard →
   *  submitFollowup IPC). */
  onAnswerFollowup?: (toolCallId: string, answer: string, mode?: unknown) => void;
  /** Tide wiring (task 8): active workspace root for path-relative rendering. */
  directory?: string;
  loadingFallback?: React.ReactNode;
  emptyState?: React.ReactNode;
  errorBlock?: React.ReactNode;
  className?: string;
  retryActive?: boolean;
}

function OpenChamberTimelineImpl({
  messages,
  streamingMessage,
  isStreaming,
  pendingToolCallIds,
  stopReason,
  sessionId,
  sessionLoading,
  onApproveToolCalls,
  onRejectToolCalls,
  onAnswerFollowup,
  directory,
  loadingFallback,
  emptyState,
  errorBlock,
  className,
  retryActive,
}: OpenChamberTimelineProps) {
  const isEmpty = messages.length === 0 && !streamingMessage && !sessionLoading;
  const listActive = !isEmpty && !(sessionLoading && messages.length === 0);
  const { scrollRef, state, showScrollButton, goToBottom, scrollToBottomOnSend } =
    useChatAutoFollow({ sessionId, isStreaming });

  // A send appends a user message — jump to the tail whether we were
  // following or scrolled up (OpenChamber's scrollToBottomOnSend).
  const prevCountRef = useRef(messages.length);
  const lastRole = streamingMessage?.role ?? messages[messages.length - 1]?.role;
  useEffect(() => {
    const grew = messages.length > prevCountRef.current;
    prevCountRef.current = messages.length;
    if (grew && lastRole === 'user') scrollToBottomOnSend();
  }, [messages.length, lastRole, scrollToBottomOnSend]);

  // ── Tide → OpenChamber projection (task 8) ─────────────────────────────
  // All entries (static + in-flight) go through buildChatMessageEntries so
  // every assistant entry carries parentID — projectTurnRecords drops
  // parentless assistant messages, which erased finished turns' content.
  // Memoize on the `messages` reference — the array rebuilds on every store
  // commit, so identity IS the change signal.
  const controllerMessages = useMemo(
    () => buildChatMessageEntries(messages, streamingMessage, isStreaming, stopReason ?? streamingMessage?.stopReason ?? null),
    [messages, streamingMessage, isStreaming, stopReason],
  );

  // The in-flight entry is the last element while a streaming message exists;
  // identity is shared with controllerMessages for the controller's
  // activeStreamingMessageId matching.
  const streamingEntry = streamingMessage
    ? controllerMessages[controllerMessages.length - 1]
    : undefined;

  const {
    turnRecords,
    staticTurns,
    streamingTailEntry,
    // turnUiStates/toggleTurnGroup: controller-owned per-turn group state.
    turnUiStates,
    toggleTurnGroup,
    // `turnWindowModel` is intentionally unconsumed: upstream uses it for
    // pagination; Tide's list virtualizes on its own (task-8 seam note).
  } = useChatTimelineController({
    messages: controllerMessages,
    streamingMessage: streamingEntry,
    isStreaming,
    sessionKey: sessionId ?? undefined,
  });

  // Tide `Message.compactionInfo` is not projected onto entries — look it up
  // by message id. A turn whose first message (user message, else first
  // assistant message) carries it gets a divider row immediately before it.
  const compactionById = useMemo(() => {
    const map = new Map<string, { tokensBefore: number; tokensAfter: number }>();
    for (const message of messages) {
      if (message.compactionInfo) map.set(message.id, message.compactionInfo);
    }
    if (streamingMessage?.compactionInfo) {
      map.set(streamingMessage.id, streamingMessage.compactionInfo);
    }
    return map;
  }, [messages, streamingMessage]);

  const dividerRowForTurn = useCallback(
    (turn: Turn): TimelineRow | undefined => {
      const candidateIds = [turn.userMessage.info.id, turn.assistantMessages[0]?.info.id];
      for (const id of candidateIds) {
        if (!id) continue;
        const compaction = compactionById.get(id);
        if (compaction) {
          return { key: `divider:${turn.turnId}`, kind: 'divider', compaction };
        }
      }
      return undefined;
    },
    [compactionById],
  );

  // Row list: static turns + tail while streaming; while idle the tail is
  // null and the LAST turn is excluded from `staticTurns`, so render the full
  // projection (`turnRecords.turns`) instead — otherwise the last committed
  // turn would vanish.
  const rows = useMemo<TimelineRow[]>(() => {
    const result: TimelineRow[] = [];
    if (streamingTailEntry) {
      for (const turn of staticTurns) {
        const divider = dividerRowForTurn(turn);
        if (divider) result.push(divider);
        result.push({ key: `turn:${turn.turnId}`, kind: 'turn', turn, userMessage: true });
      }
      // Tail row key is session-scoped: the measurement cache outlives session
      // switches (same rationale as timelineRowKey's `__streaming__` key).
      const tailKey = `${sessionId ?? 's'}:tail:${streamingTailEntry.key}`;
      if (streamingTailEntry.kind === 'turn') {
        const divider = dividerRowForTurn(streamingTailEntry.turn);
        if (divider) result.push(divider);
        result.push({ key: tailKey, kind: 'tail', entry: streamingTailEntry, userMessage: true });
      } else {
        result.push({
          key: tailKey,
          kind: 'tail',
          entry: streamingTailEntry,
          userMessage: streamingTailEntry.message.info.role === 'user',
        });
      }
      return result;
    }
    for (const turn of turnRecords.turns) {
      const divider = dividerRowForTurn(turn);
      if (divider) result.push(divider);
      result.push({ key: `turn:${turn.turnId}`, kind: 'turn', turn, userMessage: true });
    }
    return result;
  }, [staticTurns, streamingTailEntry, turnRecords.turns, dividerRowForTurn, sessionId]);

  // ── Row content (task 8) ────────────────────────────────────────────────
  // Static turn rows: group state from the controller; NO streaming-only
  // props (isStreamingRow/pendingToolCallIds/onApprove/onReject/
  // onAnswerFollowup are tail-row-only per the task-8 brief).
  const renderStaticTurnContent = useCallback(
    (turn: Turn) => {
      const isGroupExpanded = turnUiStates.get(turn.turnId)?.isExpanded ?? false;
      const onToggleGroup = () => toggleTurnGroup(turn.turnId);
      return (
        <TurnItemMemoized
          turn={turn}
          renderMessage={(entry) => (
            <OpenChamberChatMessage
              entry={entry}
              turn={turn}
              isGroupExpanded={isGroupExpanded}
              onToggleGroup={onToggleGroup}
              directory={directory}
            />
          )}
        />
      );
    },
    [turnUiStates, toggleTurnGroup, directory],
  );

  // Streaming tail: same OpenChamberChatMessage-based renderMessage so live
  // parts stream in-place, plus the streaming-only props.
  const renderTailContent = useCallback(
    (tail: StreamingTailEntry) => {
      if (tail.kind === 'turn') {
        const isGroupExpanded = turnUiStates.get(tail.turn.turnId)?.isExpanded ?? false;
        return (
          <>
            <TurnItemMemoized
              turn={tail.turn}
              renderMessage={(entry) => (
                <OpenChamberChatMessage
                  entry={entry}
                  turn={tail.turn}
                  isStreamingRow
                  pendingToolCallIds={pendingToolCallIds}
                  onApprove={onApproveToolCalls}
                  onReject={onRejectToolCalls}
                  onAnswerFollowup={onAnswerFollowup}
                  isGroupExpanded={isGroupExpanded}
                  onToggleGroup={() => toggleTurnGroup(tail.turn.turnId)}
                  directory={directory}
                />
              )}
            />
            {/* Tide-native working indicator (user request): upstream mounts
                StatusRow in ChatInput/ChatContainer — neither ported — so
                without this a mid-dispatch turn looks finished. */}
            {isStreaming && <TurnWorkingFooter startedAt={streamingMessage?.createdAt} />}
          </>
        );
      }
      return (
        <>
          <OpenChamberChatMessage
            entry={tail.message}
            isStreamingRow
            pendingToolCallIds={pendingToolCallIds}
            onApprove={onApproveToolCalls}
            onReject={onRejectToolCalls}
            onAnswerFollowup={onAnswerFollowup}
            directory={directory}
          />
          {isStreaming && <TurnWorkingFooter startedAt={streamingMessage?.createdAt} />}
        </>
      );
    },
    [turnUiStates, toggleTurnGroup, pendingToolCallIds, onApproveToolCalls, onRejectToolCalls, onAnswerFollowup, directory, isStreaming, streamingMessage?.createdAt],
  );

  const renderRowContent = useCallback(
    (row: TimelineRow) => {
      switch (row.kind) {
        case 'divider':
          return (
            <CompactedDivider
              tokensBefore={row.compaction.tokensBefore}
              tokensAfter={row.compaction.tokensAfter}
            />
          );
        case 'turn':
          return renderStaticTurnContent(row.turn);
        case 'tail':
          return renderTailContent(row.entry);
      }
    },
    [renderStaticTurnContent, renderTailContent],
  );

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        className={cn(
          // overflow-anchor:none — the auto-follow hook owns every scrollTop
          // write on this container; Chromium's native scroll anchoring would
          // fight it with compensating writes on virtualizer repositions.
          'h-full overflow-y-auto overflow-x-hidden scroll [overflow-anchor:none] px-6 py-3',
          // Suppress the scrollbar thumb while it jumps on every instant
          // re-pin during live follow; normal scrollbar otherwise.
          isStreaming && state === 'following' && 'chat-streaming',
          className,
        )}
      >
        {/* `oc-chat` scopes the ported OpenChamber token layer (see
            openchamber-chat.css) over every row in the timeline. */}
        <div className="oc-chat w-[80%] max-w-3xl mx-auto">
          {sessionLoading && messages.length === 0 ? loadingFallback
            : isEmpty ? (emptyState ?? <ChatEmptyStateMemoized />)
            : (
              <>
                {listActive && (
                  <VirtualizedMessageList
                    sessionKey={sessionId}
                    rows={rows}
                    scrollRef={scrollRef}
                    renderRowContent={renderRowContent}
                  />
                )}
                {errorBlock}
                {/* Permanent breathing room below the last block — its height
                    doubles as the auto-follow bottom-zone threshold. */}
                <div style={{ height: '10vh' }} aria-hidden="true" />
              </>
            )}
        </div>
      </div>

      {showScrollButton && (
        <button
          type="button"
          onClick={() => goToBottom('instant')}
          className={cn(
            'absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary border border-border shadow-lg text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-150',
            retryActive ? 'bottom-[48px]' : 'bottom-4',
          )}
        >
          <ChevronDown className="size-3.5" />
          New Message
          {isStreaming && <span className="size-1.5 rounded-full bg-primary animate-pulse" />}
        </button>
      )}
    </div>
  );
}

export const OpenChamberTimeline = memo(OpenChamberTimelineImpl);
