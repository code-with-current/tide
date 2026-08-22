import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createConfigStore } from '../../electron/configStore.js';
import type { Workspace } from '../../src/types';

const identityCrypto = { encrypt: (s: string) => s, decrypt: (s: string) => s };

function makeWorkspace(id: string): Workspace {
  return {
    id,
    name: `ws-${id}`,
    path: `/tmp/${id}`,
    branch: 'main',
    headCommit: '0000000',
    isDefault: false,
    fileCount: 0,
    worktreeLocation: '.agent/worktrees/',
    scripts: [],
  };
}

describe('configStore.archiveWorkspace', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('sets archivedAt on the workspace', () => {
    const store = createConfigStore(dir, identityCrypto);
    store.addWorkspace(makeWorkspace('ws_a'));
    store.archiveWorkspace('ws_a');
    const ws = store.listWorkspaces().find(w => w.id === 'ws_a');
    expect(ws?.archivedAt).toBeTruthy();
  });

  it('unarchiveWorkspace clears archivedAt', () => {
    const store = createConfigStore(dir, identityCrypto);
    store.addWorkspace(makeWorkspace('ws_a'));
    store.archiveWorkspace('ws_a');
    store.unarchiveWorkspace('ws_a');
    const ws = store.listWorkspaces().find(w => w.id === 'ws_a');
    expect(ws?.archivedAt).toBeUndefined();
  });

  it('persists across reloads', () => {
    const store = createConfigStore(dir, identityCrypto);
    store.addWorkspace(makeWorkspace('ws_a'));
    store.archiveWorkspace('ws_a');

    const fresh = createConfigStore(dir, identityCrypto);
    const ws = fresh.listWorkspaces().find(w => w.id === 'ws_a');
    expect(ws?.archivedAt).toBeTruthy();
  });

  it('is a no-op (no throw) on unknown id', () => {
    const store = createConfigStore(dir, identityCrypto);
    expect(() => store.archiveWorkspace('ws_none')).not.toThrow();
  });
});
