/** Open-in-app RPC — port of electron/ipc/openInApp.ts (tide:openInApp:detect
 *  / open). Detects external apps (Finder/Explorer, Terminal, VSCode, Zed)
 *  and opens a session's resolved folder in one. Electrobun substitution: the
 *  Electron version read OS icons via app.getFileIcon + sips; the devkit has
 *  no file-icon API, so iconDataUrl is always null and the renderer falls
 *  back to its lucide icons (a documented 4.x gap — the fallback path the
 *  Electron version already had for Linux). shell.openPath is replaced by
 *  Utils.openPath. */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { Utils } from 'electrobun/main';
import type { ExternalApp, ExternalAppTarget, ShellOpResult } from '../../shared/rpc';

// Detection result cached for the process lifetime — installing an editor
// mid-session requires a restart to surface (same trade-off as the Electron
// shell).
let detectedCache: ExternalApp[] | null = null;

/** True if a CLI binary is on PATH (which/where) OR — macOS only — the .app
 *  bundle exists. */
function isEditorAvailable(cli: string, macBundle?: string): boolean {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cli], { stdio: 'ignore' })
    : spawnSync('which', [cli], { stdio: 'ignore' });
  if (probe.status === 0) return true;
  if (process.platform === 'darwin' && macBundle) {
    try {
      return fs.existsSync(`/Applications/${macBundle}`);
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** The OS-appropriate display name for the built-in file manager. The target
 *  id stays 'finder' (a stable cross-platform identifier persisted in the
 *  renderer), but the label matches the OS. */
function fileManagerLabel(): string {
  if (process.platform === 'win32') return 'File Explorer';
  if (process.platform === 'darwin') return 'Finder';
  return 'Files';
}

/** Detect available apps. Icons are not extractable without a devkit
 *  file-icon API — always null (renderer falls back to lucide icons). */
function detectApps(): ExternalApp[] {
  if (detectedCache) return detectedCache;
  detectedCache = [
    { id: 'finder', label: fileManagerLabel(), available: true, iconDataUrl: null },
    { id: 'terminal', label: 'Terminal', available: true, iconDataUrl: null },
    {
      id: 'vscode',
      label: 'VSCode',
      available: isEditorAvailable('code', 'Visual Studio Code.app'),
      iconDataUrl: null,
    },
    {
      id: 'zed',
      label: 'Zed',
      available: isEditorAvailable('zed', 'Zed.app'),
      iconDataUrl: null,
    },
  ];
  return detectedCache;
}

/** Spawn a detached process (stdio:'ignore' + unref) so the app outlives Tide. */
function detach(cmd: string, args: string[], opts?: { cwd?: string; shell?: boolean }): boolean {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      cwd: opts?.cwd ?? undefined,
      shell: opts?.shell ?? false,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Is a CLI binary on PATH? (Unix `which` / Windows `where`.) */
function cliAvailable(cli: string): boolean {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('where', [cli], { stdio: 'ignore' })
      : spawnSync('which', [cli], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Launch an editor for `dir`: prefer the CLI on PATH; fall back to
 *  `open -a <App>` on macOS for installed .apps missing the CLI. */
function launchEditor(cli: string, macAppName: string, dir: string): boolean {
  if (cliAvailable(cli)) {
    return detach(cli, [dir], { shell: process.platform === 'win32' });
  }
  if (process.platform === 'darwin') {
    return detach('open', ['-a', macAppName, dir]);
  }
  return false;
}

function openInTarget(target: ExternalAppTarget, dir: string): ShellOpResult {
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `Path does not exist: ${dir}` };
  }
  switch (target) {
    case 'finder': {
      // Utils.openPath opens the directory in the OS file manager; it reports
      // success as a boolean rather than Electron's error-string promise.
      const opened = Utils.openPath(dir);
      return opened ? { ok: true } : { ok: false, error: 'Failed to open file manager' };
    }
    case 'terminal': {
      if (process.platform === 'darwin') {
        return detach('open', ['-a', 'Terminal', dir])
          ? { ok: true }
          : { ok: false, error: 'Failed to launch Terminal' };
      }
      if (process.platform === 'win32') {
        return detach('cmd', ['/c', 'start', '', 'cmd'], { cwd: dir })
          ? { ok: true }
          : { ok: false, error: 'Failed to launch cmd' };
      }
      return detach('x-terminal-emulator', ['--working-directory', dir]) ||
        detach('xdg-open', [dir])
        ? { ok: true }
        : { ok: false, error: 'No terminal handler found' };
    }
    case 'vscode':
      return launchEditor('code', 'Visual Studio Code', dir)
        ? { ok: true }
        : { ok: false, error: 'Failed to launch VSCode' };
    case 'zed':
      return launchEditor('zed', 'Zed', dir)
        ? { ok: true }
        : { ok: false, error: 'Failed to launch Zed' };
    default:
      return { ok: false, error: `Unknown target: ${target}` };
  }
}

export interface OpenInAppRpcOpts {
  /** Resolve a session's folder: worktree.path → workspace path → $HOME. */
  resolveSessionPath?: (sessionId?: string) => string;
}

export function registerOpenInAppRpc(opts: OpenInAppRpcOpts = {}) {
  const resolveSessionPath =
    opts.resolveSessionPath ??
    ((_sessionId?: string) => os.homedir());

  return {
    openInAppDetect: (_: Record<string, never>) => detectApps(),

    openInAppOpen: ({ target, sessionId }: { target: ExternalAppTarget; sessionId?: string }) => {
      const dir = resolveSessionPath(sessionId);
      return openInTarget(target, dir);
    },
  };
}
