/** tide:events:subscribe — reconnectable stream subscription. Replay drains
 * pending rows BEFORE live push begins (synchronously — see EventSink's
 * sync-atomicity contract), so a reconnecting renderer can't miss or
 * double-receive events. Live delivery advances the session floor so pruning
 * tracks consumption. */

import type { SessionStoreV2 } from './session-store-v2.js';
import { createEventSink, type EventSink, type FlushBatch } from '../agent/event-sink.js';

/** Structural stand-in for Electron's WebContents as seen by this module —
 * `once` is optional so minimal test senders (send-only) satisfy the type. */
interface SinkSender {
  send(channel: string, batch: FlushBatch): void;
  once?(event: 'destroyed', listener: () => void): void;
}

interface HandleableIpcMain {
  handle(channel: string, fn: (e: { sender: SinkSender }, ...args: any[]) => unknown): void;
}

const REPLAY_PAGE = 500;

export function registerEventsIpc(ipcMain: HandleableIpcMain, store: SessionStoreV2, opts?: { flushMs?: number }): EventSink {
  const subscribers = new Map<string, Set<SinkSender>>();
  // One destroyed-listener per sender, not per subscribe — the renderer
  // re-subscribes on every session switch and would otherwise pile up
  // listeners on the same webContents (same fix as tide:subscribeTodos).
  const listening = new WeakSet<SinkSender>();

  const sink = createEventSink(store.db, {
    flushMs: opts?.flushMs,
    onFlush: (batch) => {
      // Batches are per-session partitions — every event shares events[0]'s sessionId.
      const sessionId = batch.events[0].sessionId;
      const subs = subscribers.get(sessionId);
      if (!subs) return;
      for (const s of subs) s.send('tide:events', batch);
      // Degraded push-only batches (lastSeq 0) carry no watermark — skip.
      // Prune keeps seq < floor, so the floor moves PAST the delivered seq to
      // make the just-delivered rows reclaimable at the next turn.end.
      if (batch.lastSeq > 0) sink.markLive(sessionId, batch.lastSeq + 1);
    },
  });

  ipcMain.handle('tide:events:subscribe', (e, sessionId: string, lastSeq: number | null) => {
    const sub = e.sender;
    let set = subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      subscribers.set(sessionId, set);
    }
    // Sync-atomic registration (EventSink contract): replay → markLive → add,
    // with no await anywhere. The paging loop is synchronous — send() doesn't
    // yield to the event loop, so no flush can interleave and prune past the cursor.
    let cursor = lastSeq ?? 0;
    for (;;) {
      const page = sink.replay(sessionId, cursor, REPLAY_PAGE);
      if (page.length === 0) break;
      sub.send('tide:events', { events: page, firstSeq: page[0].seq, lastSeq: page[page.length - 1].seq });
      cursor = page[page.length - 1].seq;
      if (page.length < REPLAY_PAGE) break;
    }
    if (cursor > 0) sink.markLive(sessionId, cursor + 1);
    set.add(sub);
    if (!listening.has(sub)) {
      listening.add(sub);
      sub.once?.('destroyed', () => {
        for (const [id, subs] of subscribers) {
          subs.delete(sub);
          if (subs.size === 0) subscribers.delete(id);
        }
      });
    }
  });

  return sink;
}
