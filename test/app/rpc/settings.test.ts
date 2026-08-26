import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// appDataDir feeds registerSettingsRpc's store root; steer it at a temp dir so
// the suite never touches the real ~/.tide-dev.
const pathsState = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../app/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/platform/paths')>();
  return { ...actual, appDataDir: () => pathsState.dir };
});

import { registerSettingsRpc } from '../../../app/rpc/settings';

beforeEach(() => {
  pathsState.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rpc-settings-'));
});

afterEach(() => {
  fs.rmSync(pathsState.dir, { recursive: true, force: true });
});

describe('registerSettingsRpc handlers', () => {
  it('settingsGet returns empty overrides and non-empty platform defaults', () => {
    const rpc = registerSettingsRpc();
    const res = rpc.settingsGet();
    expect(res.overrides).toEqual({});
    expect(Object.keys(res.defaults).length).toBeGreaterThan(0);
    expect(res.defaults.commandPalette).toBeDefined();
  });

  it('settingsSetShortcut round-trips into overrides and persists to disk', () => {
    const rpc = registerSettingsRpc();
    const res = rpc.settingsSetShortcut({ id: 'test.id', keys: ['Mod', 'K'] });
    expect(res.overrides['test.id']).toEqual(['Mod', 'K']);

    // A fresh registration (new store instance) must read the same override
    // back from settings.json — proves persistence, not just the memory cache.
    const reopened = registerSettingsRpc();
    expect(reopened.settingsGet().overrides['test.id']).toEqual(['Mod', 'K']);
  });

  it('settingsSetShortcut with keys: null clears a single binding', () => {
    const rpc = registerSettingsRpc();
    rpc.settingsSetShortcut({ id: 'test.id', keys: ['Mod', 'K'] });
    const res = rpc.settingsSetShortcut({ id: 'test.id', keys: null });
    expect(res.overrides['test.id']).toBeUndefined();
    expect(res.overrides).toEqual({});
  });

  it('settingsResetShortcuts clears all overrides', () => {
    const rpc = registerSettingsRpc();
    rpc.settingsSetShortcut({ id: 'a', keys: ['X'] });
    rpc.settingsSetShortcut({ id: 'b', keys: ['Y'] });
    const res = rpc.settingsResetShortcuts();
    expect(res.overrides).toEqual({});
    expect(registerSettingsRpc().settingsGet().overrides).toEqual({});
  });
});
