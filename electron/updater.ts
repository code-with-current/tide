/**
 * Auto-updater: wraps electron-updater (GitHub releases) and exposes its
 * lifecycle to the renderer via IPC + a push event channel.
 *
 * In dev (app.isPackaged === false) the module no-ops — electron-updater
 * requires app-update.yml which only electron-builder generates at package
 * time. On macOS, ad-hoc signed builds can't auto-install: ShipIt validates
 * the staged update against the running app's code signature, and an ad-hoc
 * signature pins the exact build, so no future build can ever pass. Those
 * builds surface updates as a manual-download state instead.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import electronUpdater from 'electron-updater';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { createLogger } from './logger.js';

const log = createLogger('updater');

const execFile = promisify(execFileCb);

const GITHUB_RELEASES_URL = 'https://github.com/code-with-current/tide/releases';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'manual'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  version?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  error?: string;
  lastCheckedAt?: number | null;
}

let current: UpdateStatus = {
  state: 'idle',
  currentVersion: app.getVersion(),
  lastCheckedAt: null,
};

let initialized = false;

function emit(patch: Partial<UpdateStatus>) {
  current = { ...current, ...patch };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:status', current);
  }
}

function extractReleaseNotes(info: UpdateInfo): string {
  if (!info.releaseNotes) return '';
  if (typeof info.releaseNotes === 'string') return info.releaseNotes;
  if (Array.isArray(info.releaseNotes)) {
    return info.releaseNotes
      .map((n) => (typeof n === 'string' ? n : (n as { note?: string }).note ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function releaseUrlFor(version: string): string {
  return `${GITHUB_RELEASES_URL}/tag/v${version}`;
}

let manualOnly = false;

async function detectAdHocMac(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const bundle = path.dirname(path.dirname(app.getPath('exe')));
    const { stdout, stderr } = await execFile('codesign', ['-dv', '--verbose=2', bundle]);
    return /Signature=adhoc/i.test(`${stdout}${stderr}`);
  } catch {
    return true;
  }
}

/**
 * Wire up event listeners + IPC handlers. Called once from main.ts after the
 * window is created. Safe to call in dev (no-ops silently).
 */
export function initUpdater() {
  if (initialized) return;
  initialized = true;

  // ── IPC handlers (registered in dev too so the UI doesn't crash) ──

  ipcMain.handle('tide:updater:check', async () => {
    if (!app.isPackaged) return { ok: false, error: 'Not available in dev mode' };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle('tide:updater:install', () => {
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle('tide:updater:status', () => current);

  if (!app.isPackaged) {
    log.info('skipped in dev mode (no app-update.yml)');
    return;
  }

  // Download automatically when an update is found; apply on quit.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Don't check asynchronously in the constructor — we control timing.
  autoUpdater.allowDowngrade = false;

  void detectAdHocMac().then((adhoc) => {
    manualOnly = adhoc;
    if (adhoc) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      log.info('ad-hoc mac build detected — manual download mode');
    }
  });

  autoUpdater.on('checking-for-update', () => {
    log.info('checking for updates');
    emit({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log.info('update available', { version: info.version });
    if (manualOnly) {
      emit({
        state: 'manual',
        version: info.version,
        releaseNotes: extractReleaseNotes(info),
        releaseUrl: releaseUrlFor(info.version),
        lastCheckedAt: Date.now(),
      });
      return;
    }
    emit({
      state: 'available',
      version: info.version,
      releaseNotes: extractReleaseNotes(info),
      releaseUrl: releaseUrlFor(info.version),
      percent: 0,
    });
  });

  autoUpdater.on('update-not-available', () => {
    log.info('up to date');
    emit({ state: 'not-available', lastCheckedAt: Date.now() });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    emit({
      state: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log.info('update downloaded', { version: info.version });
    emit({
      state: 'downloaded',
      version: info.version,
      releaseUrl: releaseUrlFor(info.version),
      percent: 100,
      lastCheckedAt: Date.now(),
    });
  });

  autoUpdater.on('error', (err: Error) => {
    log.error('updater error', { err: String(err) });
    emit({ state: 'error', error: err?.message ?? String(err), lastCheckedAt: Date.now() });
  });
}

/**
 * Auto-check for updates on startup. Called from main.ts (deferred block)
 * only when the user has auto-update-check enabled. Wrapped in try/catch so
 * a network failure never blocks startup.
 */
export async function autoCheckForUpdates() {
  if (!app.isPackaged || !initialized) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log.warn('auto-check failed', { err: String(e) });
  }
}
