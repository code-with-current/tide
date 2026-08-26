/** Pure settings storage for `<userData>/settings.json` (no Electron imports, fully testable). Kept separate from config.json so a settings reset never touches credentials; holds non-secret UI prefs (shortcuts today). Platform-aware shortcut defaults (macOS ⌘ / Win+Linux Ctrl). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('settings');

/** One shortcut binding: action id → display tokens (e.g. ['⌘', 'K']). */
export type ShortcutOverrides = Record<string, string[]>;

/** Shape of settings.json. Grows over time — every field is optional so
 *  older files (and fresh installs) merge cleanly with defaults. */
export interface SettingsFile {
  /** Per-action shortcut overrides on top of the platform defaults. Absent
   *  entry → use the default for that action. Empty object = "use defaults". */
  shortcuts?: ShortcutOverrides;
}

/** macOS uses ⌘ (Cmd); Windows/Linux use Ctrl. The defaults below are the
 *  canonical bindings from src/lib/shortcuts.ts with the platform token
 *  substituted. Keep this list in sync with SHORTCUTS — both are sources of
 *  truth (this for the persisted file, that for the renderer catalog). */
function defaultShortcutsForPlatform(platform: NodeJS.Platform): ShortcutOverrides {
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl';
  return {
    commandPalette: [mod, 'K'],
    newSession: [mod, 'N'],
    openSettings: [mod, ','],
    closeWindow: [mod, 'W'],
    toggleWorkspaces: [mod, '1'],
    toggleSessions: [mod, '2'],
    toggleRightPanel: [mod, '3'],
    toggleTerminal: ['T'],
    toggleRightPanelBare: ['R'],
    sendMessage: ['↵'],
    newLine: ['⇧', '↵'],
    abortTurn: [mod, '.'],
    dismissPrompt: ['Esc'],
    editLastMessage: [mod, '↑'],
    nextSession: ['J'],
    prevSession: ['K'],
    renameSession: [mod, 'E'],
    deleteSession: [mod, '⌫'],
    approvePermission: ['Y'],
    rejectPermission: ['N'],
    copyDiff: [mod, '⇧', 'C'],
    branchFromWorktree: [mod, 'B'],
  };
}

/** The platform the store was initialized with. Set in createSettingsStore
 *  so defaults match the host OS (resolved once at startup, not per read). */
let platformCache: ShortcutOverrides | null = null;

export function createSettingsStore(rootDir: string, platform: NodeJS.Platform) {
  const settingsPath = path.join(rootDir, 'settings.json');
  platformCache = defaultShortcutsForPlatform(platform);
  let cache: SettingsFile | null = null;

  function read(): SettingsFile {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as SettingsFile;
      // Shallow-merge with empty defaults so missing fields don't crash callers.
      cache = { shortcuts: parsed.shortcuts ?? {} };
    } catch {
      cache = { shortcuts: {} };
    }
    return cache;
  }

  function write(s: SettingsFile): void {
    cache = s;
    try {
      fs.mkdirSync(rootDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf-8');
    } catch (err) {
      // Persisting settings is best-effort: a write failure (read-only home,
      // full disk) shouldn't crash the app. The in-memory cache still holds
      // the change, so the current session behaves correctly; it just won't
      // survive restart. Logged for diagnosis.
      log.warn('failed to write settings.json', { err });
    }
  }

  return {
    /** All shortcut overrides, merged over platform defaults. Absent actions
     *  in the file fall through to defaults at the consumer (getEffectiveKeys),
     *  so we return overrides only — not the merged set. */
    getShortcuts(): ShortcutOverrides {
      return read().shortcuts ?? {};
    },
    /** Replace ALL overrides. Pass {} to reset to defaults. */
    setShortcuts(overrides: ShortcutOverrides): void {
      write({ shortcuts: overrides });
    },
    /** Set or clear (null/[]) a single action's override. */
    setShortcut(id: string, keys: string[] | null): void {
      const next = { ...(read().shortcuts ?? {}) };
      if (!keys || keys.length === 0) delete next[id];
      else next[id] = keys;
      write({ shortcuts: next });
    },
    /** The platform-default bindings (for "Reset all" + initial render). */
    defaults(): ShortcutOverrides {
      return platformCache ?? defaultShortcutsForPlatform(platform);
    },
    /** Path on disk (for diagnostics / "reveal settings file"). */
    path(): string {
      return settingsPath;
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
