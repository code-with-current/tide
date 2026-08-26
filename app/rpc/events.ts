/** Events RPC — port of electron/ipc/events.ts (the orchestrator-stream
 *  bridge). Replay drains pending rows into the eventsSubscribe response
 *  BEFORE the live flag flips, with no await between the replay read and
 *  registration (EventSink's sync-atomicity contract) — a reconnecting
 *  renderer can neither miss nor double-receive events. Live delivery then
 *  rides the orchestratorEvents message and advances the session floor so
 *  pruning tracks consumption. Single-window Tide means a single subscriber;
 *  the old multi-subscriber Set existed for webContents churn that no longer
 *  applies (re-add a subscriber map if multi-window arrives). */

import type { SessionStoreV2 } from '../core/ipc-adjacent/session-store-v2.js';
import { createEventSink, type EventSink, type FlushBatch } from '../core/agent/event-sink.js';

const DEFAULT_REPLAY_PAGE = 500;

export interface EventsRpcHandlers {
  eventsSubscribe: (params: { sessionId: string; lastSeq: number | null }) => { batches: FlushBatch[] };
  eventsUnsubscribe: (params: { sessionId: string }) => Record<string, never>;
}

export function registerEventsRpc(
  openStore: () => SessionStoreV2,
  send: (batch: FlushBatch) => void,
  opts?: { flushMs?: number; replayPage?: number },
): { handlers: EventsRpcHandlers; sink: EventSink } {
  const replayPage = opts?.replayPage ?? DEFAULT_REPLAY_PAGE;
  // Single store instance for the process — opened here, at registration.
  const store = openStore();
  const liveSessions = new Set<string>();

  const sink = createEventSink(store.db, {
    flushMs: opts?.flushMs,
    onFlush: (batch) => {
      // Batches are per-session partitions — every event shares events[0]'s sessionId.
      const sessionId = batch.events[0].sessionId;
      if (!liveSessions.has(sessionId)) return;
      send(batch);
      // Degraded push-only batches (lastSeq 0) carry no watermark — skip.
      // Prune keeps seq < floor, so the floor moves PAST the delivered seq to
      // make the just-delivered rows reclaimable at the next turn.end.
      if (batch.lastSeq > 0) sink.markLive(sessionId, batch.lastSeq + 1);
    },
  });

  return {
    sink,
    handlers: {
      // Sync-atomic (EventSink contract): replay → markLive → live flag, with
      // no await anywhere. The paging loop is synchronous, so no flush can
      // interleave and prune past a cursor that was read but not yet delivered.
      eventsSubscribe: ({ sessionId, lastSeq }) => {
        const batches: FlushBatch[] = [];
        let cursor = lastSeq ?? 0;
        for (;;) {
          const page = sink.replay(sessionId, cursor, replayPage);
          if (page.length === 0) break;
          batches.push({ events: page, firstSeq: page[0].seq, lastSeq: page[page.length - 1].seq });
          cursor = page[page.length - 1].seq;
          if (page.length < replayPage) break;
        }
        if (cursor > 0) sink.markLive(sessionId, cursor + 1);
        liveSessions.add(sessionId);
        return { batches };
      },
      // A session switch must not leak pushes for the departed session.
      eventsUnsubscribe: ({ sessionId }) => {
        liveSessions.delete(sessionId);
        return {};
      },
    },
  };
}
