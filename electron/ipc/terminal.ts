/**
 * Terminal service — spawns a real shell per terminal instance via node-pty.
 * Connected to xterm.js in the renderer for proper terminal emulation.
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import { spawn, execFile } from 'child_process';
import * as net from 'node:net';
import * as store from '../store.js';
import * as sessions from './sessions.js';
import { sanitizePtyEnv } from './terminal-env.js';
import { ScrollbackBuffer } from './terminal-scrollback.js';
import { createLogger } from '../logger.js';
import type { WebContents } from 'electron';

const log = createLogger('terminal');
const require = createRequire(import.meta.url);
import * as os from 'node:os';
import * as path from 'node:path';
let pty: any = null;
try {
  pty = require('node-pty');
} catch (e) {
  log.error('node-pty failed to load', { err: e });
}

/** node-pty forks a `spawn-helper` binary which then posix_spawnp's the shell.
 *  That helper can lose its executable bit (pnpm/git/archive side-effects);
 *  without it posix_spawn fails with EACCES, surfaced as a generic
 *  "posix_spawnp failed". Restore +x on every launch so it self-heals. */
function ensureSpawnHelperExecutable(): void {
  try {
    const ptyMain = require.resolve('node-pty');
    const base = path.dirname(ptyMain);
    for (const prebuilds of [path.join(base, 'prebuilds'), path.join(base, '..', 'prebuilds')]) {
      let arches: string[];
      try { arches = fs.readdirSync(prebuilds); } catch { continue; }
      for (const arch of arches) {
        const helper = path.join(prebuilds, arch, 'spawn-helper');
        try {
          const st = fs.statSync(helper);
          if (!(st.mode & 0o111)) fs.chmodSync(helper, st.mode | 0o111);
        } catch { /* helper not here — try next dir */ }
      }
    }
  } catch { /* best-effort — never block terminal init */ }
}
ensureSpawnHelperExecutable();

interface TerminalEntry {
  ptyProc: any;
  /** Shell PID (ptyProc.pid). The stable anchor for a terminal — used for
   *  process-group Stop + liveness checks. The FOREGROUND process (the dev
   *  server the user ran) is a child of this shell; we reach it by signaling
   *  the process group, since node-pty doesn't expose the fg pid directly. */
  pid: number;
  /** The session id this terminal belongs to — so ports + liveness can be
   *  scoped per-session (a port in session A shouldn't show in session B). */
  sessionId: string;
  cwd: string;
  /** Cached WebContents — stopTerminal needs to emit `terminal:ports`
   *  when the user interrupts, but onExit doesn't fire (the shell
   *  itself is still alive after SIGINT kills the foreground process),
   *  so we can't rely on the exit path to clear ports. */
  wc: WebContents;
  /** Disposable subscriptions — disposed BEFORE kill to prevent
   *  stale exit events from reaching the renderer. */
  disposables: Array<{ dispose: () => void }>;
  /** Ports observed in this terminal's output, mapped to the process that
   *  owns them. Tracked so we only emit `terminal:ports` when the set
   *  actually changes — otherwise every output chunk would re-fire the
   *  event for a listening dev server's banner — and so the reaper can
   *  verify the owning process is still alive. */
  detectedPorts: Map<number, TrackedPort>;
  /** Main-side scrollback + monotonic output seq. Lets the renderer
   *  re-attach with a snapshot after a reload while the PTY keeps running. */
  scrollback: ScrollbackBuffer;
}

interface TrackedPort {
  /** Pid of the process listening on the port, resolved via lsof/netstat
   *  when the port was detected. Null when resolution failed — liveness
   *  then relies on the TCP probe alone. */
  pid: number | null;
  /** Consecutive failed liveness probes. A port is only reaped after two
   *  misses so a dev server mid-restart (port briefly closed) keeps its chip. */
  misses: number;
}

/** Check whether a process (by pid) is alive: kill(pid, 0) on Unix, tasklist on Windows. */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      // tasklist returns non-zero exit if the process doesn't exist.
      spawn('tasklist', ['/FI', `PID eq ${pid}`], { stdio: 'ignore' });
      return true; // best-effort; can't synchronously check on Windows here
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Get the shell pid for a terminal, or undefined if it doesn't exist. */
export function getTerminalPid(terminalId: string): number | undefined {
  return terminals.get(terminalId)?.pid;
}

const terminals = new Map<string, TerminalEntry>();

/** Scan PTY output for dev-server port patterns. Requires a hostname prefix (localhost/127.0.0.1/0.0.0.0/::1) to avoid matching timestamps; returns unique ports in 10–65535 (vite :5173, next :3000, rails :3000, flask :5000, django :8000, …) — no low-numbered false positives like `12:34:56`. */
const PORT_PATTERN =
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?):(\d{2,5})\b/g;

function scanPorts(data: string): number[] {
  const out = new Set<number>();
  for (const m of data.matchAll(PORT_PATTERN)) {
    const port = parseInt(m[1], 10);
    if (port >= 10 && port <= 65535) out.add(port);
  }
  return [...out];
}

function portsSnapshot(detectedPorts: Map<number, TrackedPort>): { port: number; url: string; label: string }[] {
  return [...detectedPorts.keys()].sort((a, b) => a - b).map((port) => ({
    port,
    url: `http://localhost:${port}`,
    label: 'Dev server',
  }));
}

/** Resolve which process is listening on a port (lsof on macOS/Linux,
 *  netstat on Windows). Best-effort — resolves null on timeout/absence. */
function resolvePortPid(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const parse = (out: string): number | null => {
      if (process.platform === 'win32') {
        for (const line of out.split('\n')) {
          const t = line.trim().split(/\s+/);
          if (t.length >= 5 && /^TCP$/i.test(t[0]) && /LISTENING/i.test(t[3])) {
            const localPort = parseInt(t[1].slice(t[1].lastIndexOf(':') + 1), 10);
            const pid = parseInt(t[t.length - 1], 10);
            if (localPort === port && Number.isFinite(pid) && pid > 0) return pid;
          }
        }
        return null;
      }
      const pid = parseInt(out.split('\n')[0]?.trim() ?? '', 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    };
    const cmd = process.platform === 'win32' ? 'netstat' : 'lsof';
    const args = process.platform === 'win32' ? ['-ano'] : ['-nP', '-ti', `tcp:${port}`, '-sTCP:LISTEN'];
    execFile(cmd, args, { timeout: 1500 }, (err, stdout) => {
      resolve(err ? null : parse(String(stdout ?? '')));
    });
  });
}

/** Probe whether anything still accepts connections on the port. Tries IPv4
 *  first, then IPv6 — a server bound to ::1 only must not read as dead. */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const probe = (host: string, fallback?: () => void) => {
      const socket = net.connect({ host, port });
      socket.setTimeout(750);
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('timeout', () => { socket.destroy(); done(false); });
      socket.once('error', () => {
        socket.destroy();
        if (fallback) fallback();
        else done(false);
      });
    };
    probe('127.0.0.1', () => probe('::1'));
  });
}

// ── Port liveness reaper ─────────────────────────────────────────
// The shell outlives the foreground dev server, so output scanning alone
// never learns that the server died (Ctrl+C typed manually, external kill,
// crash). This periodic check ties each port chip to its owning process:
// when the pid is gone or nothing accepts connections, the port is dropped
// from `terminal:ports` and the renderer's indicator disappears.
const PORT_REAP_AFTER_MISSES = 2;
let portReaper: NodeJS.Timeout | null = null;
let reaperBusy = false;

function startPortReaperIfNeeded(): void {
  if (portReaper) return;
  portReaper = setInterval(() => reapDeadPorts(), 2000);
}

function stopPortReaperIfIdle(): void {
  if (!portReaper) return;
  for (const entry of terminals.values()) {
    if (entry.detectedPorts.size > 0) return;
  }
  clearInterval(portReaper);
  portReaper = null;
}

async function reapDeadPorts(): Promise<void> {
  if (reaperBusy) return;
  reaperBusy = true;
  try {
    for (const [terminalId, entry] of terminals) {
      if (entry.detectedPorts.size === 0) continue;
      let changed = false;
      for (const [port, tracked] of entry.detectedPorts) {
        // A resolved pid gives a free dead-process signal, but pid liveness
        // can't prove the listener still exists (and isProcessAlive is a
        // blind `true` on Windows) — so the TCP probe stays authoritative.
        const alive = (tracked.pid === null || isProcessAlive(tracked.pid)) && (await isPortOpen(port));
        if (alive) {
          if (tracked.misses > 0) entry.detectedPorts.set(port, { ...tracked, misses: 0 });
          continue;
        }
        const misses = tracked.misses + 1;
        if (misses >= PORT_REAP_AFTER_MISSES) {
          log.info('port owner gone — clearing indicator', { terminalId, port, pid: tracked.pid });
          entry.detectedPorts.delete(port);
          changed = true;
        } else {
          entry.detectedPorts.set(port, { ...tracked, misses });
        }
      }
      if (changed && !entry.wc.isDestroyed()) {
        entry.wc.send('terminal:ports', { terminalId, ports: portsSnapshot(entry.detectedPorts) });
      }
    }
  } finally {
    reaperBusy = false;
    stopPortReaperIfIdle();
  }
}

function getShell(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return { cmd: process.env.COMSPEC || 'powershell.exe', args: [] };
  }
  // Use $SHELL if set, otherwise platform-aware fallback:
  // macOS → zsh, Linux → bash, then sh as last resort.
  const fallback = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const shell = process.env.SHELL || fallback;
  return { cmd: shell, args: ['-i'] };
}

function resolveCwd(sessionId: string): string {
  // Resolve cwd from the live session store (not sessions.json, which is renamed to .bak post-migration). Preference: session.worktree.path, then workspace.path via workspaceId, then workspace.path when sessionId IS a workspace id, then $HOME.
  try {
    const workspaces = store.listWorkspaces();
    const session = sessions.getSession(sessionId);
    if (session?.worktree?.path && fs.existsSync(session.worktree.path)) {
      return session.worktree.path;
    }
    if (session?.workspaceId) {
      const ws = workspaces.find((w) => w.id === session.workspaceId);
      if (ws?.path && fs.existsSync(ws.path)) return ws.path;
    }
    // Workspace path: the id IS the workspace id (e.g. Run button clicked
    // before any session exists).
    const ws = workspaces.find((w) => w.id === sessionId);
    if (ws?.path && fs.existsSync(ws.path)) return ws.path;
  } catch { /* fall back to HOME */ }
  return os.homedir();
}

export function startTerminal(
  terminalId: string,
  sessionId: string,
  wc: WebContents,
  size?: { cols: number; rows: number },
): void {
  // Kill any existing terminal with this ID — but dispose its
  // listeners FIRST so the old process's exit event doesn't leak.
  killTerminal(terminalId);

  if (!pty) {
    log.error('node-pty not available');
    return;
  }

  const cwd = resolveCwd(sessionId);
  const { cmd, args } = getShell();
  const env = sanitizePtyEnv(process.env);
  // Provisional size from the renderer's font metrics (avoids the 80x24
  // spawn flash); bounded like OpenChamber: 2–1000 cols, 1–500 rows.
  const cols = Math.min(1000, Math.max(2, Math.floor(size?.cols ?? 80)));
  const rows = Math.min(500, Math.max(1, Math.floor(size?.rows ?? 24)));

  const detectedPorts = new Map<number, TrackedPort>();
  const scrollback = new ScrollbackBuffer(512 * 1024);

  const sendOutput = (data: string) => {
    // Buffer FIRST and unconditionally — output arriving while the renderer
    // is reloading (wc destroyed) must still accumulate for the snapshot.
    const seq = scrollback.append(data);
    if (!wc.isDestroyed()) {
      wc.send('terminal:output', { terminalId, data, seq });
    }
    // Scan for dev-server ports. Only re-emit when the SET changes so a
    // chatty server doesn't spam the renderer — once :5173 is reported,
    // subsequent log lines mentioning it stay silent.
    const fresh = scanPorts(data).filter((p) => !detectedPorts.has(p));
    if (fresh.length > 0) {
      for (const p of fresh) {
        detectedPorts.set(p, { pid: null, misses: 0 });
        // Resolve the owning pid async — the chip renders immediately, the
        // association lands when lsof/netstat answers.
        void resolvePortPid(p).then((pid) => {
          const tracked = detectedPorts.get(p);
          if (tracked && tracked.pid === null && pid !== null) {
            detectedPorts.set(p, { ...tracked, pid });
          }
        });
      }
      startPortReaperIfNeeded();
      if (!wc.isDestroyed()) {
        wc.send('terminal:ports', {
          terminalId,
          ports: portsSnapshot(detectedPorts),
        });
      }
    }
  };

  const ptyProc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });

  const pid: number = ptyProc.pid;
  // Store disposables so we can unsubscribe before killing.
  const disposables: Array<{ dispose: () => void }> = [];
  disposables.push(ptyProc.onData((data: string) => sendOutput(data)));
  disposables.push(ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
    // Check if this terminal is still the current one (not already replaced).
    const entry = terminals.get(terminalId);
    if (entry?.ptyProc !== ptyProc) return; // stale — a new PTY replaced this one
    if (!wc.isDestroyed()) {
      wc.send('terminal:exit', { terminalId, code: exitCode });
      // Clear ports on exit — the dev server is gone, so links should
      // disappear from the UI rather than pointing at a dead process.
      wc.send('terminal:ports', { terminalId, ports: [] });
    }
    terminals.delete(terminalId);
    stopPortReaperIfIdle();
  }));

  terminals.set(terminalId, { ptyProc, pid, sessionId, cwd, wc, disposables, detectedPorts, scrollback });
  log.info('started PTY', { terminalId, pid, sessionId, cwd });
}

/** Snapshot re-attach: return the terminal's buffered scrollback + output
 *  seq. Re-binds the entry's WebContents to the caller — after a renderer
 *  reload the stored wc is destroyed, which would otherwise silently drop
 *  live output forever. `alive: false` means no PTY — the caller should
 *  spawn a fresh one. */
export function snapshotTerminal(
  terminalId: string,
  wc: WebContents,
): { alive: true; data: string; seq: number } | { alive: false } {
  const entry = terminals.get(terminalId);
  if (!entry) return { alive: false };
  entry.wc = wc;
  const snap = entry.scrollback.snapshot();
  return { alive: true, data: snap.data, seq: snap.seq };
}

export function sendInput(terminalId: string, input: string): void {
  const entry = terminals.get(terminalId);
  entry?.ptyProc.write(input);
}

/** Stop the terminal's foreground process: send Ctrl+C (\x03) twice to the PTY (SIGINT reaches the foreground group, not the shell's group), then escalate to a tree-kill (pkill -P / taskkill /T) after ~1.2s if it survives. The shell stays alive, so ports are cleared explicitly here. */
export function stopTerminal(terminalId: string): void {
  const entry = terminals.get(terminalId);
  if (!entry) return;
  entry.detectedPorts.clear();
  if (!entry.wc.isDestroyed()) {
    entry.wc.send('terminal:ports', { terminalId, ports: [] });
  }
  const { pid, ptyProc } = entry;

  // Primary: Ctrl+C via the PTY (twice, with a gap, for reliability).
  try { ptyProc.write('\x03'); } catch { /* already dead */ }
  setTimeout(() => {
    try { ptyProc.write('\x03'); } catch { /* already dead */ }
  }, 200);

  // Escalation fallback: if the process survives ~1.2s, tree-kill the shell's
  // descendants directly. SIGKILL is unblockable — catches stubborn servers.
  setTimeout(() => {
    if (!isProcessAlive(pid)) return; // already gone — Ctrl+C worked
    log.info('stop: escalating to tree-kill', { terminalId, pid });
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
        .on('error', () => { /* already dead */ });
    } else {
      // pgrep -P finds direct children of the shell; recurse one level for
      // their children (npm → vite → workers). SIGKILL each. The shell itself
      // is left alive (we only kill its descendants).
      spawn('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' })
        .on('error', () => { /* already dead or pkill unavailable */ });
    }
  }, 1200);
}

export function killTerminal(terminalId: string): void {
  const entry = terminals.get(terminalId);
  if (!entry) return;

  // Dispose ALL listeners BEFORE killing. This prevents the old
  // process's onExit callback from firing and sending a stale
  // terminal:exit event to the renderer — which was causing
  // "[Process exited with code 0]" on new terminals.
  for (const d of entry.disposables) {
    try { d.dispose(); } catch { /* already disposed */ }
  }

  // Killed PTYs get no natural exit event, so clear the port indicator here —
  // otherwise idle-reaped terminals keep their chips/dots in the renderer forever.
  if (entry.detectedPorts.size > 0 && !entry.wc.isDestroyed()) {
    entry.wc.send('terminal:ports', { terminalId, ports: [] });
  }

  try { entry.ptyProc.kill(); } catch { /* already dead */ }
  terminals.delete(terminalId);
  stopPortReaperIfIdle();
}

export function killAllTerminals(): void {
  for (const [id] of terminals) killTerminal(id);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const entry = terminals.get(terminalId);
  try { entry?.ptyProc.resize(cols, rows); } catch { /* ignore */ }
}
