/**
 * Terminal service — spawns a real shell per terminal instance via node-pty.
 * Connected to xterm.js in the renderer for proper terminal emulation.
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as store from '../store.js';
import * as sessions from './sessions.js';
import { createLogger } from '../logger.js';
import type { WebContents } from 'electron';

const log = createLogger('terminal');
const require = createRequire(import.meta.url);
import * as os from 'node:os';
let pty: any = null;
try {
  pty = require('node-pty');
} catch (e) {
  log.error('node-pty failed to load', { err: e });
}

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
  /** Ports observed in this terminal's output. Tracked so we only
   *  emit `terminal:ports` when the set actually changes — otherwise
   *  every output chunk would re-fire the event for a listening dev
   *  server's banner. */
  detectedPorts: Set<number>;
}

/**
 * Check whether a process (by pid) is still alive. Uses kill(pid, 0) on
 * Unix (no signal sent, just an existence check) and tasklist on Windows.
 * Returns true if the process exists.
 */
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

/**
 * Scan a chunk of PTY output for dev-server port patterns. Requires a
 * hostname prefix (localhost / 127.0.0.1 / 0.0.0.0 / ::1) to avoid
 * matching timestamps and other colons. Returns unique ports in the
 * 10–65535 range — covers all common dev servers (vite :5173, next :3000,
 * rails :3000, flask :5000, django :8000, etc.) without matching
 * low-numbered false positives like `12:34:56`.
 */
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
  // Use the live session store (per-session files post-rewrite) rather
  // than reading sessions.json directly — that file is renamed to .bak
  // after migration, so the old direct read would silently fail and
  // resolveCwd would fall back to $HOME for every new terminal.
  //
  // Preference order:
  //   1. session.worktree.path — when the session is isolated in a
  //      worktree, tools + terminals operate there, NOT in the main
  //      checkout. This is what makes Run-script terminals land in the
  //      worktree alongside agent edits.
  //   2. workspace.path (resolved via session.workspaceId)
  //   3. workspace.path (when sessionId is actually a workspace id —
  //      e.g. Run button clicked before any session exists)
  //   4. $HOME as last-resort fallback
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
  const env = { ...process.env };

  const detectedPorts = new Set<number>();

  const sendOutput = (data: string) => {
    if (!wc.isDestroyed()) {
      wc.send('terminal:output', { terminalId, data });
    }
    // Scan for dev-server ports. Only re-emit when the SET changes so a
    // chatty server doesn't spam the renderer — once :5173 is reported,
    // subsequent log lines mentioning it stay silent.
    const fresh = scanPorts(data).filter((p) => !detectedPorts.has(p));
    if (fresh.length > 0) {
      for (const p of fresh) detectedPorts.add(p);
      if (!wc.isDestroyed()) {
        wc.send('terminal:ports', {
          terminalId,
          ports: [...detectedPorts].sort((a, b) => a - b).map((port) => ({
            port,
            url: `http://localhost:${port}`,
            label: 'Dev server',
          })),
        });
      }
    }
  };

  const ptyProc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
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
  }));

  terminals.set(terminalId, { ptyProc, pid, sessionId, cwd, wc, disposables, detectedPorts });
  log.info('started PTY', { terminalId, pid, sessionId, cwd });
}

export function sendInput(terminalId: string, input: string): void {
  const entry = terminals.get(terminalId);
  entry?.ptyProc.write(input);
}

/**
 * Stop the foreground process running inside a terminal's shell.
 *
 * PRIMARY: send Ctrl+C (\x03) to the PTY. The PTY's terminal driver forwards
 * SIGINT to the FOREGROUND process group — the real one (the dev server the
 * user ran + its children), NOT the shell's own group. This is how Ctrl+C
 * works interactively, and it's the only reliable cross-platform way to reach
 * the foreground job: job-control shells put each foreground command in its
 * OWN process group, so signaling the shell's group (-shellPid) misses it.
 *
 * A single \x03 can be swallowed if the process is mid-output or ignores the
 * first SIGINT, so we send it twice with a short gap. If the process still
 * hasn't died after ~1s (stubborn server, swallowed SIGINT), we escalate to a
 * tree-kill: find the shell's descendants and SIGKILL them directly.
 *
 * - Windows: Ctrl+C is also sent via \x03 (ConPTY forwards it), with a
 *   taskkill /T tree-kill fallback on the shell pid.
 *
 * The shell itself stays alive (only the foreground group dies), so onExit
 * does NOT fire — we clear ports explicitly here. Clearing the dedup Set lets
 * a re-run re-emit the port event.
 */
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

  try { entry.ptyProc.kill(); } catch { /* already dead */ }
  terminals.delete(terminalId);
}

export function killAllTerminals(): void {
  for (const [id] of terminals) killTerminal(id);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const entry = terminals.get(terminalId);
  try { entry?.ptyProc.resize(cols, rows); } catch { /* ignore */ }
}
