/** ChatTimeline — chat message list with self-contained scroll. Renders persisted
 *  + streaming messages in a single flat list. Owns its scroll container.
 *
 *  The message list is virtualized (@tanstack/react-virtual): offscreen rows
 *  unmount entirely, so their markdown / diff / mermaid subtrees only exist
 *  for rows near the viewport. The virtual box keeps its full height via
 *  getTotalSize() (measurements are cached per row key and survive row
 *  unmount), and the pin-scroll sentinels — [data-timeline-end] and the
 *  100vh spacer from usePinnedTimelineScroll — stay OUTSIDE the box as
 *  always-mounted siblings, so their geometry is stable while rows come and
 *  go. Row heights come from measureElement (ResizeObserver); estimateSize is
 *  only the pre-measure hint (see row-metrics.ts). */

import { memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';
import type { Message } from '@/types';
import { ChatMessage } from '../chat-message';
import { CompactedDivider } from '../blocks/compacted-divider';
import { usePinnedTimelineScroll } from './usePinnedTimelineScroll';
import { estimateRowSize, timelineRowKey } from './row-metrics';
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
  onApproveToolCalls?: (ids: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean | 'session') => void;
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

/** Pre-measure height hints live in row-metrics.ts (user rows are flat;
 *  turn rows are content-derived). measureElement corrects both on first
 *  mount and caches by row key, so estimates only shape initial geometry
 *  and far-jump scroll math. The old containIntrinsicSize hint was 220px. */

function ChatTimelineImpl({
  messages, streamingMessage, isStreaming, pendingToolCallIds, stopReason,
  sessionLoading, onApproveToolCalls, onRejectToolCalls, sessionId,
  loadingFallback, emptyState, errorBlock, className, retryActive,
}: ChatTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isEmpty = messages.length === 0 && !streamingMessage && !sessionLoading;
  const listActive = !isEmpty && !(sessionLoading && messages.length === 0);
  const totalCount = messages.length + (streamingMessage ? 1 : 0);
  const lastRole = (streamingMessage ?? messages[messages.length - 1])?.role;
  // Turn frozen at a permission gate → freeze the follow too (see hook).
  const permissionPaused = (pendingToolCallIds?.length ?? 0) > 0;
  const { unread, pinned, scrollToBottom } = usePinnedTimelineScroll(scrollRef, isStreaming, totalCount, lastRole, sessionId, permissionPaused);

  const virtualizer = useVirtualizer({
    count: listActive ? totalCount : 0,
    getScrollElement: () => scrollRef.current,
    overscan: 8,
    estimateSize: (i) => estimateRowSize(i < messages.length ? messages[i] : streamingMessage ?? undefined),
    // Stable keys keep the per-key measurement cache valid across unmount —
    // re-measure loops and estimate-flashing scrolls both hinge on this.
    // The streaming row's key is session-scoped (see row-metrics.ts).
    getItemKey: (i) => timelineRowKey(messages, i, sessionId),
  });

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        className={cn(
          'h-full overflow-y-auto overflow-x-hidden scroll px-6 py-3',
          // The pin-scroll spacer mounts a 100vh scroll range for the whole
          // turn — a scrollbar over that phantom range is noise, so it's
          // hidden until the spacer collapses and only real overflow stays.
          (pinned || isStreaming) && 'chat-streaming',
          className,
        )}
      >
        <div className="w-[80%] max-w-3xl mx-auto">
          {sessionLoading && messages.length === 0 ? loadingFallback
            : isEmpty ? emptyState
            : (
              <>
                <div style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
                  {virtualizer.getVirtualItems().map((row) => {
                    const isStreamingRow = row.index >= messages.length;
                    const msg = isStreamingRow ? streamingMessage! : messages[row.index];
                    return (
                      <div
                        key={row.key}
                        data-index={row.index}
                        ref={virtualizer.measureElement}
                        data-user-message={msg.role === 'user' ? 'true' : undefined}
                        className="min-w-0 w-full"
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          // An abs-pos row with auto height contains its last
                          // in-flow child's MARGIN box — that is what makes
                          // measureElement capture TurnBlock's mb-6. Keep
                          // that margin on the last in-flow child of the row;
                          // moving it to a wrapper AFTER the measured element
                          // would silently drop it from the measured height.
                          transform: `translateY(${row.start}px)`,
                        }}
                      >
                        {msg.compactionInfo && (
                          <CompactedDivider
                            tokensBefore={msg.compactionInfo.tokensBefore}
                            tokensAfter={msg.compactionInfo.tokensAfter}
                          />
                        )}
                        <ChatMessage
                          message={msg}
                          streaming={isStreamingRow}
                          pendingToolCallIds={isStreamingRow ? pendingToolCallIds : undefined}
                          stopReason={isStreamingRow ? stopReason : msg.stopReason}
                          sessionId={sessionId}
                          onApproveToolCalls={isStreamingRow ? onApproveToolCalls : undefined}
                          onRejectToolCalls={isStreamingRow ? onRejectToolCalls : undefined}
                        />
                      </div>
                    );
                  })}
                </div>
                {errorBlock}
                {/* Marks the real content end for usePinnedTimelineScroll —
                    must stay below every message and above the spacer. Lives
                    outside the virtual box so it never unmounts. */}
                <div data-timeline-end="true" style={{ height: 1 }} aria-hidden="true" />
                {/* Scroll room that lets the pinned user message reach the
                    viewport top; mounted for the whole turn so a mid-stream
                    unpin doesn't collapse it under the user. */}
                  {(pinned || isStreaming) && <div style={{ height: '100vh' }} aria-hidden="true" />}
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
