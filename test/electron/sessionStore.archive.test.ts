import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../../electron/ipc/sessionStore.js';

describe('sessionStore.archiveSession', () => {
  let dir: string;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
    store = createSessionStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('removes the session from the active cache', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    expect(store.getSession(s.id)).toBeUndefined();
    expect(store.listSessions('ws')).toHaveLength(0);
  });

  it('appears in listArchived with header-only fields', () => {
    const s = store.createSession('ws', 'special-title', 'm_special');
    store.archiveSession(s.id);
    const archived = store.listArchived('ws');
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      id: s.id,
      workspaceId: 'ws',
      title: 'special-title',
      modelId: 'm_special',
    });
    expect(archived[0].archivedAt).toBeTruthy();
  });

  it('writes the _archived.json manifest', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    const manifest = path.join(dir, 'sessions', '_archived.json');
    expect(fs.existsSync(manifest)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].id).toBe(s.id);
  });

  it('does NOT modify or delete the full session file', () => {
    const s = store.createSession('ws', 't', 'm');
    const file = path.join(dir, 'sessions', `${s.id}.json`);
    const before = fs.readFileSync(file, 'utf-8');
    store.archiveSession(s.id);
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toBe(before);
  });

  it('on reload, does NOT load archived session into active cache', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    const fresh = createSessionStore(dir);
    fresh.loadAll();
    expect(fresh.getSession(s.id)).toBeUndefined();
    expect(fresh.listArchived('ws')).toHaveLength(1);
  });
});

describe('sessionStore.unarchiveSession', () => {
  let dir: string;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
    store = createSessionStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('restores the full session to the active cache', () => {
    const s = store.createSession('ws', 't', 'm');
    store.addMessage(s.id, 'user', 'before archive');
    store.archiveSession(s.id);

    store.unarchiveSession(s.id);

    const got = store.getSession(s.id);
    expect(got).toBeDefined();
    expect(got?.messages).toHaveLength(1);
    expect(got?.messages[0].content).toBe('before archive');
  });

  it('removes the header from archivedCache and the manifest', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    store.unarchiveSession(s.id);

    expect(store.listArchived('ws')).toHaveLength(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', '_archived.json'), 'utf-8'));
    expect(manifest.entries).toHaveLength(0);
  });

  it('clears archivedAt on the restored session', () => {
    const s = store.createSession('ws', 't', 'm');
    store.archiveSession(s.id);
    store.unarchiveSession(s.id);

    expect(store.getSession(s.id)?.archivedAt).toBeUndefined();
  });

  it('is a no-op (no throw) on an unknown id', () => {
    expect(() => store.unarchiveSession('s_none')).not.toThrow();
  });
});
