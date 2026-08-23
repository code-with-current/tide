/** App badge — counts completed-turn notifications while the window is
 *  unfocused (macOS dock badge; `app.setBadgeCount` is a no-op elsewhere).
 *  Cleared whenever the main window gains focus. */

import { app } from 'electron';
import { createLogger } from './logger.js';

const log = createLogger('badge');

let count = 0;

function apply(): void {
  try {
    app.setBadgeCount(count);
  } catch {
    // Not supported on this platform / launcher — badge is best-effort.
  }
}

export function incrementBadge(): void {
  count += 1;
  apply();
  log.info('badge count', { count });
}

export function clearBadge(): void {
  if (count === 0) return;
  count = 0;
  apply();
  log.info('badge cleared');
}
