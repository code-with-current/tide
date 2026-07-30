/**
 * Platform-specific application data directory.
 *
 * Tide stores all of its user data — config, sessions, the per-workspace RAG
 * indexes, the downloaded ONNX embedder model, and user slash commands — under
 * a single directory derived from here via `app.getPath('userData')`. The
 * default location used to be Electron's stock `userData` (which is keyed off
 * `package.json#name` and lands deep inside the OS's app-support tree); this
 * module moves it to a short, predictable path that lives directly under the
 * user's home directory on every platform:
 *
 *   macOS / Linux:  ~/.tide        (dev: ~/.tide-dev)
 *   Windows:        %USERPROFILE%\.tide   (dev: %USERPROFILE%\.tide-dev)
 *
 * Dev builds use the `-dev` suffix so experiments never pollute real
 * production data — you can wipe the dev dir without touching your actual
 * sessions, and a packaged release never reads dev state.
 *
 * The location is set once at startup via `app.setPath('userData', ...)` in
 * main.ts (before any consumer reads `getPath('userData')`), so every module
 * that calls `app.getPath('userData')` picks up the new path for free.
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/** Base directory name. Dev builds append `-dev` to keep the two disjoint. */
const BASE_DIR_NAME = '.tide';

/**
 * Compute the platform base path for Tide's data directory. The returned path
 * does NOT include the dev suffix — callers add that via {@link userDataPath}.
 *
 * Windows resolves under `%USERPROFILE%` (i.e. `os.homedir()`), matching the
 * macOS/Linux `~` convention, rather than the per-user app-data tree. This is
 * intentional: the path is meant to be short and easy to type/share across
 * platforms.
 */
export function platformBaseDir(): string {
  return path.join(os.homedir(), BASE_DIR_NAME);
}

/**
 * The full `userData` path Tide should use, including the dev suffix when
 * running unpackaged.
 *
 * @param isDev `true` for unpackaged/dev builds → appends `-dev`.
 */
export function userDataPath(isDev: boolean): string {
  const base = platformBaseDir();
  return isDev ? `${base}-dev` : base;
}

/**
 * Set the app's userData directory to ~/.tide (~/.tide-dev in dev). Call once
 * at startup BEFORE any IPC handler registers — handlers create config/session
 * stores that read getPath('userData') at registration time.
 *
 * Fresh start — no migration from any previous location. The directory is
 * created if it doesn't exist.
 */
export function setUserDataPath(isDev: boolean): void {
  const newPath = userDataPath(isDev);
  app.setPath('userData', newPath);
  fs.mkdirSync(newPath, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(newPath, 0o700); } catch { /* non-fatal */ }
}
