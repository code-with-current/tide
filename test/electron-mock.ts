/**
 * Lightweight electron mock for vitest.
 *
 * The real `electron` npm package calls `getElectronPath()` at import time,
 * which checks for a downloaded binary — and pnpm v10 skips that download
 * in CI (unapproved build script).  Any test that transitively imports a
 * module with `import { app } from 'electron'` would crash on load.
 *
 * Aliased via vitest.config.ts `resolve.alias` so every `from 'electron'`
 * resolves here instead.
 */
import { vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = path.join(os.tmpdir(), 'tide-vitest');

export const app = {
  getPath: vi.fn((name?: string) => {
    const map: Record<string, string> = {
      userData: path.join(tmp, 'userData'),
      appData: path.join(tmp, 'appData'),
      home: os.homedir(),
      temp: os.tmpdir(),
      documents: path.join(tmp, 'documents'),
      logs: path.join(tmp, 'logs'),
    };
    return map[name ?? 'userData'] ?? tmp;
  }),
  getName: vi.fn(() => 'Tide'),
  getVersion: vi.fn(() => '0.0.0-test'),
  isReady: vi.fn(() => true),
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
  getAppPath: vi.fn(() => process.cwd()),
  isPackaged: false,
};

export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => false),
  encryptString: vi.fn((s: string) => Buffer.from(s)),
  decryptString: vi.fn((b: Buffer) => b.toString()),
};

export const BrowserWindow = Object.assign(
  vi.fn(() => ({
    webContents: { send: vi.fn(), id: 0 },
    loadURL: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
  })),
  // Static used by IPC broadcast loops (tide:sources:progress etc.) and main.ts.
  { getAllWindows: vi.fn((): Array<{ webContents: { send: ReturnType<typeof vi.fn> } }> => []) },
);

export const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
};

export const ipcRenderer = {
  invoke: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  send: vi.fn(),
  removeAllListeners: vi.fn(),
};

export const contextBridge = {
  exposeInMainWorld: vi.fn(),
};

export const dialog = {
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showMessageBox: vi.fn(),
  showErrorBox: vi.fn(),
};

export const shell = {
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  trashItem: vi.fn(),
};

export const protocol = {
  handle: vi.fn(),
  registerFileProtocol: vi.fn(),
  unregisterProtocol: vi.fn(),
};

export const Notification = vi.fn(() => ({
  show: vi.fn(),
  on: vi.fn(),
  close: vi.fn(),
}));

export const utilityProcess = {
  fork: vi.fn(() => ({ pid: 0, on: vi.fn(), kill: vi.fn(), postMessage: vi.fn() })),
};
