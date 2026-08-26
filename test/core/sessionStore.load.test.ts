import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionStore } from '../../app/core/ipc-adjacent/sessionStore.js';

describe('sessionStore.loadAll', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates sessions/ if missing and returns empty', () => {
    const store = createSessionStore(dir);
    store.loadAll();
    expect(fs.existsSync(path.join(dir, 'sessions'))).toBe(true);
    expect(store.listSessions('ws_any')).toEqual([]);
  });

  it('loads existing sessions from sessions/', () => {
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const session = {
      id: 's_loaded',
      workspaceId: 'ws_x',
      title: 'persisted',
      modelId: 'm_x',
      messages: [],
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(sessionsDir, 's_loaded.json'),
      JSON.stringify(session, null, 2),
    );

    const store = createSessionStore(dir);
    store.loadAll();

    const got = store.getSession('s_loaded');
    expect(got?.title).toBe('persisted');
    expect(store.listSessions('ws_x')).toHaveLength(1);
  });
});
