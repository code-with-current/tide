/**
 * Terminal service — spawns a real shell per terminal instance via node-pty.
 * Connected to xterm.js in the renderer for proper terminal emulation.
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as store from '../store.js';
import * as sessions from './sessions.js';
import { createLogger } from '../logger.js';
import type { WebContents } from 'electron';

const log = createLogger('terminal');
const require = createRequire(import.meta.url);
let pty: any = null;
try {
  pty = require('node-pty');
} catch (e) {
  log.error('node-pty failed to load', { err: e });
}

interface TerminalEntry {
  ptyProc: any;
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
  const shell = process.env.SHELL || '/bin/zsh';
  // Interactive (not login) shell — skips /etc/zprofile, ~/.zprofile,
  // ~/.zlogin which are the slow paths (nvm, conda, rbenv init can add
  // 1-5s). ~/.zshrc still loads (interactive), so aliases and prompt
  // themes work. If the user needs a full login shell, they can run
  // `exec zsh -l` manually.
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
  return process.env.HOME || '/';
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

  terminals.set(terminalId, { ptyProc, cwd, wc, disposables, detectedPorts });
  log.info('started PTY', { terminalId, cwd });
}

export function sendInput(terminalId: string, input: string): void {
  const entry = terminals.get(terminalId);
  entry?.ptyProc.write(input);
}

/**
 * Stop the foreground process in a terminal. Sends ETX (Ctrl+C, \x03)
 * to the PTY — the shell forwards SIGINT to whatever the user's running,
 * same as hitting Ctrl+C manually. Graceful: dev servers get a chance
 * to clean up sockets / child workers before exiting.
 *
 * Use this for the Run-script Stop button. Harder kill (SIGKILL via
 * killTerminal) is reserved for close-tab, where we tear down the PTY
 * entirely.
 *
 * Also clears detected ports: the dev server is dying, so its port is
 * no longer reachable. The shell stays alive after SIGINT (only the
 * foreground process dies), so onExit does NOT fire — without this
 * explicit clear, port badges would linger forever after Stop.
 * Clearing the dedup Set also lets a re-run of the same script re-emit
 * the port event instead of being silently filtered as "already seen".
 */
export function stopTerminal(terminalId: string): void {
  const entry = terminals.get(terminalId);
  if (!entry) return;
  entry.detectedPorts.clear();
  if (!entry.wc.isDestroyed()) {
    entry.wc.send('terminal:ports', { terminalId, ports: [] });
  }
  try { entry.ptyProc.write('\x03'); } catch { /* already dead */ }
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
