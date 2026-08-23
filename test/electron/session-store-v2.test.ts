import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStoreV2 } from '../../electron/ipc/session-store-v2.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-v2-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('session-store-v2 schema', () => {
  it('creates the four tables and specced indexes with user_version 2, wal, foreign keys', () => {
    const store = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    expect(store.pragma('user_version')).toBe(2);
    expect(store.pragma('journal_mode')).toBe('wal');
    expect(store.pragma('foreign_keys')).toBe(1);
    const tables = store.tables();
    expect(tables).toEqual(expect.arrayContaining(['session', 'message', 'part', 'event']));
    const indexes = (
      store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['session_list', 'part_window', 'event_replay', 'part_message', 'message_session']),
    );
    store.close();
  });

  it('is idempotent — second open does not throw', () => {
    const p = path.join(dir, 'sessions-v2.db');
    const first = createSessionStoreV2(p);
    first.close();
    const second = createSessionStoreV2(p);
    expect(second.pragma('user_version')).toBe(2);
    second.close();
  });

  it('creates the parent directory when missing', () => {
    const store = createSessionStoreV2(path.join(dir, 'nested', 'deeper', 'sessions-v2.db'));
    expect(store.tables()).toEqual(expect.arrayContaining(['session', 'message', 'part', 'event']));
    store.close();
  });

  it('does not downgrade a newer user_version', () => {
    const p = path.join(dir, 'sessions-v2.db');
    const a = createSessionStoreV2(p);
    a.db.pragma('user_version = 3');
    a.close();
    const b = createSessionStoreV2(p);
    expect(b.pragma('user_version')).toBe(3);
    b.close();
  });
});

describe('session-store-v2 crud', () => {
  it('creates a session and lists metadata only', () => {
    const s = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    s.createSession({ id: 's1', workspacePath: '/w', title: 'New session', modelId: 'm', providerId: 'p' });
    const listed = s.listSessions('/w').sessions;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 's1', title: 'New session', modelId: 'm' });
    expect(listed[0]).not.toHaveProperty('messages');
    s.close();
  });

  it('paginates the list newest-first with a cursor', () => {
    const s = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    for (let i = 0; i < 5; i++) {
      s.createSession({ id: `s${i}`, workspacePath: '/w', title: `t${i}`, modelId: 'm' });
    }
    const page1 = s.listSessions('/w', { limit: 2 });
    expect(page1.sessions.map((x) => x.id)).toEqual(['s4', 's3']);
    expect(page1.nextCursor).toBe('s2');
    const page2 = s.listSessions('/w', { limit: 2, cursor: page1.nextCursor });
    expect(page2.sessions.map((x) => x.id)).toEqual(['s2', 's1']);
    const page3 = s.listSessions('/w', { limit: 2, cursor: page2.nextCursor });
    expect(page3.sessions.map((x) => x.id)).toEqual(['s0']);
    expect(page3.nextCursor).toBeNull();
    s.close();
  });

  it('excludes archived from the default list, includes with flag', () => {
    const s = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    s.createSession({ id: 's1', workspacePath: '/w', title: 'a', modelId: 'm' });
    s.archiveSession('s1');
    expect(s.listSessions('/w')).toEqual({ sessions: [], nextCursor: null });
    expect(s.listSessions('/w', { archived: true }).sessions.map((x) => x.id)).toEqual(['s1']);
    s.close();
  });

  it('appends parts and returns message windows ascending', () => {
    const s = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    s.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    for (let m = 0; m < 3; m++) {
      s.insertMessage({ id: `m${m}`, sessionId: 's1', role: m % 2 ? 'assistant' : 'user' });
      s.insertPart({ id: `p${m}-0`, messageId: `m${m}`, sessionId: 's1', seq: 0, kind: 'text', data: { text: `msg ${m}` } });
    }
    const all = s.sessionMessages('s1', { limit: 50 });
    expect(all.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    const win = s.sessionMessages('s1', { limit: 1 });
    expect(win.messages.map((m) => m.id)).toEqual(['m2']);
    expect(win.nextBefore).toBe('m2');
    const older = s.sessionMessages('s1', { limit: 2, before: win.nextBefore! });
    expect(older.messages.map((m) => m.id)).toEqual(['m0', 'm1']);
    const tail = s.sessionMessages('s1', { limit: 3, before: win.nextBefore! });
    expect(tail.messages.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(tail.nextBefore).toBeNull();
    s.close();
  });

  it('orders parts by seq regardless of insertion order', () => {
    const s = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    s.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    s.insertMessage({ id: 'm0', sessionId: 's1', role: 'user' });
    for (const seq of [2, 0, 1]) {
      s.insertPart({ id: `p${seq}`, messageId: 'm0', sessionId: 's1', seq, kind: 'text', data: { seq } });
    }
    const { messages } = s.sessionMessages('s1', { limit: 50 });
    expect(messages[0].parts.map((p) => p.seq)).toEqual([0, 1, 2]);
    s.close();
  });

  it('round-trips nested JSON part data deep-equal', () => {
    const s = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    s.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    s.insertMessage({ id: 'm0', sessionId: 's1', role: 'user' });
    const data = { nested: { a: [1, { b: null }] }, text: 'x' };
    s.insertPart({ id: 'p0', messageId: 'm0', sessionId: 's1', seq: 0, kind: 'text', data });
    const { messages } = s.sessionMessages('s1', { limit: 50 });
    expect(messages[0].parts[0].data).toEqual(data);
    s.close();
  });

  it('increments usage counters via addUsage', () => {
    const s = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    s.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    s.addUsage('s1', { inputTokens: 10, outputTokens: 5, costUsd: 0.1 });
    s.addUsage('s1', { inputTokens: 1, outputTokens: 2, costUsd: 0.2 });
    const [row] = s.listSessions('/w').sessions;
    expect(row).toMatchObject({ tokensInput: 11, tokensOutput: 7, cost: 0.30000000000000004 });
    s.close();
  });

  it('deleting a session cascades to messages and parts', () => {
    const s = createSessionStoreV2(path.join(dir, 'sessions-v2.db'));
    s.createSession({ id: 's1', workspacePath: '/w', title: 't', modelId: 'm' });
    s.insertMessage({ id: 'm0', sessionId: 's1', role: 'user' });
    s.insertPart({ id: 'p0', messageId: 'm0', sessionId: 's1', seq: 0, kind: 'text', data: {} });
    s.deleteSession('s1');
    expect(s.listSessions('/w').sessions).toHaveLength(0);
    expect(s.sessionMessages('s1', { limit: 50 }).messages).toHaveLength(0);
    s.close();
  });
});
