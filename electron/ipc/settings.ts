/** Settings IPC for settings.json (shortcuts today): tide:settings:get returns {overrides, platform-aware defaults}, tide:settings:setShortcut sets/clears one binding, tide:settings:resetShortcuts clears all overrides. Store created at init from appDataDir(). */
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
