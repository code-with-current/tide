/** Settings RPC for settings.json (shortcuts today): settingsGet returns {overrides, platform-aware defaults}, settingsSetShortcut sets/clears one binding, settingsResetShortcuts clears all overrides. Port of electron/ipc/settings.ts — the store is created here (not at module scope) so main.ts controls init order after ensureAppDataDir(). */
import { createLogger } from '../core/logger.js';
import { createSettingsStore, type ShortcutOverrides } from '../core/settingsStore.js';
import { appDataDir, ensureAppDataDir } from '../platform/paths';

const log = createLogger('settings');

export function registerSettingsRpc() {
  ensureAppDataDir();
  const store = createSettingsStore(appDataDir(), process.platform);
  return {
    settingsGet: () => ({ overrides: store.getShortcuts(), defaults: store.defaults() }),
    settingsSetShortcut: ({ id, keys }: { id: string; keys: string[] | null }) => {
      log.info('shortcut changed', { id, keys });
      store.setShortcut(id, keys);
      return { overrides: store.getShortcuts() };
    },
    settingsResetShortcuts: () => {
      log.info('shortcuts reset to defaults');
      store.setShortcuts({} as ShortcutOverrides);
      return { overrides: store.getShortcuts() };
    },
  };
}
