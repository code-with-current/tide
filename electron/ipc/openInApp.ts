/**
 * Open-in-app — opens the active session's project folder in an external app
 * (Finder/File Explorer, Terminal, VSCode, Zed). Powers the top-bar icon menu.
 *
 * Two handlers:
 *   tide:openInApp:detect  — probe which optional editors (VSCode, Zed) are
 *                            installed. Result cached for the process lifetime;
 *                            the renderer calls this once on first menu open.
 *   tide:openInApp:open    — resolve the session's path server-side and open
 *                            it in the requested app.
 *
 * Security: the renderer passes only `sessionId` (never an arbitrary path).
 * The path is resolved through the same chain terminal.ts uses (worktree →
 * workspace → HOME), so the surface is no wider than the existing terminal
 * handler. `spawn` is used with argv arrays (no shell), so there's no
 * injection vector through the path.
 *
 * Path resolution is intentionally a focused duplicate of terminal.ts:79-103
 * rather than a shared helper — the rule is short, terminal.ts owns its copy,
 * and a premature shared module would couple two unrelated features. The
 * canonical version lives there; this one mirrors it with a cross-reference.
 */
import { app, ipcMain, shell } from 'electron';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as store from '../store.js';
import * as sessions from './sessions.js';
import type { ExternalApp, ExternalAppTarget } from '../../src/types/index.js';

// ─── Detection ──────────────────────────────────────────────────────────

/** Cache the detection result so repeated menu opens don't re-probe (~10ms
 *  each adds up). Cleared only by process restart — installing an editor
 *  mid-session requires a Tide restart to surface. Acceptable for v1. */
let detectedCache: ExternalApp[] | null = null;

// macOS app-bundle locations. Finder + Terminal are system apps (not in
// /Applications); editors live in /Applications. Used both for availability
// checks and as the path passed to app.getFileIcon() to fetch the OS icon.
const MAC_BUNDLES = {
  finder: '/System/Library/CoreServices/Finder.app',
  terminal: '/System/Applications/Utilities/Terminal.app',
  vscode: '/Applications/Visual Studio Code.app',
  zed: '/Applications/Zed.app',
} as const;

/** Resolve the bundle/binary path to read an icon from, per platform.
 *  Dispatches to the platform-specific resolver below. Returns null when
 *  there's nothing to read (e.g. Linux CLI-only install with no bundle). */
function resolveIconPath(id: ExternalAppTarget): string | null {
  if (process.platform === 'darwin') return resolveIconPathMac(id);
  if (process.platform === 'win32') return resolveIconPathWindows(id);
  return resolveIconPathLinux(id);
}

/** macOS: system apps and editors both resolve to a .app bundle path. fs
 *  check gates it so a missing editor doesn't return a stale path. */
function resolveIconPathMac(id: ExternalAppTarget): string | null {
  const p = MAC_BUNDLES[id];
  try {
    if (p && fs.existsSync(p)) return p;
  } catch { /* ignore */ }
  return null;
}

/** Windows: resolve the executable that actually carries an embedded icon.
 *
 *  `where <cli>` on Windows returns multiple matches, and the FIRST is often a
 *  Unix-style shim with no extension (e.g. `...\bin\code`) that isn't a real
 *  file — `where` lists it via the PATHEXT-less entry but it doesn't exist on
 *  disk. The icon-bearing target is the `.exe`:
 *    - Built-ins: %SystemRoot%\explorer.exe, %SystemRoot%\system32\cmd.exe.
 *    - Editors:   the `.exe` from `where` (e.g. Zed.exe), or for VS Code the
 *                 install-root Code.exe when only the bin/ shim is on PATH.
 *
 *  We filter `where` output to the first existing `.exe` and fall back to the
 *  known install location, so getFileIcon always gets a real binary. */
function resolveIconPathWindows(id: ExternalAppTarget): string | null {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  if (id === 'finder') return `${sysRoot}\\explorer.exe`;
  if (id === 'terminal') return `${sysRoot}\\system32\\cmd.exe`;

  const cli = id === 'vscode' ? 'code' : id === 'zed' ? 'zed' : null;
  if (!cli) return null;

  // `where` returns one path per line (possibly several for PATHEXT variants).
  // Pick the first that is an existing .exe — skip extensionless shims and
  // .cmd/.bat launchers, which carry no embedded icon.
  const exe = firstExistingExeOnWindows(cli);
  if (exe) return exe;

  // VS Code fallback: the bin/ shim is on PATH but no Code.exe is — resolve
  // the real install root (the shim lives under <install>\bin\, so the app
  // executable is <install>\Code.exe).
  if (id === 'vscode') {
    const shim = firstWhereResult(cli);
    if (shim) {
      const codeExe = path.join(path.dirname(path.dirname(shim)), 'Code.exe');
      try {
        if (fs.existsSync(codeExe)) return codeExe;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/** Linux: best-effort via the CLI's resolved location. `which` returns the
 *  binary path; getFileIcon reads the mime-associated icon. finder/terminal
 *  have no single canonical binary here, so they fall back to lucide icons. */
function resolveIconPathLinux(id: ExternalAppTarget): string | null {
  const cli = id === 'vscode' ? 'code' : id === 'zed' ? 'zed' : null;
  if (!cli) return null;
  try {
    const probe = spawnSync('which', [cli], { stdio: 'pipe', encoding: 'utf8' });
    if (probe.status === 0) return probe.stdout.trim().split('\n')[0];
  } catch { /* ignore */ }
  return null;
}

/** Windows: run `where <cli>` and return the first result line (trimmed). */
function firstWhereResult(cli: string): string | null {
  try {
    const probe = spawnSync('where', [cli], { stdio: 'pipe', encoding: 'utf8' });
    if (probe.status !== 0) return null;
    const lines = probe.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

/** Windows: from `where <cli>` output, return the first path that is an actual
 *  existing .exe file (skipping extensionless shims and .cmd/.bat launchers,
 *  which don't carry an embedded icon). */
function firstExistingExeOnWindows(cli: string): string | null {
  try {
    const probe = spawnSync('where', [cli], { stdio: 'pipe', encoding: 'utf8' });
    if (probe.status !== 0) return null;
    for (const raw of probe.stdout.split(/\r?\n/)) {
      const p = raw.trim();
      if (!p) continue;
      const lower = p.toLowerCase();
      if (!lower.endsWith('.exe')) continue; // skip `code`, `code.cmd`, etc.
      try {
        if (fs.existsSync(p)) return p;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

/** True if a CLI binary is on PATH (which/where) OR — macOS only — the .app
 *  bundle exists. */
function isEditorAvailable(cli: string, macBundle?: string): boolean {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [cli], { stdio: 'ignore' })
    : spawnSync('which', [cli], { stdio: 'ignore' });
  if (probe.status === 0) return true;
  if (process.platform === 'darwin' && macBundle) {
    try {
      return fs.existsSync(path.join('/Applications', macBundle));
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Fetch an app's OS icon as a base64 data URL.
 *
 * On macOS, Electron's app.getFileIcon() returns a generic placeholder for
 * .app bundles and their executables (the bundle's actual CFBundleIconFile is
 * not honored), so we extract the real icon ourselves: read CFBundleIconFile
 * from Info.plist, convert the .icns to PNG via the system `sips` tool, and
 * base64-encode. This yields the true, colorful per-app icon (verified:
 * VSCode/Zed/Finder/Terminal all produce distinct PNGs).
 *
 * On Windows/Linux, getFileIcon works as documented (reads .exe embedded
 * icons / mime-associated icons), so we use it directly.
 *
 * Returns null if extraction fails — the renderer falls back to a lucide icon. */
async function fetchIcon(id: ExternalAppTarget): Promise<string | null> {
  const iconPath = resolveIconPath(id);
  if (!iconPath) return null;

  // macOS: extract the bundle's real icon via sips.
  if (process.platform === 'darwin') {
    const dataUrl = await extractMacIcon(id, iconPath);
    if (dataUrl) return dataUrl;
    // Fall through to getFileIcon if sips failed (shouldn't happen on a
    // healthy macOS install, but be defensive).
  }

  try {
    const img = await app.getFileIcon(iconPath, { size: 'normal' });
    return img.isEmpty() ? null : img.toDataURL();
  } catch {
    return null;
  }
}

/** macOS-only: read CFBundleIconFile from the bundle's Info.plist, convert
 *  the .icns resource to PNG via the system `sips` tool, return as a data URL.
 *
 *  Uses the plain converter form `sips -s format png <icns> --out <png>` —
 *  no resample, because .icns already contains multiple sizes and sips picks
 *  the largest rep. The renderer downscales via CSS to fit the ~14px menu
 *  slot, so we keep the full-resolution PNG and let the browser handle it.
 *
 *  `sips` is always present on macOS (system tool). Synchronous spawn is fine
 *  here — runs once per app at detect time (~30ms each), then cached.
 *
 *  NOTE: this used to reference an undefined `id` in the temp filename (the
 *  function only took bundlePath), which threw ReferenceError and silently
 *  fell through to the getFileIcon placeholder. `id` is now a real param. */
function extractMacIcon(id: ExternalAppTarget, bundlePath: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(bundlePath, 'Contents/Info.plist'), 'utf8');
    // CFBundleIconFile value may or may not include the .icns extension.
    const m = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/);
    if (!m) return null;
    let iconFile = m[1];
    if (!iconFile.endsWith('.icns')) iconFile += '.icns';
    const icns = path.join(bundlePath, 'Contents/Resources', iconFile);
    if (!fs.existsSync(icns)) return null;

    // Plain format conversion + downscale: icns → 64px PNG. The bare form
    // `sips -s format png <icns> --out <png>` works but extracts the largest
    // rep in the .icns (often 1024×1024 → ~200-450KB → ~600KB base64 each,
    // ~2.4MB across four icons for a 14px menu slot). --resampleWidth 64
    // caps it at ~5KB each — crisp on retina (14px × 2 dpr = 28px target),
    // a ~50× payload reduction, visually identical at menu size.
    const tmp = path.join(os.tmpdir(), `tide-icon-${id}.png`);
    const r = spawnSync('sips', ['-s', 'format', 'png', '--resampleWidth', '64', icns, '--out', tmp], {
      stdio: 'ignore',
    });
    if (r.status !== 0 || !fs.existsSync(tmp)) return null;
    const png = fs.readFileSync(tmp);
    // Best-effort cleanup; leave-it-if-fails is harmless (reused on next call).
    fs.unlink(tmp, () => {});
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null;
  }
}

/** The OS-appropriate display name for the built-in file manager. The target
 *  id stays 'finder' (a stable cross-platform identifier, persisted in the
 *  renderer's localStorage as the default), but the label shown in the menu
 *  matches the OS so a Windows user sees "File Explorer", not "Finder". */
function fileManagerLabel(): string {
  if (process.platform === 'win32') return 'File Explorer';
  if (process.platform === 'darwin') return 'Finder';
  return 'Files'; // Linux — generic (Nautilus/Dolphin/etc. vary)
}

/** Detect available apps and their OS icons. Async because getFileIcon is.
 *  Result cached for the process lifetime (one ~50ms cost, then free). */
async function detectApps(): Promise<ExternalApp[]> {
  if (detectedCache) return detectedCache;
  const apps: ExternalApp[] = [
    { id: 'finder', label: fileManagerLabel(), available: true },
    { id: 'terminal', label: 'Terminal', available: true },
    {
      id: 'vscode',
      label: 'VSCode',
      available: isEditorAvailable('code', 'Visual Studio Code.app'),
    },
    {
      id: 'zed',
      label: 'Zed',
      available: isEditorAvailable('zed', 'Zed.app'),
    },
  ];
  // Fetch icons in parallel (~50ms total instead of 4× serial). available
  // check is sync; icon fetch is the only async part.
  const icons = await Promise.all(apps.map((a) => fetchIcon(a.id)));
  detectedCache = apps.map((a, i) => ({ ...a, iconDataUrl: icons[i] }));
  return detectedCache;
}

// ─── Path resolution (mirrors terminal.ts:79-103) ───────────────────────

/** Resolve the folder to open for a session. Preference order:
 *   1. session.worktree.path — isolated worktree sessions open there
 *   2. workspace.path via session.workspaceId
 *   3. workspace.path when sessionId IS a workspace id (no session yet)
 *   4. $HOME fallback
 * Each step gated by fs.existsSync so a stale worktree doesn't win. */
function resolveSessionPath(sessionId?: string): string {
  try {
    if (sessionId) {
      const workspaces = store.listWorkspaces();
      const session = sessions.getSession(sessionId);
      if (session?.worktree?.path && fs.existsSync(session.worktree.path)) {
        return session.worktree.path;
      }
      if (session?.workspaceId) {
        const ws = workspaces.find((w) => w.id === session.workspaceId);
        if (ws?.path && fs.existsSync(ws.path)) return ws.path;
      }
      // sessionId might itself be a workspace id (e.g. menu opened from a
      // workspace view with no active session).
      const ws = workspaces.find((w) => w.id === sessionId);
      if (ws?.path && fs.existsSync(ws.path)) return ws.path;
    }
  } catch {
    /* fall through to HOME */
  }
  return os.homedir();
}

// ─── Open in target app ─────────────────────────────────────────────────

/** Spawn a detached process so the launched app outlives Tide. stdio:'ignore'
 *  + unref() detaches it fully — we don't care about its output or exit.
 *  `cwd` (optional) launches the process already in that directory, which on
 *  Windows is the robust way to open a terminal in a folder without fighting
 *  `start`'s quote/title parsing (passing the path as a `cmd /K` arg instead
 *  treats it as a command to run → "not recognized as an internal command").
 *  `shell` (optional) — on Windows, the editor CLIs (`code`/`zed`) resolve to
 *  `.cmd`/extensionless shims that Node's spawn can't launch detached without
 *  a shell; passing shell:true lets cmd.exe resolve them. */
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

/** Launch an editor for `dir`. Prefers the CLI (`code`/`zed`) when on PATH
 *  — faster, no `open` indirection. Falls back to `open -a <App> <dir>` on
 *  macOS so an installed `.app` whose "Shell Command: Install 'code' in PATH"
 *  step was skipped still launches. (Common case: VSCode's .app present but
 *  `code` CLI absent — without this fallback, detection says available but
 *  launch silently fails.)
 *
 *  Windows note: the editor CLIs resolve to `.cmd`/extensionless shims (e.g.
 *  `code.cmd`), which Node's `spawn` cannot launch detached without a shell.
 *  We pass `shell: true` there so cmd.exe resolves the shim. Without it the
 *  spawn fails asynchronously (after detach already returned true) and VS Code
 *  never opens — the detection still says "available" because `where code` finds
 *  the shim, so this is the only thing that actually launches it. */
function launchEditor(cli: string, macAppName: string, dir: string): boolean {
  if (cliAvailable(cli)) {
    return detach(cli, [dir], { shell: process.platform === 'win32' });
  }
  if (process.platform === 'darwin') {
    // `open -a "Visual Studio Code" <dir>` — opens the installed .app at dir.
    return detach('open', ['-a', macAppName, dir]);
  }
  // Windows/Linux without the CLI: nothing to fall back to. The detection
  // step should have hidden the entry, but guard anyway.
  return false;
}

function openInTarget(target: ExternalAppTarget, dir: string): { ok: boolean; error?: string } {
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `Path does not exist: ${dir}` };
  }
  switch (target) {
    case 'finder':
      // shell.openPath opens the directory in the OS file manager
      // (Finder/Explorer/xdg-open handler). Returns '' on success.
      return shell.openPath(dir).then((err) => (err ? { ok: false, error: err } : { ok: true }));
    case 'terminal': {
      // Per-OS: macOS → Terminal.app; Linux → x-terminal-emulator or
      // xdg-open; Windows → cmd at the path.
      if (process.platform === 'darwin') {
        return detach('open', ['-a', 'Terminal', dir])
          ? { ok: true }
          : { ok: false, error: 'Failed to launch Terminal' };
      }
      if (process.platform === 'win32') {
        // Open a new cmd window already in `dir`. We spawn `cmd` with cwd=dir
        // so the directory is inherited — no need to pass the path as an arg
        // (passing it to `cmd /K <path>` makes cmd try to RUN the path as a
        // command → "not recognized as an internal or external command").
        // `start ""` opens a new console window; the empty title arg is the
        // documented workaround so `start` doesn't grab the next quoted arg
        // as the window title.
        return detach('cmd', ['/c', 'start', '', 'cmd'], { cwd: dir })
          ? { ok: true }
          : { ok: false, error: 'Failed to launch cmd' };
      }
      // Linux: prefer the debian-style alias, fall back to xdg-open.
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

// ─── IPC registration ───────────────────────────────────────────────────

export function registerOpenInAppHandlers(): void {
  ipcMain.handle('tide:openInApp:detect', () => detectApps());

  ipcMain.handle(
    'tide:openInApp:open',
    (_e: unknown, target: ExternalAppTarget, sessionId?: string) => {
      const dir = resolveSessionPath(sessionId);
      const result = openInTarget(target, dir);
      // shell.openPath returns a Promise; the other branches return a plain
      // object. Normalize both into Promise<{ok,error?}>.
      return Promise.resolve(result);
    },
  );
}
