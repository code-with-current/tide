import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const pathsState = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../app/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/platform/paths')>();
  return { ...actual, appDataDir: () => pathsState.dir };
});

import { registerWorkspacesRpc, readDirTree, type WorkspaceDomain } from '../../../app/rpc/workspaces';
import type { Workspace, WorkspaceProgressEvent } from '../../../shared/rpc';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-ws-rpc-'));
  pathsState.dir = path.join(root, 'appdata');
});

function ws(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws1',
    name: 'W',
    path: path.join(root, 'repo'),
    branch: 'main',
    headCommit: 'unknown',
    isDefault: false,
    fileCount: 0,
    worktreeLocation: '.agent/worktrees/',
    scripts: [],
    ...over,
  };
}

function fakeDomain(workspaces: Workspace[]) {
  const state = {
    added: [] as Workspace[],
    updated: [] as Array<{ id: string; patch: Partial<Workspace> }>,
    archived: [] as string[],
    unarchived: [] as string[],
    deleted: [] as string[],
    lastSession: { sessionId: null as string | null, workspaceId: null as string | null },
  };
  const domain: WorkspaceDomain = {
    listWorkspaces: () => workspaces,
    addWorkspace: (w) => { state.added.push(w); workspaces.push(w); },
    updateWorkspace: (id, patch) => {
      state.updated.push({ id, patch });
      const w = workspaces.find((x) => x.id === id);
      if (w) Object.assign(w, patch);
    },
    archiveWorkspace: (id) => { state.archived.push(id); },
    unarchiveWorkspace: (id) => { state.unarchived.push(id); },
    deleteWorkspace: (id) => { state.deleted.push(id); },
    getLastSession: () => state.lastSession,
    setLastSession: (sessionId, workspaceId) => { state.lastSession = { sessionId, workspaceId }; },
  };
  return { domain, state };
}

describe('workspaces rpc', () => {
  it('workspaceList/workspaceGet read through the domain', () => {
    const { domain } = fakeDomain([ws()]);
    const h = registerWorkspacesRpc(domain);
    expect(h.workspaceList({})).toHaveLength(1);
    expect(h.workspaceGet({ workspaceId: 'ws1' })?.name).toBe('W');
    expect(h.workspaceGet({ workspaceId: 'nope' })).toBeNull();
  });

  it('workspacesExist probes the filesystem', () => {
    const { domain } = fakeDomain([]);
    const h = registerWorkspacesRpc(domain);
    const file = path.join(root, 'plain.txt');
    fs.writeFileSync(file, 'x');
    expect(h.workspacesExist({ paths: [root, file, '/definitely/not/here'] })).toEqual({
      [root]: true,
      [file]: false,
      '/definitely/not/here': false,
    });
  });

  it('lastSessionSet round-trips through the domain', async () => {
    const { domain, state } = fakeDomain([]);
    const h = registerWorkspacesRpc(domain);
    await h.lastSessionSet({ sessionId: 's1', workspaceId: 'ws1' });
    expect(state.lastSession).toEqual({ sessionId: 's1', workspaceId: 'ws1' });
    expect(h.lastSessionGet({})).toEqual({ sessionId: 's1', workspaceId: 'ws1' });
  });

  it('workspaceFileRead sandboxes to the workspace root', () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world');
    fs.writeFileSync(path.join(repo, 'logo.png'), 'not really png');
    const { domain } = fakeDomain([ws()]);

    const h = registerWorkspacesRpc(domain);
    expect(h.workspaceFileRead({ workspaceId: 'ws1', relPath: 'a.txt' })).toEqual({
      ok: true,
      content: 'hello world',
      truncated: false,
      bytes: 11,
    });
    expect(h.workspaceFileRead({ workspaceId: 'ws1', relPath: '../secrets' })).toMatchObject({
      ok: false,
      reason: 'path escapes workspace root',
    });
    expect(h.workspaceFileRead({ workspaceId: 'ws1', relPath: 'missing.txt' })).toMatchObject({
      ok: false,
      reason: 'file not found',
    });
    expect(h.workspaceFileRead({ workspaceId: 'ws1', relPath: 'logo.png' })).toMatchObject({
      ok: false,
      reason: 'binary file',
    });
  });

  it('gitRepoDetect detects an initialized repo', async () => {
    const repo = path.join(root, 'gitrepo');
    fs.mkdirSync(repo, { recursive: true });
    execSync('git init --quiet -b main', { cwd: repo });
    execSync('git config user.email t@t.t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    execSync('git commit --allow-empty -m init --quiet', { cwd: repo });

    const { domain } = fakeDomain([]);
    const h = registerWorkspacesRpc(domain);
    const info = await h.gitRepoDetect({ dirPath: repo });
    expect(info).toMatchObject({ isRepo: true, branch: 'main' });
    expect(typeof info?.fileCount).toBe('number');
    expect(await h.gitRepoDetect({ dirPath: root })).toBeNull();
  });

  it('workspaceAdd creates the folder, inits git, records the workspace, and streams progress', async () => {
    const { domain, state } = fakeDomain([]);
    const events: WorkspaceProgressEvent[] = [];
    const h = registerWorkspacesRpc(domain, {
      progress: (e) => events.push(e),
    });

    const dir = path.join(root, 'fresh');
    const created = await h.workspaceAdd({
      input: { path: dir, name: 'Fresh', requestId: 'req-1' },
    });

    expect(created.name).toBe('Fresh');
    expect(created.path).toBe(dir);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(state.added).toHaveLength(1);
    // Progress milestones: requestId-correlated, at least folder + detect steps.
    expect(events.every((e) => e.requestId === 'req-1')).toBe(true);
    expect(events.some((e) => e.step === 'folder' && e.status === 'done')).toBe(true);
    expect(events.some((e) => e.step === 'detect' && e.status === 'done')).toBe(true);
  });

  it('workspaceUpdate mutates and returns the fresh record', () => {
    const { domain } = fakeDomain([ws()]);
    const h = registerWorkspacesRpc(domain);
    const res = h.workspaceUpdate({ workspaceId: 'ws1', patch: { name: 'Renamed' } });
    expect(res?.name).toBe('Renamed');
  });

  it('readDirTree caps depth and skips noise entries', () => {
    const base = path.join(root, 'tree');
    fs.mkdirSync(path.join(base, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(base, 'sub', 'deep', 'leaf.ts'), 'x');
    fs.writeFileSync(path.join(base, 'top.ts'), 'x');
    fs.mkdirSync(path.join(base, 'node_modules'), { recursive: true });

    const nodes = readDirTree(base, '', 3);
    expect(nodes.map((n) => n.name).sort()).toEqual(['sub', 'top.ts']);
    const sub = nodes.find((n) => n.name === 'sub');
    // depth 3 → one more level under sub/ (its children list is depth 2's dir).
    expect(sub?.children).toHaveLength(1);
  });
});
