import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStoreV2 } from '../ipc/session-store-v2.js';
import { createEventSink, type FlushBatch, type SinkEvent } from '../agent/event-sink.js';

let dir: string;
let store: ReturnType<typeof createSessionStoreV2>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-sink-'));
  store = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
  store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
  store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
});
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

const delta = (text: string): SinkEvent => ({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text } });

describe('event-sink', () => {
  it('batches: no rows before the flush interval, all rows after', () => {
    vi.useFakeTimers();
    const sink = createEventSink(store.db, { flushMs: 50 });
    sink.emit(delta('a'));
    sink.emit(delta('b'));
    expect((store.db.prepare('SELECT COUNT(*) c FROM event').get() as { c: number }).c).toBe(0);
    vi.advanceTimersByTime(60);
    expect((store.db.prepare('SELECT COUNT(*) c FROM event').get() as { c: number }).c).toBe(2);
    sink.dispose();
  });

  it('pushes flushed batches to onFlush with first/last seq', () => {
    vi.useFakeTimers();
    const batches: unknown[] = [];
    const sink = createEventSink(store.db, { flushMs: 50, onFlush: (b) => batches.push(b) });
    sink.emit(delta('a'));
    sink.emit(delta('b'));
    vi.advanceTimersByTime(60);
    expect(batches).toHaveLength(1);
    const batch = batches[0] as { events: SinkEvent[]; firstSeq: number; lastSeq: number };
    expect(batch.events.map((e) => (e.data as { text: string }).text)).toEqual(['a', 'b']);
    expect(batch.lastSeq).toBeGreaterThanOrEqual(batch.firstSeq);
    sink.dispose();
  });

  it('part.commit persists a part row and emits the event', () => {
    const sink = createEventSink(store.db, { flushMs: 0 });
    sink.emit({ type: 'part.commit', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { kind: 'text', data: { text: 'ab' } } });
    sink.flush();
    const part = store.db.prepare(`SELECT * FROM part WHERE id = 'p1'`).get() as { kind: string } | undefined;
    expect(part?.kind).toBe('text');
    sink.dispose();
  });

  it('message.end updates session counters in the same flush', () => {
    const sink = createEventSink(store.db, { flushMs: 0 });
    sink.emit({ type: 'message.end', sessionId: 's1', messageId: 'm1', data: { usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 } } });
    sink.flush();
    const [row] = store.listSessions('/w').sessions;
    expect(row).toMatchObject({ tokensInput: 7, tokensOutput: 3, cost: 0.01 });
    sink.dispose();
  });

  it('DB failure degrades to push-only without throwing on emit', () => {
    const sink = createEventSink(store.db, { flushMs: 0 });
    store.close();
    expect(() => {
      sink.emit(delta('a'));
      sink.flush();
    }).not.toThrow();
    sink.dispose();
  });

  it('part.commit is idempotent — one part row, two event rows', () => {
    const sink = createEventSink(store.db, { flushMs: 0 });
    const commit = (): SinkEvent => ({ type: 'part.commit', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { kind: 'text', data: { text: 'ab' } } });
    sink.emit(commit());
    sink.emit(commit());
    expect((store.db.prepare('SELECT COUNT(*) c FROM part').get() as { c: number }).c).toBe(1);
    expect((store.db.prepare('SELECT COUNT(*) c FROM event').get() as { c: number }).c).toBe(2);
    sink.dispose();
  });

  it('turn.end passes through to the event table with no side effects', () => {
    const sink = createEventSink(store.db, { flushMs: 0 });
    sink.emit({ type: 'turn.end', sessionId: 's1', messageId: 'm1' });
    sink.flush();
    const rows = store.db.prepare('SELECT type FROM event').all() as { type: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('turn.end');
    expect((store.db.prepare('SELECT COUNT(*) c FROM part').get() as { c: number }).c).toBe(0);
    expect((store.db.prepare('SELECT time_completed FROM message WHERE id = ?').get('m1') as { time_completed: number | null }).time_completed).toBeNull();
    expect(store.listSessions('/w').sessions[0]).toMatchObject({ tokensInput: 0, tokensOutput: 0, cost: 0 });
    sink.dispose();
  });

  it('partitions flush batches per session', () => {
    vi.useFakeTimers();
    store.createSession({ id: 's2', workspacePath: '/w', title: 't2', modelId: 'm' });
    store.insertMessage({ id: 'm2', sessionId: 's2', role: 'assistant' });
    const batches: FlushBatch[] = [];
    const sink = createEventSink(store.db, { flushMs: 50, onFlush: (b) => batches.push(b) });
    sink.emit(delta('a'));
    sink.emit({ type: 'part.delta', sessionId: 's2', messageId: 'm2', partId: 'p2', data: { text: 'x' } });
    sink.emit(delta('b'));
    vi.advanceTimersByTime(60);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.events[0].sessionId).sort()).toEqual(['s1', 's2']);
    for (const b of batches) {
      expect(new Set(b.events.map((e) => e.sessionId)).size).toBe(1);
      for (const e of b.events) {
        expect(Number.isInteger(e.seq)).toBe(true);
        expect(e.seq).toBeGreaterThan(0);
      }
    }
    sink.dispose();
  });

  it('delivers exactly one batch per interval window — no duplicate interval flushes', () => {
    vi.useFakeTimers();
    const batches: FlushBatch[] = [];
    const sink = createEventSink(store.db, { flushMs: 50, onFlush: (b) => batches.push(b) });
    sink.emit(delta('a'));
    vi.advanceTimersByTime(200);
    expect(batches).toHaveLength(1);
    sink.dispose();
  });

  it('stamps persisted events with ascending integer seq; firstSeq is events[0].seq', () => {
    vi.useFakeTimers();
    const batches: FlushBatch[] = [];
    const sink = createEventSink(store.db, { flushMs: 50, onFlush: (b) => batches.push(b) });
    sink.emit(delta('a'));
    sink.emit(delta('b'));
    sink.emit(delta('c'));
    vi.advanceTimersByTime(60);
    expect(batches).toHaveLength(1);
    const { events, firstSeq, lastSeq } = batches[0];
    const seqs = events.map((e) => e.seq as number);
    for (const s of seqs) expect(Number.isInteger(s)).toBe(true);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    expect(firstSeq).toBe(seqs[0]);
    expect(lastSeq).toBe(seqs[seqs.length - 1]);
    sink.dispose();
  });

  it('a throwing onFlush neither escapes flush() nor re-delivers the batch', () => {
    let calls = 0;
    const sink = createEventSink(store.db, {
      flushMs: 0,
      onFlush: () => { calls += 1; throw new Error('dead sender'); },
    });
    expect(() => sink.emit(delta('a'))).not.toThrow();
    expect(calls).toBe(1);
    expect((store.db.prepare('SELECT COUNT(*) c FROM event').get() as { c: number }).c).toBe(1);
    sink.dispose();
  });
});

describe('event-sink replay + prune', () => {
  it('replay drains pending events from lastSeq in order', () => {
    const sink = createEventSink(store.db, { flushMs: 0 });
    sink.emit(delta('a'));
    sink.emit(delta('b'));
    sink.flush();
    const replayed = sink.replay('s1', 0); // from the beginning
    expect(replayed.map((e) => (e.data as { text: string }).text)).toEqual(['a', 'b']);
    const afterFirst = sink.replay('s1', replayed[0].seq!);
    expect(afterFirst.map((e) => (e.data as { text: string }).text)).toEqual(['b']);
    sink.dispose();
  });

  it('turn.end prunes events below the min live seq but keeps committed parts', () => {
    const sink = createEventSink(store.db, { flushMs: 0 });
    sink.emit({ type: 'part.commit', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { kind: 'text', data: { text: 'ab' }, seq: 0 } });
    sink.emit(delta('c')); // belongs to a second, uncommitted part p2
    sink.flush();
    sink.emit({ type: 'turn.end', sessionId: 's1' });
    sink.flush();
    const remaining = store.db.prepare(`SELECT COUNT(*) c FROM event`).get() as { c: number };
    expect(remaining.c).toBe(1); // only the turn.end survives as the tail marker
    const part = store.db.prepare(`SELECT kind FROM part WHERE id = 'p1'`).get() as { kind: string };
    expect(part.kind).toBe('text');
    sink.dispose();
  });

  it('prune respects live subscriber positions', () => {
    const sink = createEventSink(store.db, { flushMs: 0 });
    sink.emit(delta('a'));
    sink.emit(delta('b'));
    // A subscriber that has only consumed up to the first event holds pruning back.
    sink.markLive('s1', 1);
    sink.emit({ type: 'turn.end', sessionId: 's1' });
    sink.flush();
    sink.emit({ type: 'turn.end', sessionId: 's1' });
    sink.flush();
    const rows = store.db.prepare(`SELECT seq FROM event ORDER BY seq`).all() as { seq: number }[];
    expect(rows.some((r) => r.seq === 2)).toBe(true);
    sink.dispose();
  });
});
