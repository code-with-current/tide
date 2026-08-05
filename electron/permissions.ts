/** macOS permission wrapper over the optional `node-mac-permissions` module: requests Accessibility, Full Disk Access, and protected-folders access (the OS only opens System Settings — the user toggles manually). On non-mac or missing bindings every function returns a safe no-op default. */
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

/** Read the current authorization status; on non-mac or missing module returns platform 'other' so the consent screen short-circuits. */
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

/** True iff the consent screen should show: false on non-mac/missing module or when accessibility + full-disk are already authorized (folders can't be checked, so they never trigger the screen alone). */
export function shouldShowConsent(): boolean {
  if (!isMac || !macPerms) return false;
  const s = getPermissionStatus();
  if (s.platform !== 'mac') return false;
  return s.accessibility !== 'authorized' || s.fullDiskAccess !== 'authorized';
}

/** Open System Settings to the relevant pane (the OS doesn't grant on call); folders open the Files-and-Folders pane for desktop/documents/downloads. Returns 'opened' on success or 'unavailable' on non-mac/missing module; errors swallowed. */
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
