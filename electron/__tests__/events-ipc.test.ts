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

function subscribe(sender: { send: (channel: string, batch: unknown) => void }, sessionId: string, lastSeq: number): Promise<void> {
  const fn = handlers.get('tide:events:subscribe')!;
  return fn({ sender }, sessionId, lastSeq) as Promise<void>;
}

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
});
