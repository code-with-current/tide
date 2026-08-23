import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../../electron/ipc/sessionStore.js';

describe('sessionStore.deleteSession', () => {
  let dir: string;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
    store = createSessionStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('removes the session from the cache', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    store.deleteSession(s.id);
    expect(store.getSession(s.id)).toBeUndefined();
  });

  it('unlinks the session file on disk', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    const file = path.join(dir, 'sessions', `${s.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    store.deleteSession(s.id);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('does not throw when deleting an unknown id', () => {
    expect(() => store.deleteSession('s_nonexistent')).not.toThrow();
  });
});

describe('sessionStore.deleteSession gating', () => {
  let dir: string;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
    store = createSessionStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('throws when deleting an active (non-archived) session', () => {
    const s = store.createSession('ws', 't', 'm');
    expect(() => store.deleteSession(s.id)).toThrow(/must be archived/);
  });

  it('succeeds when the session is archived', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    expect(() => store.deleteSession(s.id)).not.toThrow();
    expect(store.listArchived('ws')).toHaveLength(0);
  });

  it('cleans the full session file on archived delete', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    store.deleteSession(s.id);
    expect(fs.existsSync(path.join(dir, 'sessions', `${s.id}.json`))).toBe(false);
  });

  it('no-throw on unknown id', () => {
    expect(() => store.deleteSession('s_none')).not.toThrow();
  });
});
