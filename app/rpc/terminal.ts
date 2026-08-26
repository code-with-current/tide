/** Terminal RPC — port of electron/ipc/terminal.ts (frozen Electron shell)
 *  onto the PTY backend seam (app/platform/pty.ts, spike 1.1). Output flows
 *  through the seam's per-session coalescer: each flush appends to the
 *  main-side scrollback (monotonic seq), rides the terminalOutput message,
 *  and is scanned for dev-server ports. The scrollback request flushes the
 *  coalescer BEFORE snapshotting so a reconnecting renderer can neither miss
 *  nor double-receive output (seq-per-batch covers everything appended
 *  before the flush). Port detection + the liveness reaper are carried over
 *  unchanged; WebContents pushes became the send closures from main.ts. */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import { createLogger } from '../core/logger.js';
import * as store from '../core/store.js';
import * as sessions from '../core/ipc-adjacent/sessions.js';
import {
  clampPtySize,
  createPtySessionManager,
  getShell,
  sanitizePtyEnv,
  type PtySessionManager,
} from '../platform/pty';
import { ScrollbackBuffer } from '../platform/terminal-scrollback';
import type { TerminalPort, TerminalScrollbackResult } from '../../shared/rpc';

const log = createLogger('terminal-rpc');

export interface TerminalRpcSend {
  output(msg: { terminalId: string; data: string; seq: number }): void;
  exit(msg: { terminalId: string; code: number | null }): void;
  ports(msg: { terminalId: string; ports: TerminalPort[] }): void;
}

interface TrackedPort {
  /** Pid of the process listening on the port, resolved via lsof/netstat
   *  when the port was detected. Null when resolution failed. */
  pid: number | null;
  /** Consecutive failed liveness probes — a port is only reaped after two
   *  misses so a dev server mid-restart keeps its chip. */
  misses: number;
}

interface TerminalEntry {
  sessionId: string;
  cwd: string;
  /** Ports observed in this terminal's output, mapped to the process that
   *  owns them — only re-emit `terminalPorts` when the set actually changes. */
  detectedPorts: Map<number, TrackedPort>;
  scrollback: ScrollbackBuffer;
}

export interface TerminalRpcOpts {
  manager?: PtySessionManager;
  scrollbackChars?: number;
}

/** Check whether a process (by pid) is alive: kill(pid, 0) on Unix, a
 *  best-effort true on Windows (tasklist is async-only here). */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      spawn('tasklist', ['/FI', `PID eq ${pid}`], { stdio: 'ignore' });
      return true;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Scan PTY output for dev-server port patterns. Requires a hostname prefix
 *  (localhost/127.0.0.1/0.0.0.0/::1) to avoid matching timestamps; returns
 *  unique ports in 10–65535 — no low-numbered false positives like 12:34:56. */
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

function portsSnapshot(detectedPorts: Map<number, TrackedPort>): TerminalPort[] {
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

/** Resolve cwd from the live session store. Preference: session.worktree.path,
 *  then workspace.path via workspaceId, then workspace.path when sessionId IS
 *  a workspace id (Run button before any session exists), then $HOME. */
function resolveCwd(sessionId: string): string {
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
    const ws = workspaces.find((w) => w.id === sessionId);
    if (ws?.path && fs.existsSync(ws.path)) return ws.path;
  } catch { /* fall back to HOME */ }
  return os.homedir();
}

export function registerTerminalRpc(send: TerminalRpcSend, opts: TerminalRpcOpts = {}) {
  const manager = opts.manager ?? createPtySessionManager();
  const scrollbackChars = opts.scrollbackChars ?? 512 * 1024;
  const terminals = new Map<string, TerminalEntry>();

  // ── Port liveness reaper ─────────────────────────────────────────
  // The shell outlives the foreground dev server, so output scanning alone
  // never learns that the server died. This periodic check ties each port
  // chip to its owning process: when the pid is gone or nothing accepts
  // connections, the port is dropped and the renderer's indicator disappears.
  const PORT_REAP_AFTER_MISSES = 2;
  let portReaper: ReturnType<typeof setInterval> | null = null;
  let reaperBusy = false;

  function startPortReaperIfNeeded(): void {
    if (portReaper) return;
    portReaper = setInterval(() => void reapDeadPorts(), 2000);
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
        if (changed) send.ports({ terminalId, ports: portsSnapshot(entry.detectedPorts) });
      }
    } finally {
      reaperBusy = false;
      stopPortReaperIfIdle();
    }
  }

  function handleOutput(terminalId: string, data: string): void {
    const entry = terminals.get(terminalId);
    if (!entry) return;
    const seq = entry.scrollback.append(data);
    send.output({ terminalId, data, seq });
    const fresh = scanPorts(data).filter((p) => !entry.detectedPorts.has(p));
    if (fresh.length === 0) return;
    for (const p of fresh) {
      entry.detectedPorts.set(p, { pid: null, misses: 0 });
      // Resolve the owning pid async — the chip renders immediately, the
      // association lands when lsof/netstat answers.
      void resolvePortPid(p).then((pid) => {
        const tracked = entry.detectedPorts.get(p);
        if (tracked && tracked.pid === null && pid !== null) {
          entry.detectedPorts.set(p, { ...tracked, pid });
        }
      });
    }
    startPortReaperIfNeeded();
    send.ports({ terminalId, ports: portsSnapshot(entry.detectedPorts) });
  }

  function clearPorts(terminalId: string): void {
    const entry = terminals.get(terminalId);
    if (!entry || entry.detectedPorts.size === 0) return;
    entry.detectedPorts.clear();
    send.ports({ terminalId, ports: [] });
  }

  return {
    terminalCreate: ({ terminalId, sessionId, cols, rows }: { terminalId: string; sessionId: string; cols?: number; rows?: number }) => {
      const cwd = resolveCwd(sessionId);
      const { cmd, args } = getShell(process.platform, process.env['SHELL'], process.env['COMSPEC']);
      const size = clampPtySize(cols, rows);
      const entry: TerminalEntry = {
        sessionId,
        cwd,
        detectedPorts: new Map(),
        scrollback: new ScrollbackBuffer(scrollbackChars),
      };
      terminals.set(terminalId, entry);
      const ok = manager.spawnSession({
        id: terminalId,
        cmd,
        args,
        cwd,
        env: sanitizePtyEnv(process.env as Record<string, string | undefined>),
        cols: size.cols,
        rows: size.rows,
        onOutput: (data) => handleOutput(terminalId, data),
        onExit: (code) => {
          terminals.delete(terminalId);
          // The dev server is gone — links should disappear from the UI
          // rather than pointing at a dead process.
          entry.detectedPorts.clear();
          send.ports({ terminalId, ports: [] });
          send.exit({ terminalId, code });
          stopPortReaperIfIdle();
        },
      });
      if (!ok) {
        terminals.delete(terminalId);
        log.error('pty backend failed to spawn', { terminalId, backend: manager.backendName });
        return {};
      }
      log.info('started PTY', { terminalId, pid: manager.pidOf(terminalId), sessionId, cwd, backend: manager.backendName });
      return {};
    },

    terminalWrite: ({ terminalId, data }: { terminalId: string; data: string }) => {
      manager.write(terminalId, data);
      return {};
    },

    terminalResize: ({ terminalId, cols, rows }: { terminalId: string; cols: number; rows: number }) => {
      manager.resize(terminalId, cols, rows);
      return {};
    },

    /** Snapshot re-attach: flush the coalescer first (see file header), then
     *  return the buffered scrollback + output seq. `alive: false` means no
     *  PTY — the caller should spawn a fresh one. */
    terminalScrollback: ({ terminalId }: { terminalId: string }): TerminalScrollbackResult => {
      const entry = terminals.get(terminalId);
      if (!entry) return { alive: false };
      manager.flush(terminalId);
      const snap = entry.scrollback.snapshot();
      return { alive: true, data: snap.data, seq: snap.seq };
    },

    /** Stop the terminal's foreground process: Ctrl+C (\x03) twice (SIGINT
     *  reaches the foreground group, not the shell's), then escalate to a
     *  tree-kill after ~1.2s if it survives. The shell stays alive, so ports
     *  are cleared explicitly here. */
    terminalStop: ({ terminalId }: { terminalId: string }) => {
      clearPorts(terminalId);
      const pid = manager.pidOf(terminalId);
      manager.write(terminalId, '\x03');
      setTimeout(() => manager.write(terminalId, '\x03'), 200);
      setTimeout(() => {
        if (!pid || !isProcessAlive(pid)) return; // already gone — Ctrl+C worked
        log.info('stop: escalating to tree-kill', { terminalId, pid });
        if (process.platform === 'win32') {
          spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
            .on('error', () => { /* already dead */ });
        } else {
          // pgrep -P finds direct children of the shell; SIGKILL each. The
          // shell itself is left alive (only its descendants die).
          spawn('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' })
            .on('error', () => { /* already dead or pkill unavailable */ });
        }
      }, 1200);
      return {};
    },

    terminalKill: ({ terminalId }: { terminalId: string }) => {
      clearPorts(terminalId);
      manager.kill(terminalId);
      terminals.delete(terminalId);
      stopPortReaperIfIdle();
      return {};
    },

    terminalDispose: (_: Record<string, never>) => {
      for (const terminalId of [...terminals.keys()]) {
        clearPorts(terminalId);
        manager.kill(terminalId);
        terminals.delete(terminalId);
      }
      stopPortReaperIfIdle();
      return {};
    },

    terminalGetPid: ({ terminalId }: { terminalId: string }) => ({ pid: manager.pidOf(terminalId) }),

    processIsAlive: ({ pid }: { pid: number }) => ({ alive: isProcessAlive(pid) }),
  };
}

export type TerminalRpcHandlers = ReturnType<typeof registerTerminalRpc>;
