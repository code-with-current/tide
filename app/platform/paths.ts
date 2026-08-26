/** Tide's application data directory: ~/.tide packaged, ~/.tide-dev in dev — identical to the paths the Electron app used, so existing sessions/config/RAG carry over untouched. */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { isDevBuild } from './env';

/** Base directory name. Dev builds append `-dev` to keep the two disjoint. */
const BASE_DIR_NAME = '.tide';

/** Full Tide app data path. TIDE_DATA_DIR wins outright — packaged-channel
 * test isolation: updater-scenario canary/stable envelopes count as packaged
 * and would otherwise open the real ~/.tide. Otherwise ~/.tide, or ~/.tide-dev
 * in dev. */
export function appDataDir(): string {
  const override = process.env['TIDE_DATA_DIR'];
  if (override) return override;
  const base = path.join(os.homedir(), BASE_DIR_NAME);
  return isDevBuild() ? `${base}-dev` : base;
}

/**
 * Compute the platform base path for Tide's data directory.
 * Kept for back-compat — prefer appDataDir().
 */
export function platformBaseDir(): string {
  return path.join(os.homedir(), BASE_DIR_NAME);
}

/**
 * The full `userData` path Tide should use, including the dev suffix when
 * running unpackaged. Kept for back-compat — prefer appDataDir().
 */
export function userDataPath(isDev: boolean): string {
  const base = platformBaseDir();
  return isDev ? `${base}-dev` : base;
}

/** Create the Tide app data directory once at startup (before any RPC handler registers), enforcing 0700. */
export function ensureAppDataDir(): void {
  const dir = appDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-fatal */ }
}
