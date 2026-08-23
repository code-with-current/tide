import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createConfigStore } from '../../electron/configStore.js';
import { createSessionStore } from '../../electron/ipc/sessionStore.js';
import type { Workspace } from '../../src/types';

const identityCrypto = { encrypt: (s: string) => s, decrypt: (s: string) => s };

function makeWorkspace(id: string): Workspace {
  return {
    id, name: id, path: `/tmp/${id}`, branch: 'main', headCommit: '0',
    isDefault: false, fileCount: 0, worktreeLocation: '.agent/worktrees/', scripts: [],
  };
}

describe('workspace ↔ session cascade', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('archiving a workspace also archives its sessions', () => {
    const sessions = createSessionStore(dir);
    const config = createConfigStore(dir, identityCrypto);

    config.addWorkspace(makeWorkspace('ws_a'));
    const s1 = sessions.createSession('ws_a', 'one', 'm');
    const s2 = sessions.createSession('ws_a', 'two', 'm');
    sessions.createSession('ws_b', 'other', 'm'); // unrelated, must stay active

    // Wire cascade via injected callbacks (Task 3.6 implementation).
    config.archiveWorkspace('ws_a', {
      archiveSessionsByWorkspace: (wid) => {
        for (const s of sessions.listSessions(wid)) sessions.archiveSession(s.id);
      },
    });

    expect(sessions.getSession(s1.id)).toBeUndefined();
    expect(sessions.getSession(s2.id)).toBeUndefined();
    expect(sessions.listArchived('ws_a')).toHaveLength(2);
    expect(sessions.listSessions('ws_b')).toHaveLength(1); // untouched
  });

  it('unarchiving a workspace also unarchives its sessions', () => {
    const sessions = createSessionStore(dir);
    const config = createConfigStore(dir, identityCrypto);

    config.addWorkspace(makeWorkspace('ws_a'));
    const s1 = sessions.createSession('ws_a', 'one', 'm');
    config.archiveWorkspace('ws_a', {
      archiveSessionsByWorkspace: (wid) => {
        for (const s of sessions.listSessions(wid)) sessions.archiveSession(s.id);
      },
    });
    config.unarchiveWorkspace('ws_a', {
      unarchiveSessionsByWorkspace: (wid) => {
        for (const h of sessions.listArchived(wid)) sessions.unarchiveSession(h.id);
      },
    });

    expect(sessions.getSession(s1.id)).toBeDefined();
    expect(sessions.listArchived('ws_a')).toHaveLength(0);
  });

  it('deleting an archived workspace permanently removes its sessions', () => {
    const sessions = createSessionStore(dir);
    const config = createConfigStore(dir, identityCrypto);

    config.addWorkspace(makeWorkspace('ws_a'));
    const s1 = sessions.createSession('ws_a', 'one', 'm');
    config.archiveWorkspace('ws_a', {
      archiveSessionsByWorkspace: (wid) => {
        for (const s of sessions.listSessions(wid)) sessions.archiveSession(s.id);
      },
    });

    config.deleteWorkspace('ws_a', {
      deleteSessionsByWorkspace: (wid) => {
        for (const h of sessions.listArchived(wid)) sessions.deleteSession(h.id);
        for (const s of sessions.listSessions(wid)) sessions.deleteSession(s.id);
      },
    });

    expect(config.listWorkspaces().find(w => w.id === 'ws_a')).toBeUndefined();
    expect(sessions.listArchived('ws_a')).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'sessions', `${s1.id}.json`))).toBe(false);
  });

  it('deleting a workspace that is NOT archived throws', () => {
    const config = createConfigStore(dir, identityCrypto);
    config.addWorkspace(makeWorkspace('ws_a'));
    expect(() => config.deleteWorkspace('ws_a')).toThrow(/must be archived/);
  });
});
