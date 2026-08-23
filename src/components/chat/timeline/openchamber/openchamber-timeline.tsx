/** OpenChamberTimeline — drop-in replacement for ChatTimeline ported from
 *  openchamber/openchamber (MIT): `MessageList.tsx` + `useChatAutoFollow.ts`,
 *  adapted to Tide's Message/ChatMessage model.
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

import { memo, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Message } from '@/types';
import { useChatAutoFollow } from './use-chat-auto-follow';
import { VirtualizedMessageList } from './virtualized-message-list';
import { cn } from '@/lib/utils';
import './openchamber-chat.css';

export interface OpenChamberTimelineProps {
  messages: Message[];
  streamingMessage: Message | null;
  isStreaming: boolean;
  pendingToolCallIds?: string[];
  stopReason?: string | null;
  sessionId?: string | null;
  sessionLoading?: boolean;
  onApproveToolCalls?: (ids: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) => void;
  onRejectToolCalls?: (ids: string[], reason?: string) => void;
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
        <div className="w-[80%] max-w-3xl mx-auto">
          {sessionLoading && messages.length === 0 ? loadingFallback
            : isEmpty ? emptyState
            : (
              <>
                {listActive && (
                  <VirtualizedMessageList
                    sessionKey={sessionId}
                    messages={messages}
                    streamingMessage={streamingMessage}
                    scrollRef={scrollRef}
                    pendingToolCallIds={pendingToolCallIds}
                    stopReason={stopReason}
                    onApproveToolCalls={onApproveToolCalls}
                    onRejectToolCalls={onRejectToolCalls}
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
