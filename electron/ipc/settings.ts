/**
 * Settings IPC — read/write `settings.json` (shortcut bindings today, future
 * UI preferences as the file grows). Mirrors the agentSettings pattern: a
 * get-all + a patch.
 *
 * Three handlers:
 *   tide:settings:get      → { overrides, defaults } — defaults are the
 *                            platform-aware set so the renderer renders Ctrl
 *                            on Windows/Linux without detecting the OS itself.
 *   tide:settings:setShortcut(id, keys | null)  → set / clear one binding
 *   tide:settings:resetShortcuts               → clear all overrides
 *
 * The store is created at module init via the userData path resolved in
 * main.ts (post-relocation: ~/.tide / ~/.tide-dev).
 */
import { ipcMain, app } from 'electron';
import { createSettingsStore, type ShortcutOverrides } from '../settingsStore.js';
import { createLogger } from '../logger.js';
import { appDataDir } from '../appPaths.js';

const log = createLogger('settings');

// Singleton — created on first import (after app.whenReady, since this module
// is imported lazily from main.ts inside the whenReady callback). The path
// comes from appDataDir(), which the userData-relocation step has
// already redirected to ~/.tide (or ~/.tide-dev) by this point.
const store = createSettingsStore(appDataDir(), process.platform);

export function registerSettingsHandlers(): void {
  ipcMain.handle('tide:settings:get', () => ({
    overrides: store.getShortcuts(),
    defaults: store.defaults(),
  }));

  ipcMain.handle(
    'tide:settings:setShortcut',
    (_e: unknown, id: string, keys: string[] | null) => {
      log.info('shortcut changed', { id, keys });
      store.setShortcut(id, keys);
      return store.getShortcuts();
    },
  );

  ipcMain.handle('tide:settings:resetShortcuts', () => {
    log.info('shortcuts reset to defaults');
    store.setShortcuts({} as ShortcutOverrides);
    return store.getShortcuts();
  });
}
