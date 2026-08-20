import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStoreV2 } from '../ipc/session-store-v2.js';
import { registerEventsIpc } from '../ipc/events.js';

let dir: string;
let store: ReturnType<typeof createSessionStoreV2>;
const handlers = new Map<string, Function>();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-evts-'));
  store = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
  handlers.clear();
});
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

type Sender = { send: (channel: string, batch: any) => void };

function subscribe(sender: Sender, sessionId: string, lastSeq: number | null): Promise<void> {
  const fn = handlers.get('tide:events:subscribe')!;
  return fn({ sender }, sessionId, lastSeq) as Promise<void>;
}

interface Batch { events: { data: { text?: string } }[]; firstSeq: number; lastSeq: number }

describe('events ipc', () => {
  it('subscribe replays pending then switches to live push with no gap', async () => {
    store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0 });

    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'a' } });
    sink.flush();

    const sent: unknown[] = [];
    await subscribe({ send: (_ch: string, batch: unknown) => sent.push(batch) }, 's1', 0);
    expect(sent).toHaveLength(1); // replayed event arrived

    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'b' } });
    sink.flush();
    expect(sent).toHaveLength(2); // live push continued seamlessly
    sink.dispose();
  });

  it('replay pages without gaps or dupes across page boundary', async () => {
    store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0 });
    for (let i = 0; i < 7; i++) {
      sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: String(i) } });
    }
    sink.flush();

    const texts: string[] = [];
    await subscribe({ send: (_ch: string, batch: any) => { for (const e of batch.events) texts.push(e.data.text); } }, 's1', 0);
    expect(texts).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    sink.dispose();
  });

  it('live delivery advances the floor (pruning tracks consumption)', async () => {
    store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0 });
    const sent: unknown[] = [];
    await subscribe({ send: (_ch: string, batch: unknown) => sent.push(batch) }, 's1', 0);

    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'x' } });
    sink.flush();
    sink.emit({ type: 'turn.end', sessionId: 's1' });
    sink.flush();
    // The delta was consumed live (floor advanced past it), so the turn.end
    // prune may reclaim it: only the turn.end marker remains.
    const rows = store.db.prepare(`SELECT type FROM event`).all() as { type: string }[];
    expect(rows).toEqual([{ type: 'turn.end' }]);
    sink.dispose();
  });

  it('list query plan never touches the part table', () => {
    const plan = store.db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM session WHERE workspace_path = ? AND archived_at IS NULL ORDER BY time_updated DESC, id DESC LIMIT 50`,
    ).all('/w') as { detail: string }[];
    expect(plan.some((p) => p.detail.includes('part'))).toBe(false);
  });

  it('repeated subscribes from one sender attach a single destroyed listener', async () => {
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0 });
    let destroyedListeners = 0;
    const sender = {
      send: () => {},
      once: (_event: string, _cb: () => void) => { destroyedListeners += 1; },
    };
    await subscribe(sender, 's1', 0);
    await subscribe(sender, 's2', 0);
    expect(destroyedListeners).toBe(1);
    sink.dispose();
  });

  it('a throwing sender neither starves same-session peers nor stalls the floor', async () => {
    store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0 });

    const liveBatches: Batch[] = [];
    const live = { send: (_ch: string, b: unknown) => liveBatches.push(b as Batch) };
    await subscribe(live, 's1', 0);
    // delta a (seq 1) — delivered to the live peer, floor advances to 2.
    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'a' } });
    sink.flush();
    expect(liveBatches).toHaveLength(1);

    let deadCalls = 0;
    const dead = {
      send: () => { deadCalls += 1; throw new Error('Object has been destroyed'); },
    };
    await subscribe(dead, 's1', 1); // nothing to replay — registration must not send

    // delta b (seq 2) — dead throws mid-delivery; live must still get the
    // batch, the floor must still advance, and dead must be dropped.
    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'b' } });
    expect(() => sink.flush()).not.toThrow();
    expect(liveBatches).toHaveLength(2);

    // delta c (seq 3) + turn.end (seq 4) — with flushMs: 0 each emit is its
    // own batch, so every event is delivered live before its prune: the floor
    // ends at 5 and the turn.end prune may reclaim a, b AND c.
    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'c' } });
    sink.emit({ type: 'turn.end', sessionId: 's1' });
    sink.flush();
    expect(deadCalls).toBe(1); // dropped after its first throw — never re-attempted
    expect(liveBatches).toHaveLength(4); // peer served every batch (a, b, c, turn.end)
    // Had the dead sender stalled the floor at 2, only a would be pruned and
    // b/c would still be on disk.
    const rows = store.db.prepare(`SELECT type FROM event ORDER BY seq`).all() as { type: string }[];
    expect(rows).toEqual([{ type: 'turn.end' }]);
    sink.dispose();
  });

  it('replay continues across page boundaries with an injected page size', async () => {
    store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0, replayPage: 3 });
    for (let i = 0; i < 7; i++) {
      sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: String(i) } });
    }
    sink.flush();

    const pages: string[][] = [];
    await subscribe({ send: (_ch: string, batch: Batch) => pages.push(batch.events.map((e) => e.data.text!)) }, 's1', 0);
    expect(pages).toEqual([['0', '1', '2'], ['3', '4', '5'], ['6']]);
    sink.dispose();
  });

  it('firing the destroyed callback stops delivery without affecting peers', async () => {
    store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0 });
    let onDestroyed: (() => void) | null = null;
    let deadSends = 0;
    const dead = {
      send: () => { deadSends += 1; },
      once: (_event: string, cb: () => void) => { onDestroyed = cb; },
    };
    const liveBatches: Batch[] = [];
    await subscribe(dead, 's1', 0);
    await subscribe({ send: (_ch: string, b: unknown) => liveBatches.push(b as Batch) }, 's1', 0);

    onDestroyed!();
    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: 'x' } });
    sink.flush();
    expect(deadSends).toBe(0); // destroyed sender no longer attempted
    expect(liveBatches).toHaveLength(1); // peer unaffected
    sink.dispose();
  });

  it('subscribe with lastSeq null replays everything from the beginning', async () => {
    store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0 });
    for (let i = 0; i < 3; i++) {
      sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: String(i) } });
    }
    sink.flush();

    const texts: string[] = [];
    await subscribe({ send: (_ch: string, batch: Batch) => { for (const e of batch.events) texts.push(e.data.text!); } }, 's1', null);
    expect(texts).toEqual(['0', '1', '2']);
    sink.dispose();
  });

  it('reconnect from the last received seq gets only new events', async () => {
    store.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    store.insertMessage({ id: 'm1', sessionId: 's1', role: 'assistant' });
    const sink = registerEventsIpc({
      handle: (ch: string, fn: Function) => handlers.set(ch, fn),
    }, store, { flushMs: 0 });
    for (let i = 0; i < 3; i++) {
      sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: String(i) } });
    }
    sink.flush();

    const aTexts: string[] = [];
    let aLastSeq = 0;
    await subscribe({
      send: (_ch: string, batch: Batch) => {
        for (const e of batch.events) aTexts.push(e.data.text!);
        aLastSeq = batch.lastSeq;
      },
    }, 's1', 0);
    expect(aTexts).toEqual(['0', '1', '2']); // full replay on first connect

    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: '3' } });
    sink.flush();
    expect(aTexts).toEqual(['0', '1', '2', '3']); // live push

    // Renderer reload: reconnect from the last seq it actually received.
    const bTexts: string[] = [];
    await subscribe({ send: (_ch: string, batch: Batch) => { for (const e of batch.events) bTexts.push(e.data.text!); } }, 's1', aLastSeq);
    expect(bTexts).toEqual([]); // nothing replayed — nothing missed, nothing repeated

    sink.emit({ type: 'part.delta', sessionId: 's1', messageId: 'm1', partId: 'p1', data: { text: '4' } });
    sink.flush();
    expect(bTexts).toEqual(['4']); // only the new event
    expect(aTexts).toEqual(['0', '1', '2', '3', '4']); // original subscriber unaffected
    sink.dispose();
  });
});
