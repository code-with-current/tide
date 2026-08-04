/**
 * macOS system-permission management — thin wrapper over the optional native
 * module `node-mac-permissions`.
 *
 * The app requests three permissions that meaningfully help a coding agent:
 *   - Accessibility         (global shortcuts / automation)
 *   - Full Disk Access      (reading project files anywhere on disk)
 *   - Protected Folders     (Desktop / Documents / Downloads — the folders
 *                            macOS sandboxes even from Full Disk Access)
 *
 * None of these can be programmatically GRANTED — the OS only lets an app
 * open System Settings to the relevant pane; the user toggles manually. So
 * "request" here means "navigate to the pane"; the consent screen re-checks
 * status when the user returns (focus listener).
 *
 * Safety: `node-mac-permissions` has no Windows/Linux bindings, so it's an
 * optionalDependency. We load it with the `node-pty` pattern (createRequire +
 * try/catch) gated by `process.platform === 'darwin'`. On non-mac platforms
 * (or if the native binding fails to load) every function returns a safe
 * default that makes the consent screen a no-op — it won't show, and nothing
 * crashes.
 *
 * NOTE on the stderr noise: the native module logs a harmless
 * "Incorrect NSStringEncoding value 0x8000100 detected" warning on some
 * macOS versions. That's a library/OS interop quirk, not our bug — safe to
 * ignore.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let macPerms: any = null;
const isMac = process.platform === 'darwin';
if (isMac) {
  try {
    macPerms = require('node-mac-permissions');
  } catch {
    macPerms = null; // optionalDep missing — degrade gracefully
  }
}

/** The three permissions the app cares about. Folders are grouped because
 *  they share an API (askForFoldersAccess) and a consent UX (one "grant"
 *  row covers Desktop/Documents/Downloads). */
export type PermissionType = 'accessibility' | 'fullDiskAccess' | 'folders';

/** getAuthStatus return strings (folders have no status check — see below). */
export type AuthState = 'authorized' | 'denied' | 'restricted' | 'not determined';

export interface PermissionStatus {
  platform: 'mac' | 'other';
  /** null when the native module isn't loadable — consent screen treats
   *  null as "no check possible, don't block". */
  accessibility: AuthState | null;
  fullDiskAccess: AuthState | null;
  /** Folders can only be REQUESTED (askForFoldersAccess), not status-checked
   *  — getAuthStatus has no folder type. So the consent screen can't show a
   *  live authorized/denied badge for them; it offers a "grant" button only. */
  folders: 'unknown' | null;
}

/**
 * Read the current authorization status. On non-mac, or if the native module
 * failed to load, returns a status whose platform field is 'other' — the
 * consent screen uses that to short-circuit (don't show). Synchronous native
 * call; cheap to run on the routing path.
 */
export function getPermissionStatus(): PermissionStatus {
  if (!isMac || !macPerms) {
    return {
      platform: 'other',
      accessibility: null,
      fullDiskAccess: null,
      folders: null,
    };
  }
  try {
    const accessibility = macPerms.getAuthStatus('accessibility') as AuthState;
    const fullDiskAccess = macPerms.getAuthStatus('full-disk-access') as AuthState;
    return { platform: 'mac', accessibility, fullDiskAccess, folders: 'unknown' };
  } catch {
    // A native call failing shouldn't block app startup — treat as unknown.
    return { platform: 'mac', accessibility: null, fullDiskAccess: null, folders: 'unknown' };
  }
}

/**
 * True iff the consent screen should show. Returns false on non-mac, when
 * the native module isn't loadable, or when the checkable permissions are
 * already authorized. Folders can't be checked, so they alone never trigger
 * the screen (we surface them only once the screen is already showing for
 * accessibility/full-disk). This keeps the screen from nagging a fully-set-up
 * user on every launch.
 */
export function shouldShowConsent(): boolean {
  if (!isMac || !macPerms) return false;
  const s = getPermissionStatus();
  if (s.platform !== 'mac') return false;
  return s.accessibility !== 'authorized' || s.fullDiskAccess !== 'authorized';
}

/**
 * Open System Settings to the relevant pane for the given permission. The OS
 * does NOT grant on call — the user toggles manually. Folders open the
 * Files-and-Folders pane for each of desktop/documents/downloads in turn
 * (one combined row in the consent UI maps to three prompts).
 *
 * Returns 'opened' on success, 'unavailable' on non-mac/missing module.
 * Errors are swallowed (best-effort navigation; the pane may differ by OS
 * version) but logged.
 */
export async function requestPermission(type: PermissionType): Promise<'opened' | 'unavailable'> {
  if (!isMac || !macPerms) return 'unavailable';
  try {
    switch (type) {
      case 'accessibility':
        // askForAccessibilityAccess opens System Settings to the Accessibility
        // pane (synchronous — returns void).
        macPerms.askForAccessibilityAccess();
        return 'opened';
      case 'fullDiskAccess':
        macPerms.askForFullDiskAccess();
        return 'opened';
      case 'folders':
        // askForFoldersAccess returns a Promise<'authorized'|'denied'> and
        // opens the Files and Folders pane. We don't await the grant — the
        // user toggles three folders; the consent screen re-checks on focus.
        // Fire one prompt per protected folder so all three panes are reachable.
        for (const folder of ['desktop', 'documents', 'downloads'] as const) {
          macPerms.askForFoldersAccess(folder).catch(() => {});
        }
        return 'opened';
      default:
        return 'unavailable';
    }
  } catch {
    // Best-effort — a Settings-pane navigation failure shouldn't surface as
    // a hard error to the renderer. The user can still open Settings manually.
    return 'unavailable';
  }
}
