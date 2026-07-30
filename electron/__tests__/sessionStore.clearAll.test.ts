import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../ipc/sessionStore.js';

describe('sessionStore.clearAll', () => {
  let dir: string;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
    store = createSessionStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('removes all sessions from both caches', () => {
    const a = store.createSession('ws', 'a', 'm');
    const b = store.createSession('ws', 'b', 'm');
    store.archiveSession(a.id);

    store.clearAllSessions();

    expect(store.listSessions('ws')).toHaveLength(0);
    expect(store.listArchived('ws')).toHaveLength(0);
    expect(store.getSession(b.id)).toBeUndefined();
  });

  it('deletes all session files and the manifest', () => {
    const a = store.createSession('ws', 'a', 'm');
    store.archiveSession(a.id);

    store.clearAllSessions();

    const sessionsDir = path.join(dir, 'sessions');
    const remaining = fs.readdirSync(sessionsDir);
    expect(remaining).toEqual([]);
  });

  it('removes sessions.json.bak if present', () => {
    // Simulate a previously-migrated state.
    fs.writeFileSync(path.join(dir, 'sessions.json.bak'), '{"sessions":[]}');
    store.clearAllSessions();
    expect(fs.existsSync(path.join(dir, 'sessions.json.bak'))).toBe(false);
  });

  it('removes sessions.json.broken-* files if present', () => {
    fs.writeFileSync(path.join(dir, 'sessions.json.broken-1234'), '{bad');
    store.clearAllSessions();
    expect(fs.existsSync(path.join(dir, 'sessions.json.broken-1234'))).toBe(false);
  });

  it('does NOT touch config.json', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{"providers":[],"workspaces":[]}');
    store.clearAllSessions();
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    expect(cfg.workspaces).toEqual([]);
  });
});
