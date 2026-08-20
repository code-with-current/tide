import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStoreV2 } from '../ipc/session-store-v2.js';
import { createEventSink, type SinkEvent } from '../agent/event-sink.js';

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
});
