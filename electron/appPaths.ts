/** Platform-specific application data directory: user data lives under ~/.tide (or ~/.tide-dev in dev), while Chromium's disposable cache stays in Electron's default userData location. */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/** Base directory name. Dev builds append `-dev` to keep the two disjoint. */
const BASE_DIR_NAME = '.tide';

/** Full Tide app data path (~/.tide or ~/.tide-dev in dev) where config, sessions, rag, and models live. */
export function appDataDir(): string {
  const isDev = !app.isPackaged;
  const base = path.join(os.homedir(), BASE_DIR_NAME);
  return isDev ? `${base}-dev` : base;
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

/** Initialize the Tide app data directory once at startup (before any IPC handler registers); does not override Chromium's default userData path. */
export function setUserDataPath(_isDev: boolean): void {
  const dir = appDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-fatal */ }
}
