import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const pathsState = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../app/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/platform/paths')>();
  return { ...actual, appDataDir: () => pathsState.dir };
});

import { registerMiscRpc, mimeFromPath, type MiscSettingsDomain } from '../../../app/rpc/misc';
import type { AgentSettings, GeneralSettings } from '../../../app/core/configStore';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-misc-rpc-'));
  pathsState.dir = path.join(root, 'appdata');
});

function fakeDomain(): MiscSettingsDomain & {
  state: { agent: AgentSettings; general: GeneralSettings; agentPatches: unknown[]; generalPatches: unknown[] };
} {
  const state = {
    agent: {
      defaultAutonomy: 'ask',
      maxSteps: 100,
      permissionTimeoutMin: 10,
      planModeDryRun: true,
      auditShellCommands: true,
      compactionEnabled: true,
      compactionThreshold: 0.75,
      compactionKeepTurns: 3,
      experimentalBackgroundDispatch: false,
    } as AgentSettings,
    general: {
      startAtLogin: false,
      notifications: true,
      notificationSound: true,
      gitCoAuthored: true,
      gitCoAuthorName: 'Tide',
      gitCoAuthorEmail: 't@t.t',
      autoUpdateCheck: true,
    } as GeneralSettings,
    agentPatches: [] as unknown[],
    generalPatches: [] as unknown[],
  };
  return {
    state,
    getAgentSettings: () => state.agent,
    updateAgentSettings: (patch) => { state.agentPatches.push(patch); Object.assign(state.agent, patch); },
    getGeneralSettings: () => state.general,
    updateGeneralSettings: (patch) => { state.generalPatches.push(patch); Object.assign(state.general, patch); },
    listWorkspaces: () => [],
  };
}

describe('misc rpc', () => {
  it('mimeFromPath maps image extensions', () => {
    expect(mimeFromPath('a/b/photo.PNG')).toBe('image/png');
    expect(mimeFromPath('x.jpeg')).toBe('image/jpeg');
    expect(mimeFromPath('icon.svg')).toBe('image/svg+xml');
    expect(mimeFromPath('data.bin')).toBeNull();
    expect(mimeFromPath('noext')).toBeNull();
  });

  it('agent/general settings pass through the domain', async () => {
    const domain = fakeDomain();
    const h = registerMiscRpc(domain, { dataDir: pathsState.dir });
    expect(h.settingsGetAgent({}).maxSteps).toBe(100);
    const updated = h.settingsUpdateAgent({ patch: { maxSteps: 42 } });
    expect(updated.maxSteps).toBe(42);
    expect(domain.state.agentPatches).toEqual([{ maxSteps: 42 }]);

    expect(h.settingsGetGeneral({}).notificationSound).toBe(true);
    h.settingsUpdateGeneral({ patch: { notificationSound: false } });
    expect(domain.state.general.notificationSound).toBe(false);
  });

  it('clipboardFileSave persists base64 bytes under appData/attachments', () => {
    const domain = fakeDomain();
    const h = registerMiscRpc(domain, { dataDir: pathsState.dir });
    const res = h.clipboardFileSave({ name: 'shot.png', dataBase64: Buffer.from('abc').toString('base64') });
    expect(res.path).toContain('attachments');
    expect(res.path).toMatch(/shot\.png$/);
    expect(fs.existsSync(res.path)).toBe(true);
    expect(fs.readFileSync(res.path, 'utf8')).toBe('abc');
  });

  it('externalFileRead truncates over the 256KB cap', () => {
    const domain = fakeDomain();
    const h = registerMiscRpc(domain, { dataDir: pathsState.dir });
    const big = path.join(root, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(300 * 1024));
    const res = h.externalFileRead({ filePath: big });
    expect(res?.bytes).toBe(300 * 1024);
    expect(res?.truncated).toBe(true);
    expect(res?.content.length).toBe(256 * 1024);
    expect(h.externalFileRead({ filePath: path.join(root, 'missing') })).toBeNull();
  });

  it('envInfoGet reports the host shell', () => {
    const h = registerMiscRpc(fakeDomain(), { dataDir: pathsState.dir });
    const env = h.envInfoGet({});
    expect(env.platform).toBe(process.platform);
    expect(env.shell).toBeTruthy();
  });

  it('diagnosticsGet reports the bun runtime + data dir', async () => {
    const h = registerMiscRpc(fakeDomain(), { dataDir: pathsState.dir, appVersion: () => '9.9.9' });
    const diag = await h.diagnosticsGet({});
    expect(diag).toMatchObject({ appVersion: '9.9.9', runtime: 'bun', userDataPath: pathsState.dir });
    expect(diag.runtimeVersion).toBeTruthy();
  });


  it('window controls route to the live window handle', () => {
    const calls: string[] = [];
    const h = registerMiscRpc(fakeDomain(), {
      dataDir: pathsState.dir,
      getWindow: () => ({
        isFullScreen: () => false,
        minimize: () => calls.push('min'),
        maximize: () => calls.push('max'),
        unmaximize: () => calls.push('unmax'),
        isMaximized: () => false,
        close: () => calls.push('close'),
      }),
    });
    expect(h.windowMinimize({})).toEqual({});
    expect(h.windowToggleMaximize({})).toEqual({ maximized: true });
    expect(h.windowClose({})).toEqual({});
    expect(calls).toEqual(['min', 'max', 'close']);
  });

  it('windowToggleMaximize restores when already maximized', () => {
    const calls: string[] = [];
    const h = registerMiscRpc(fakeDomain(), {
      dataDir: pathsState.dir,
      getWindow: () => ({
        isFullScreen: () => false,
        maximize: () => calls.push('max'),
        unmaximize: () => calls.push('unmax'),
        isMaximized: () => true,
      }),
    });
    expect(h.windowToggleMaximize({})).toEqual({ maximized: false });
    expect(calls).toEqual(['unmax']);
  });

  it('window controls no-op without a window handle', () => {
    const h = registerMiscRpc(fakeDomain(), { dataDir: pathsState.dir });
    expect(h.windowMinimize({})).toEqual({});
    expect(h.windowToggleMaximize({})).toEqual({ maximized: false });
    expect(h.windowClose({})).toEqual({});
  });

  it('windowIsFullScreen reads the live window handle', () => {
    const h = registerMiscRpc(fakeDomain(), {
      dataDir: pathsState.dir,
      getWindow: () => ({ isFullScreen: () => true }),
    });
    expect(h.windowIsFullScreen({})).toEqual({ fullscreen: true });
  });

  it('todosList reads the session todos', () => {
    const h = registerMiscRpc(fakeDomain(), { dataDir: pathsState.dir });
    expect(h.todosList({ sessionId: 'never-seen' })).toEqual({ todos: [] });
  });

  it('agentList filters hidden agents', () => {
    const h = registerMiscRpc(fakeDomain(), { dataDir: pathsState.dir });
    const agents = h.agentList({});
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((a) => a.name && a.description && a.whenToUse)).toBe(true);
  });
});
