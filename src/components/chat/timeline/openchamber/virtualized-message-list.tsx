/** Virtualized history list for the OpenChamber-port chat timeline.
 *
 *  Ported from openchamber/openchamber `packages/ui/src/components/chat/MessageList.tsx`
 *  (MIT), reduced to Tide's flat Message[] model.
 *
 *  What makes this scroll smoothly where the previous implementation didn't:
 *
 *  - `anchorTo: 'end'` — bottom anchoring lives in @tanstack/virtual-core.
 *    Prepending/remeasuring rows above the viewport does not move what the
 *    user is reading; the core owns anchor corrections, so no manual
 *    compensate-and-chase logic (and no second scrollTop writer).
 *  - `initialOffset: Number.MAX_SAFE_INTEGER` — a freshly mounted list
 *    initializes at the bottom instead of the top, so session switches don't
 *    flash the top of history before the first pin.
 *  - Padding-based window offset (not per-row absolute positioning) keeps
 *    every row in normal flow — sticky elements and margin boxes behave like
 *    plain DOM.
 *  - Measurement snapshots per session (`takeSnapshot` + 
 *    `initialMeasurementsCache`) restore real row heights instantly on
 *    session switch instead of re-estimating, killing estimate-flash jumps.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  elementScroll,
  useVirtualizer,
  type VirtualItem,
  type Virtualizer,
} from '@tanstack/react-virtual';
import type { Message } from '@/types';
import { ChatMessage } from '../../chat-message';
import { CompactedDivider } from '../../blocks/compacted-divider';
import { timelineRowKey } from '../row-metrics';

type HtmlVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

const ESTIMATED_ROW_SIZE = 320;
const OVERSCAN = 8;
// Adaptive estimate bounds: only trust the measured average once a few rows
// have been measured, and keep it inside sane turn-height bounds. Smaller
// estimate error → smaller anchor corrections when unmeasured rows measure in.
const ESTIMATE_MIN_SAMPLES = 5;
const ESTIMATE_MIN = 120;
const ESTIMATE_MAX = 1200;
// "At end" tolerance for resize-adjustment decisions.
const AT_END_THRESHOLD_PX = 80;
const SNAPSHOT_CACHE_LIMIT = 16;

const snapshotCache = new Map<string, { keys: readonly string[]; items: VirtualItem[] }>();

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((key, i) => key === b[i]);

function readSnapshot(sessionKey: string, keys: readonly string[]): VirtualItem[] | undefined {
  const entry = snapshotCache.get(sessionKey);
  if (!entry) return undefined;
  if (sameKeys(entry.keys, keys)) return entry.items;
  snapshotCache.delete(sessionKey);
  return undefined;
}

function writeSnapshot(
  sessionKey: string,
  keys: readonly string[],
  virtualizer: HtmlVirtualizer | null | undefined,
) {
  if (!virtualizer || keys.length === 0) return;
  snapshotCache.delete(sessionKey);
  snapshotCache.set(sessionKey, { keys: keys.slice(), items: virtualizer.takeSnapshot() });
  while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = snapshotCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    snapshotCache.delete(oldest);
  }
}

export interface VirtualizedMessageListProps {
  sessionKey?: string | null;
  messages: Message[];
  streamingMessage: Message | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  pendingToolCallIds?: string[];
  stopReason?: string | null;
  onApproveToolCalls?: (ids: string[], newMode?: 'plan' | 'ask' | 'edit' | 'full', remember?: boolean) => void;
  onRejectToolCalls?: (ids: string[], reason?: string) => void;
}

export function VirtualizedMessageList({
  sessionKey,
  messages,
  streamingMessage,
  scrollRef,
  pendingToolCallIds,
  stopReason,
  onApproveToolCalls,
  onRejectToolCalls,
}: VirtualizedMessageListProps) {
  const totalCount = messages.length + (streamingMessage ? 1 : 0);
  const keysRef = useRef<readonly string[]>([]);
  keysRef.current = Array.from({ length: totalCount }, (_, i) => timelineRowKey(messages, i, sessionKey));

  // Initial-only read: snapshot restore is a mount-time concern; afterwards
  // the live virtualizer owns measurements.
  const [initialMeasurements] = useState(() =>
    sessionKey ? readSnapshot(sessionKey, keysRef.current) : undefined,
  );

  const sizeContainerRef = useRef<HTMLDivElement | null>(null);
  // Adaptive estimate via ref keeps estimateSize's identity stable so updating
  // the average never triggers a global remeasure.
  const estimatedRowSizeRef = useRef(ESTIMATED_ROW_SIZE);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    overscan: OVERSCAN,
    estimateSize: () => estimatedRowSizeRef.current,
    getItemKey: (index) => keysRef.current[index] ?? `index:${index}`,
    scrollToFn: (offset, options, instance) => {
      // Expose the new total height before core writes an anchor correction
      // so the browser does not clamp the offset to the old height.
      const sizeElement = sizeContainerRef.current;
      if (sizeElement) sizeElement.style.height = `${instance.getTotalSize()}px`;
      elementScroll(offset, options, instance);
    },
    // Bottom-anchored chat semantics.
    anchorTo: 'end',
    initialOffset: () => Number.MAX_SAFE_INTEGER,
    initialMeasurementsCache: initialMeasurements,
  });
  // Only compensate scroll for rows growing ABOVE the viewport (history
  // remeasures). A row growing inside the viewport — expanding a tool call or
  // thinking block — must grow DOWNWARD naturally; at the bottom the
  // auto-follow hook owns pinning, so skip there too instead of double-writing.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (instance.isAtEnd(AT_END_THRESHOLD_PX)) return false;
    const firstVisibleIndex = instance.range?.startIndex;
    return firstVisibleIndex !== undefined && item.index < firstVisibleIndex;
  };

  useEffect(() => {
    const sizes = virtualizer.itemSizeCache;
    if (sizes.size >= ESTIMATE_MIN_SAMPLES) {
      let total = 0;
      for (const size of sizes.values()) total += size;
      estimatedRowSizeRef.current = Math.min(
        ESTIMATE_MAX,
        Math.max(ESTIMATE_MIN, Math.round(total / sizes.size)),
      );
    }
  });

  useEffect(() => {
    return () => {
      writeSnapshot(sessionKey ?? '', keysRef.current, virtualizer);
    };
  }, [sessionKey, virtualizer]);

  const renderRow = useCallback(
    (row: VirtualItem) => {
      const isStreamingRow = row.index >= messages.length;
      const msg = isStreamingRow ? streamingMessage! : messages[row.index];
      return (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          data-user-message={msg.role === 'user' ? 'true' : undefined}
          // flow-root makes the row a BFC so TurnBlock's mb-6 is contained in
          // the row box and thus captured by measureElement. In plain normal
          // flow the margin collapses through this div: measured sizes (and
          // totalSize) under-count every turn row, the natural-flow stack
          // grows past the fixed-height size container, and the tail rows
          // paint over the error block and bottom spacer below it.
          className="min-w-0 w-full flow-root"
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
            sessionId={sessionKey}
            onApproveToolCalls={isStreamingRow ? onApproveToolCalls : undefined}
            onRejectToolCalls={isStreamingRow ? onRejectToolCalls : undefined}
          />
        </div>
      );
    },
    [messages, streamingMessage, sessionKey, pendingToolCallIds, stopReason, onApproveToolCalls, onRejectToolCalls, virtualizer],
  );

  const virtualItems = virtualizer.getVirtualItems();
  const startOffset = virtualItems[0]?.start ?? 0;

  return (
    <div ref={sizeContainerRef} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      <div style={{ paddingTop: `${startOffset}px` }}>
        {virtualItems.map(renderRow)}
      </div>
    </div>
  );
}
