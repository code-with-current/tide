/** Windowed v2 session timeline. Infinite-query pages hold the persisted
 *  history (newest window first, ascending within a page); live committed
 *  parts are merged in as a derived view so the timeline grows during a turn
 *  without touching the React Query cache — a cache write here would race the
 *  in-flight page fetch (commits landing mid-fetch would be skipped on
 *  `old === undefined` and lost), while this merge re-runs whenever either
 *  input changes and always reads the store fresh. Deltas never re-render:
 *  the store subscription snapshots `turnParts().length`, which only moves
 *  on part.commit. In-flight text is Task 10's job (read `textOf` per part).
 *
 *  PartV2 carries no messageId, so the part→message association is recorded
 *  from the event stream (every event has both ids) into a per-subscription
 *  map — the store stays Task 8's shape, untouched.
 *
 *  Single consumer per session: cleanup clears the session's stream state and
 *  evicts the messages query, so a second mounted consumer for the same
 *  session would tear down the first's cache and live parts on unmount. */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { eventsSubscribe, listSessionMessagesV2, subscribeEvents } from '@/lib/api/client';
import { evictSessionMessagesV2, qk } from '@/lib/queries';
import { streamStore } from '@/lib/stores/stream-store';
import type { MessageWithPartsV2, PartV2 } from '@/types/session-v2';

type MessagePage = { messages: MessageWithPartsV2[] };

/** Flip pages to full ascending order and merge live-committed parts in.
 *  Parts already present in the window (by id) are skipped — that's the
 *  fetch/replay overlap after a switch-back, where the fresh fetch already
 *  contains everything the store's replay re-commits. */
export function mergeSessionWindow(
  pages: readonly MessagePage[],
  committed: readonly PartV2[],
  ownerOf: (partId: string) => string | undefined,
): MessageWithPartsV2[] {
  const messages: MessageWithPartsV2[] = [];
  for (let i = pages.length - 1; i >= 0; i--) messages.push(...pages[i].messages);

  const persisted = new Set<string>();
  for (const m of messages) for (const p of m.parts) persisted.add(p.id);

  const liveByMessage = new Map<string, PartV2[]>();
  for (const part of committed) {
    if (persisted.has(part.id)) continue;
    const messageId = ownerOf(part.id);
    if (!messageId) continue;
    const list = liveByMessage.get(messageId);
    if (list) list.push(part);
    else liveByMessage.set(messageId, [part]);
  }
  if (liveByMessage.size === 0) return messages;

  const out = messages.map((m) => {
    const extra = liveByMessage.get(m.id);
    return extra ? { ...m, parts: [...m.parts, ...extra] } : m;
  });
  const known = new Set(messages.map((m) => m.id));
  for (const [messageId, parts] of liveByMessage) {
    if (known.has(messageId)) continue;
    // Live turns only insert assistant message rows (orchestrator), so the
    // shell's role is safe; timeCreated just needs to be newest-ish — the
    // array position is the render order, not this field.
    out.push({ id: messageId, role: 'assistant', model: null, timeCreated: Date.now(), timeCompleted: null, parts });
  }
  return out;
}

const EMPTY_MESSAGES: MessageWithPartsV2[] = [];

export function useSessionMessagesV2(sessionId: string | null) {
  const query = useInfiniteQuery({
    queryKey: sessionId ? qk.sessionMessagesV2(sessionId) : ['session-messages-v2', 'none'],
    enabled: !!sessionId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listSessionMessagesV2(sessionId!, { limit: 50, before: pageParam }),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

  const partOwners = useRef(new Map<string, string>());

  // Commit version, not the parts themselves: a number snapshot means deltas
  // (which notify the store) don't re-render — only a growing committed list
  // does, which is exactly when the merged view needs rebuilding.
  const subscribeCommitted = useCallback(
    (onStoreChange: () => void) => (sessionId ? streamStore.subscribe(sessionId, onStoreChange) : () => {}),
    [sessionId],
  );
  const committedCount = useSyncExternalStore(
    subscribeCommitted,
    () => streamStore.turnParts(sessionId ?? '').length,
  );

  const messages = useMemo(() => {
    const pages = query.data?.pages;
    if (!pages && committedCount === 0) return EMPTY_MESSAGES;
    return mergeSessionWindow(
      pages ?? [],
      streamStore.turnParts(sessionId ?? ''),
      (partId) => partOwners.current.get(partId),
    );
    // partOwners is covered by committedCount: the map is populated in the
    // same synchronous batch pass that grows turnParts before notifying.
  }, [query.data, committedCount, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    partOwners.current = new Map();

    // Push channel FIRST, then the replay invoke: eventsSubscribe delivers
    // its synchronous replay on the same 'tide:events' channel before live
    // registration, so a listener attached after the invoke would silently
    // drop the replayed prefix; conversely, a live batch landing between the
    // two arrives on push and the store's seq watermark dedupes the overlap
    // with replay. Either ordering of arrival is safe; missing the listener
    // is not.
    const unsubscribe = subscribeEvents((batch) => {
      const mine = batch.events.filter((e) => e.sessionId === sessionId);
      if (mine.length === 0) return;
      for (const e of mine) {
        if (e.messageId && e.partId) partOwners.current.set(e.partId, e.messageId);
      }
      streamStore.applyBatch(mine);
    });
    eventsSubscribe(sessionId, streamStore.lastSeq(sessionId)).catch((err) => {
      console.warn('eventsSubscribe failed', err);
    });

    return () => {
      unsubscribe();
      // The next mount for this session replays from 0 and refetches the
      // window (evicted below), so dropping the live state loses nothing
      // persisted and keeps sessions from accumulating store memory.
      streamStore.clear(sessionId);
      evictSessionMessagesV2(sessionId);
    };
  }, [sessionId]);

  return {
    messages,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
