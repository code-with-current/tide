import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { appDataDir, ensureAppDataDir, platformBaseDir, userDataPath } from '../../../app/platform/paths';

// os.homedir sits on a module namespace (non-configurable), so vi.spyOn can't
// redefine it — mock the whole module and steer it through this hoisted holder.
const osState = vi.hoisted(() => ({ home: '/tmp/tide-paths-home' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => osState.home };
});

afterEach(() => {
  osState.home = '/tmp/tide-paths-home';
  vi.unstubAllEnvs();
});

describe('appDataDir', () => {
  it('returns ~/.tide-dev in dev', () => {
    osState.home = '/tmp/tide-paths-home';
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'dev');
    expect(appDataDir()).toBe(path.join('/tmp/tide-paths-home', '.tide-dev'));
  });
  it('returns ~/.tide in packaged builds', () => {
    osState.home = '/tmp/tide-paths-home';
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'stable');
    expect(appDataDir()).toBe(path.join('/tmp/tide-paths-home', '.tide'));
  });
  it('canary counts as packaged — never touches ~/.tide-dev from a shipped build', () => {
    osState.home = '/tmp/tide-paths-home';
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'canary');
    expect(appDataDir()).toBe(path.join('/tmp/tide-paths-home', '.tide'));
  });
});

describe('TIDE_DATA_DIR override', () => {
  it('wins verbatim regardless of channel (packaged-channel test isolation)', () => {
    osState.home = '/tmp/tide-paths-home';
    for (const channel of ['stable', 'canary', 'dev']) {
      vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', channel);
      vi.stubEnv('TIDE_DATA_DIR', '/tmp/tide-scenario-data');
      expect(appDataDir()).toBe('/tmp/tide-scenario-data');
    }
  });
  it('unset behaves as before — no override', () => {
    osState.home = '/tmp/tide-paths-home';
    vi.stubEnv('TIDE_DATA_DIR', undefined);
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'stable');
    expect(appDataDir()).toBe(path.join('/tmp/tide-paths-home', '.tide'));
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'dev');
    expect(appDataDir()).toBe(path.join('/tmp/tide-paths-home', '.tide-dev'));
  });
});

describe('legacy helpers', () => {
  it('platformBaseDir and userDataPath match appPaths semantics', () => {
    osState.home = '/tmp/tide-paths-home';
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'canary');
    expect(platformBaseDir()).toBe(path.join('/tmp/tide-paths-home', '.tide'));
    expect(userDataPath(false)).toBe(path.join('/tmp/tide-paths-home', '.tide'));
    expect(userDataPath(true)).toBe(path.join('/tmp/tide-paths-home', '.tide-dev'));
  });
});

describe('ensureAppDataDir', () => {
  it('creates the dir with 0700', () => {
    osState.home = '/tmp/tide-paths-real';
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'stable');
    const dir = '/tmp/tide-paths-real/.tide';
    fs.rmSync('/tmp/tide-paths-real', { recursive: true, force: true });
    ensureAppDataDir();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.rmSync('/tmp/tide-paths-real', { recursive: true, force: true });
  });
  it('is idempotent on an existing dir', () => {
    osState.home = '/tmp/tide-paths-real';
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'stable');
    ensureAppDataDir();
    ensureAppDataDir();
    expect(fs.statSync('/tmp/tide-paths-real/.tide').mode & 0o777).toBe(0o700);
    fs.rmSync('/tmp/tide-paths-real', { recursive: true, force: true });
  });
});
