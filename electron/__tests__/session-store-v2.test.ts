import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStoreV2 } from '../ipc/session-store-v2.js';

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
    expect(indexes).toEqual(expect.arrayContaining(['session_list', 'part_window', 'event_replay']));
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
