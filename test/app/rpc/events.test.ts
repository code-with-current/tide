/** Events RPC contract port (electron/ipc/events.ts): replay drains pending
 *  rows into the subscribe response synchronously before the live flag flips,
 *  live flushes push only subscribed sessions and advance the replay floor,
 *  unsubscribe stops pushes without touching replayability, and degraded
 *  push-only batches (lastSeq 0) carry no watermark. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerEventsRpc } from '../../../app/rpc/events';
import { createSessionStoreV2 } from '../../../app/core/ipc-adjacent/session-store-v2.js';
import type { FlushBatch, SinkEvent } from '../../../app/core/agent/event-sink.js';

let dir: string;
let sent: FlushBatch[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rpc-events-'));
  sent = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// flushMs 0 makes emit() flush synchronously — no fake timers needed.
function setup(opts?: { flushMs?: number; replayPage?: number }) {
  const store = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
  const reg = registerEventsRpc(() => store, (b) => sent.push(b), opts);
  return { ...reg, store };
}

function delta(text: string): SinkEvent {
  return { type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text } };
}

describe('registerEventsRpc', () => {
  it('replays persisted events in order with contiguous batch seqs', () => {
    const { sink, handlers } = setup({ flushMs: 0 });
    for (let i = 0; i < 5; i++) sink.emit(delta(`x${i}`));

    const { batches } = handlers.eventsSubscribe({ sessionId: 's1', lastSeq: null });
    const events = batches.flatMap((b) => b.events);
    expect(events.map((e) => (e.data as { text: string }).text)).toEqual(['x0', 'x1', 'x2', 'x3', 'x4']);
    for (let i = 1; i < events.length; i++) expect(events[i].seq).toBe(events[i - 1].seq + 1);
    for (const b of batches) {
      expect(b.firstSeq).toBe(b.events[0].seq);
      expect(b.lastSeq).toBe(b.events[b.events.length - 1].seq);
    }
    // Replay rides the response, never the push channel.
    expect(sent).toEqual([]);
  });

  it('pages replay at replayPage into multiple batches', () => {
    const { sink, handlers } = setup({ flushMs: 0, replayPage: 2 });
    for (let i = 0; i < 5; i++) sink.emit(delta(`x${i}`));

    const { batches } = handlers.eventsSubscribe({ sessionId: 's1', lastSeq: null });
    expect(batches.map((b) => b.events.length)).toEqual([2, 2, 1]);
    expect(batches[0].lastSeq).toBeLessThan(batches[1].firstSeq);
    expect(batches[1].lastSeq).toBeLessThan(batches[2].firstSeq);
  });

  it('pushes live batches to subscribed sessions and advances the floor', () => {
    const { sink, handlers } = setup({ flushMs: 0 });
    sink.emit(delta('a'));
    sink.emit(delta('b'));
    const { batches } = handlers.eventsSubscribe({ sessionId: 's1', lastSeq: null });
    const cursor = batches[batches.length - 1].lastSeq;

    sink.emit(delta('c'));
    expect(sent).toHaveLength(1);
    expect(sent[0].events.map((e) => (e.data as { text: string }).text)).toEqual(['c']);

    // Floor moved PAST the delivered seq: after a turn.end prune, the
    // live-delivered row (cursor+1) is reclaimable — only the marker survives.
    sink.emit({ type: 'turn.end', sessionId: 's1' });
    expect(sink.replay('s1', cursor, 500).map((e) => e.type)).toEqual(['turn.end']);
  });

  it('unsubscribe stops live pushes without penalizing replayability', () => {
    const { sink, handlers } = setup({ flushMs: 0 });
    sink.emit(delta('a'));
    const { batches } = handlers.eventsSubscribe({ sessionId: 's1', lastSeq: null });
    const cursor = batches[batches.length - 1].lastSeq;
    expect(handlers.eventsUnsubscribe({ sessionId: 's1' })).toEqual({});

    sink.emit(delta('b'));
    expect(sent).toEqual([]);
    // No floor advance either: the undelivered row stays replayable.
    expect(sink.replay('s1', cursor, 500).map((e) => (e.data as { text: string }).text)).toEqual(['b']);
  });

  it('re-subscribe from the returned cursor yields no duplicates and no gaps', () => {
    const { sink, handlers } = setup({ flushMs: 0 });
    sink.emit(delta('a'));
    const first = handlers.eventsSubscribe({ sessionId: 's1', lastSeq: null });
    const cursor = first.batches[first.batches.length - 1].lastSeq;
    handlers.eventsUnsubscribe({ sessionId: 's1' });

    for (let i = 0; i < 3; i++) sink.emit(delta(`n${i}`));
    const second = handlers.eventsSubscribe({ sessionId: 's1', lastSeq: cursor });

    const events = second.batches.flatMap((b) => b.events);
    expect(events.map((e) => (e.data as { text: string }).text)).toEqual(['n0', 'n1', 'n2']);
    for (const e of events) expect(e.seq).toBeGreaterThan(cursor);
    expect(events[0].seq).toBe(cursor + 1);
  });

  it('flush with no subscribers sends nothing and stays replayable', () => {
    const { sink, handlers } = setup({ flushMs: 0 });
    sink.emit(delta('orphan'));

    expect(sent).toEqual([]);
    const { batches } = handlers.eventsSubscribe({ sessionId: 's1', lastSeq: null });
    expect(batches.flatMap((b) => b.events)).toHaveLength(1);
  });

  it('degraded push-only batches (lastSeq 0) reach the live session without a watermark', () => {
    const { sink, handlers, store } = setup({ flushMs: 0 });
    handlers.eventsSubscribe({ sessionId: 's1', lastSeq: null });
    // Force the flush transaction to fail — the sink degrades to push-only.
    store.close();

    expect(() => sink.emit(delta('degraded'))).not.toThrow();
    expect(sent).toHaveLength(1);
    expect(sent[0].lastSeq).toBe(0);
    expect(sent[0].firstSeq).toBe(0);
    expect(sent[0].events[0].seq).toBeUndefined();
  });
});
