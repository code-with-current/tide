/** ChatTimeline — chat message list with self-contained scroll. Renders persisted
 *  + streaming messages in a single flat list. Owns its scroll container. */

import { memo, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Message } from '@/types';
import { ChatMessage } from '../chat-message';
import { CompactedDivider } from '../blocks/compacted-divider';
import { useTimelineScroll } from './useTimelineScroll';
import { cn } from '@/lib/utils';

export interface ChatTimelineProps {
  messages: Message[];
  streamingMessage: Message | null;
  isStreaming: boolean;
  pendingToolCallIds?: string[];
  stopReason?: string | null;
  /** Session that owns `messages` — on switch the history lags behind
   *  activeSessionId, so followup popups must key to the owning session, not
   *  the currently-viewed one. Undefined falls back to activeSessionId. */
  sessionId?: string | null;
  sessionLoading?: boolean;
  onApproveToolCalls?: (ids: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) => void;
  onRejectToolCalls?: (ids: string[], reason?: string) => void;
  loadingFallback?: React.ReactNode;
  emptyState?: React.ReactNode;
  errorBlock?: React.ReactNode;
  className?: string;
  /** True while the orchestrator auto-retries a failed request — the retry
   *  indicator floats centered just above the composer, same band as the
   *  "New Message" button. When active we lift this button so they stack
   *  instead of overlapping. */
  retryActive?: boolean;
}

function ChatTimelineImpl({
  messages, streamingMessage, isStreaming, pendingToolCallIds, stopReason,
  sessionLoading, onApproveToolCalls, onRejectToolCalls, sessionId,
  loadingFallback, emptyState, errorBlock, className, retryActive,
}: ChatTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const totalCount = messages.length + (streamingMessage ? 1 : 0);
  const { unread, scrollToBottom } = useTimelineScroll(scrollRef, isStreaming, totalCount);
  const isEmpty = messages.length === 0 && !streamingMessage && !sessionLoading;

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={scrollRef} className={cn('h-full overflow-y-auto overflow-x-hidden scroll px-6 py-3', className)}>
        <div className="w-[80%] max-w-3xl mx-auto flex flex-col">
          {sessionLoading && messages.length === 0 ? loadingFallback
            : isEmpty ? emptyState
            : (
              <>
                {messages.map((msg, i) => (
                  <div
                    key={msg.id}
                    className="min-w-0 w-full"
                    style={{
                      // Skip layout/paint for off-screen messages — the browser
                      // restores real geometry on scroll-in via containIntrinsicSize.
                      // Never apply to the last message (it may still be live or
                      // need accurate measurement for auto-scroll).
                      contentVisibility: i === messages.length - 1 ? 'visible' : 'auto',
                      containIntrinsicSize: 'auto 220px',
                    }}
                  >
                    {msg.compactionInfo && (
                      <CompactedDivider
                        tokensBefore={msg.compactionInfo.tokensBefore}
                        tokensAfter={msg.compactionInfo.tokensAfter}
                      />
                    )}
                    <ChatMessage message={msg} stopReason={msg.stopReason} sessionId={sessionId} />
                  </div>
                ))}
                {streamingMessage && (
                  <ChatMessage
                    key="__streaming__"
                    message={streamingMessage}
                    streaming
                    pendingToolCallIds={pendingToolCallIds}
                    stopReason={stopReason}
                    onApproveToolCalls={onApproveToolCalls}
                    onRejectToolCalls={onRejectToolCalls}
                  />
                )}
                {errorBlock}
                <div style={{ height: 1 }} aria-hidden="true" />
              </>
            )}
        </div>
      </div>

      {unread && (
        <button
          type="button"
          onClick={scrollToBottom}
          className={cn(
            'absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary border border-border shadow-lg text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-150',
            // Lift above the centered retry indicator so the two stack
            // instead of occupying the same band just above the composer.
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

export const ChatTimeline = memo(ChatTimelineImpl);
