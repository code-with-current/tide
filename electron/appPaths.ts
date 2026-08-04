/**
 * Platform-specific application data directory.
 *
 * Tide stores all of its user data — config, sessions, the per-workspace RAG
 * indexes, the downloaded ONNX embedder model, and user slash commands — under
 * a short, predictable path directly under the user's home directory:
 *
 *   macOS / Linux:  ~/.tide        (dev: ~/.tide-dev)
 *   Windows:        %USERPROFILE%\.tide   (dev: %USERPROFILE%\.tide-dev)
 *
 * Chromium's runtime data (cache, GPU cache, localStorage, etc.) stays in
 * Electron's default platform location:
 *   macOS:  ~/Library/Application Support/Tide/
 *   Linux:  ~/.config/Tide/
 *   Windows: %APPDATA%/Tide/
 *
 * This separation means:
 *   - ~/.tide/ contains ONLY user data (safe to back up, portable)
 *   - The Chromium dirs contain ONLY disposable cache (safe to delete)
 *
 * Tide modules use `appDataDir()` instead of `app.getPath('userData')` to
 * read/write app data. Chromium paths are untouched (default userData).
 *
 * Dev builds use the `-dev` suffix so experiments never pollute real
 * production data.
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/** Base directory name. Dev builds append `-dev` to keep the two disjoint. */
const BASE_DIR_NAME = '.tide';

/**
 * The full Tide app data path (~/.tide or ~/.tide-dev in dev).
 * This is where config.json, sessions/, rag/, models/, etc. live.
 */
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

/**
 * Initialize the Tide app data directory. Call once at startup BEFORE any
 * IPC handler registers. Creates the directory if it doesn't exist.
 *
 * Does NOT override app.setPath('userData') — Chromium keeps its default
 * platform location. Tide modules read from appDataDir() instead.
 */
export function setUserDataPath(_isDev: boolean): void {
  const dir = appDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-fatal */ }
}
