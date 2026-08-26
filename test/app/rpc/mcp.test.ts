import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// One temp app-data dir for the whole file: the pool and the config store
// are module singletons that latch the first appDataDir they see, so a
// per-test dir would leave them pointing at deleted directories.
const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../app/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/platform/paths')>();
  return { ...actual, appDataDir: () => state.dir };
});

import { registerMcpRpc } from '../../../app/rpc/mcp';
import type { McpEvent } from '../../../shared/rpc';

// A config whose env references an unstored secret lands on the
// needs_credentials fast path — deterministic, no subprocess spawn.
const secretServer = (secretName: string) => ({
  type: 'stdio' as const,
  command: 'echo',
  args: ['hi'],
  env: { TOKEN: `{{secret:${secretName}}}` },
});

beforeAll(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rpc-mcp-'));
});

afterAll(() => {
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe('registerMcpRpc config CRUD', () => {
  it('mcpAdd validates the config before writing anything', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    const res = await rpc.mcpAdd({
      name: 'bad',
      config: { type: 'stdio' },
      scope: 'user',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('command');
    expect((await rpc.mcpReadRaw({ scope: 'user' })).config).not.toHaveProperty('bad');
  });

  it('mcpAdd/mcpUpdate/mcpRemove round-trip through the user config store', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    expect((await rpc.mcpAdd({ name: 'crud', config: secretServer('crud-tok'), scope: 'user' })).ok).toBe(true);
    let raw = await rpc.mcpReadRaw({ scope: 'user' });
    expect(raw.ok).toBe(true);
    expect(raw.config).toMatchObject({ crud: { type: 'stdio', command: 'echo' } });

    await rpc.mcpUpdate({ name: 'crud', config: { type: 'stdio', command: 'printf' }, scope: 'user' });
    raw = await rpc.mcpReadRaw({ scope: 'user' });
    expect(raw.config).toMatchObject({ crud: { command: 'printf' } });

    expect((await rpc.mcpRemove({ name: 'crud', scope: 'user' })).ok).toBe(true);
    raw = await rpc.mcpReadRaw({ scope: 'user' });
    expect(raw.config).not.toHaveProperty('crud');
  });

  it('rejects builtin edits and removals', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    expect((await rpc.mcpUpdate({ name: 'x', config: { type: 'stdio', command: 'echo' }, scope: 'builtin' })).ok).toBe(false);
    expect((await rpc.mcpRemove({ name: 'x', scope: 'builtin' })).ok).toBe(false);
  });

  it('project scope without an active workspace errors instead of guessing a path', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    const res = await rpc.mcpAdd({ name: 'proj', config: secretServer('p'), scope: 'project' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no active workspace/i);
    // Import hits the same guard — colocated here because the workspace test
    // below activates a workspace into module state for the rest of the file.
    const imp = await rpc.mcpImport({ servers: [{ name: 'x', config: { type: 'stdio', command: 'true' } }], scope: 'project' });
    expect(imp.ok).toBe(false);
    expect(imp.error).toMatch(/no active workspace/i);
  });

  it('mcpWriteRaw replaces the whole user config (advanced editor semantics)', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    const res = await rpc.mcpWriteRaw({ config: { only: { type: 'stdio', command: 'true' } }, scope: 'user' });
    expect(res.ok).toBe(true);
    const raw = await rpc.mcpReadRaw({ scope: 'user' });
    expect(Object.keys(raw.config ?? {})).toEqual(['only']);
  });
});

describe('registerMcpRpc pool status', () => {
  it('mcpList shapes rows: needs_credentials fast path, tools empty, enabled true', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    await rpc.mcpAdd({ name: 'needs-cred', config: secretServer('never-set-xyz'), scope: 'user' });
    const row = await vi.waitFor(async () => {
      const found = (await rpc.mcpList({})).find((s) => s.name === 'needs-cred');
      expect(found).toBeDefined();
      return found!;
    }, 3000);
    expect(row).toMatchObject({
      name: 'needs-cred',
      scope: 'user',
      status: 'needs_credentials',
      transport: 'stdio',
      toolCount: 0,
      toolNames: [],
      enabled: true,
    });
    expect(row.error).toMatch(/missing secrets/i);
    await rpc.mcpRemove({ name: 'needs-cred', scope: 'user' });
  });

  it('mcpSetEnabled(false) keeps the row greyed out; (true) reconnects it', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    await rpc.mcpAdd({ name: 'toggle', config: secretServer('toggle-tok'), scope: 'user' });
    await vi.waitFor(async () => {
      expect((await rpc.mcpList({})).find((s) => s.name === 'toggle')).toBeDefined();
    }, 3000);

    expect((await rpc.mcpSetEnabled({ name: 'toggle', enabled: false, scope: 'user' })).ok).toBe(true);
    let row = (await rpc.mcpList({})).find((s) => s.name === 'toggle');
    expect(row).toMatchObject({ status: 'disconnected', enabled: false });

    expect((await rpc.mcpSetEnabled({ name: 'toggle', enabled: true, scope: 'user' })).ok).toBe(true);
    row = await vi.waitFor(async () => {
      const found = (await rpc.mcpList({})).find((s) => s.name === 'toggle');
      expect(found?.status).toBe('needs_credentials');
      return found!;
    }, 3000);
    expect(row.enabled).toBe(true);
    await rpc.mcpRemove({ name: 'toggle', scope: 'user' });
  });

  it('mcpWorkspaceActivated loads project-scoped servers into the workspace pool', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rpc-mcp-ws-'));
    try {
      fs.writeFileSync(
        path.join(wsRoot, '.mcp.json'),
        JSON.stringify({ 'proj-server': secretServer('proj-tok') }),
      );
      expect((await rpc.mcpWorkspaceActivated({ workspaceId: 'ws-1', workspaceRoot: wsRoot })).ok).toBe(true);
      const row = await vi.waitFor(async () => {
        const found = (await rpc.mcpList({ workspaceId: 'ws-1' })).find((s) => s.name === 'proj-server');
        expect(found).toBeDefined();
        return found!;
      }, 3000);
      expect(row).toMatchObject({ scope: 'project', status: 'needs_credentials' });
      // Project rows stay out of the workspace-less list.
      expect((await rpc.mcpList({})).find((s) => s.name === 'proj-server')).toBeUndefined();
    } finally {
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});

describe('registerMcpRpc status push', () => {
  it('forwards pool mutations as mcpEvents {kind:"statusChanged"} through the current send slot', async () => {
    const events: McpEvent[] = [];
    const rpc = registerMcpRpc({ event: (msg) => events.push(msg) });

    await rpc.mcpAdd({ name: 'push-me', config: secretServer('push-tok'), scope: 'user' });
    await vi.waitFor(async () => {
      expect(events.length).toBeGreaterThan(0);
    }, 3000);
    expect(events[0]).toEqual({ kind: 'statusChanged' });

    // Re-registration swaps the emit slot — the previous consumer goes quiet
    // (single listener, no stacking across repeated registrations).
    const stale = events.length;
    const rpc2 = registerMcpRpc({ event: () => {} });
    await rpc2.mcpRemove({ name: 'push-me', scope: 'user' });
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(stale);
  });

  it('mcpReinitialize answers ok and re-reads config', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    expect((await rpc.mcpReinitialize({})).ok).toBe(true);
  });
});

describe('registerMcpRpc import + scan + secrets', () => {
  it('mcpImport writes all servers and reports the count', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    const res = await rpc.mcpImport({
      servers: [
        { name: 'imp-a', config: secretServer('imp-a-tok') },
        { name: 'imp-b', config: { type: 'stdio', command: 'true' } },
      ],
      scope: 'user',
    });
    expect(res).toEqual({ ok: true, imported: 2 });
    const raw = await rpc.mcpReadRaw({ scope: 'user' });
    expect(raw.config).toMatchObject({ 'imp-a': { command: 'echo' }, 'imp-b': { command: 'true' } });
    await rpc.mcpRemove({ name: 'imp-a', scope: 'user' });
    await rpc.mcpRemove({ name: 'imp-b', scope: 'user' });
  });

  it('mcpScan reports alreadyImported from the user config file; the detected set is machine-dependent', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    // The scanner diffs against the mcp.json file (its alreadyImported
    // source), not the config-store migration target.
    fs.writeFileSync(
      path.join(state.dir, 'mcp.json'),
      JSON.stringify({ 'scan-me': { type: 'stdio', command: 'true' } }),
    );
    const result = await rpc.mcpScan({});
    expect(Array.isArray(result.servers)).toBe(true);
    expect(result.alreadyImported).toContain('scan-me');
    fs.rmSync(path.join(state.dir, 'mcp.json'));
  });

  it('secret round-trip: set → has → clear', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    expect((await rpc.mcpSetSecret({ name: 'rt', value: 'hunter2' })).ok).toBe(true);
    expect((await rpc.mcpHasSecret({ name: 'rt' })).has).toBe(true);
    expect((await rpc.mcpClearSecret({ name: 'rt' })).ok).toBe(true);
    expect((await rpc.mcpHasSecret({ name: 'rt' })).has).toBe(false);
  });

  it('mcpApprove stays a benign no-op (approval gate removed)', async () => {
    const rpc = registerMcpRpc({ event: () => {} });
    expect(await rpc.mcpApprove({ name: 'anything' })).toEqual({ ok: true });
  });
});
