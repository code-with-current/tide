import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../../electron/ipc/sessionStore.js';

describe('sessionStore.renameSession', () => {
  let dir: string;
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
    store = createSessionStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('updates title on an active session and persists', () => {
    const s = store.createSession('ws', 'old', 'm');
    store.renameSession(s.id, 'new title');
    expect(store.getSession(s.id)?.title).toBe('new title');
    const fresh = createSessionStore(dir);
    expect(fresh.getSession(s.id)?.title).toBe('new title');
  });

  it('updates title on an archived session via the manifest only', () => {
    const s = store.createSession('ws', 'old', 'm');
    store.archiveSession(s.id);
    store.renameSession(s.id, 'archived-new');

    const archived = store.listArchived('ws');
    expect(archived[0].title).toBe('archived-new');

    // The full file on disk should still have the old title (we only update the manifest).
    const fileSession = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${s.id}.json`), 'utf-8'));
    expect(fileSession.title).toBe('old');
  });

  it('is a no-op (no throw) on an unknown id', () => {
    expect(() => store.renameSession('s_none', 'x')).not.toThrow();
  });
});
