/**
 * Workspace script execution — spawns real child processes for setup, run,
 * and cleanup scripts. Streams stdout/stderr to the renderer and detects
 * ports from output for the dev-server badge feature.
 *
 * Process lifecycle:
 *   tide:script:run   → spawn, track in Map, stream output, detect ports
 *   tide:script:stop  → kill by workspace+command key
 *
 * Events (main → renderer):
 *   script:output  → { workspaceId, command, stream: 'stdout'|'stderr', line }
 *   script:exit    → { workspaceId, command, code }
 *   script:ports   → { workspaceId, ports: [{ port, label, url }] }
 *   script:lines   → { workspaceId, lines: TerminalLine[] } (bulk buffer read)
 */

import { ipcMain, WebContents } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as store from '../store.js';
import { createLogger } from '../logger.js';

const log = createLogger('script');

export interface ScriptOutputEvent {
  workspaceId: string;
  command: string;
  stream: 'stdout' | 'stderr' | 'info';
  line: string;
}

export interface ScriptExitEvent {
  workspaceId: string;
  command: string;
  code: number | null;
}

export interface ScriptPortEvent {
  workspaceId: string;
  ports: { port: number; label: string; url: string }[];
}

export interface TerminalLine {
  prompt?: boolean;
  cwd?: string;
  cmd?: string;
  text?: string;
  dim?: boolean;
  ok?: boolean;
  warn?: boolean;
  accent?: boolean;
}

interface RunningProc {
  proc: ChildProcess;
  workspaceId: string;
  command: string;
  cwd: string;
  outputBuffer: TerminalLine[];
  detectedPorts: Set<number>;
}

// Key: `${workspaceId}:${command}`
const runningProcs = new Map<string, RunningProc>();

// Active webContents for sending events (set on first run).
let activeWc: WebContents | null = null;

function procKey(workspaceId: string, command: string): string {
  return `${workspaceId}:${command}`;
}

/** Regex to detect port numbers in dev-server output. */
const PORT_PATTERNS = [
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})\b/i,
  /\bport\s+(\d{2,5})\b/i,
  /\blistening\s+(?:on\s+)?(?:port\s+)?(\d{2,5})\b/i,
  /\bready\s+(?:on\s+)?(?:port\s+)?(\d{2,5})\b/i,
  /\bstarted\s+(?:on\s+)?(?:port\s+)?(\d{2,5})\b/i,
];

function detectPorts(text: string): number[] {
  const found = new Set<number>();
  for (const re of PORT_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const port = parseInt(m[1], 10);
      // Sanity: valid TCP port range, likely a dev server (not SSH, DNS, etc.)
      if (port >= 1024 && port <= 65535) found.add(port);
    }
  }
  return Array.from(found);
}

function pushLine(proc: RunningProc, line: TerminalLine) {
  proc.outputBuffer.push(line);
  // Cap buffer at 500 lines to avoid memory growth.
  if (proc.outputBuffer.length > 500) {
    proc.outputBuffer.splice(0, proc.outputBuffer.length - 500);
  }
}

function emit(wc: WebContents | null, channel: string, data: unknown) {
  if (!wc) return;
  wc.send(channel, data);
}

/**
 * Resolve the workspace root path for a given workspaceId.
 */
function resolveWorkspacePath(workspaceId: string): string | null {
  const workspaces = store.listWorkspaces();
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  // Expand ~ if needed.
  let p = ws.path;
  if (p.startsWith('~/')) {
    p = path.join(process.env.HOME || process.env.USERPROFILE || '~', p.slice(2));
  }
  return p;
}

/**
 * Resolve the shell command. Supports simple `npm run X` / `yarn X` / `node X.js`
 * commands. For anything more complex, the command runs via `sh -c`.
 */
function spawnCommand(command: string, cwd: string): ChildProcess {
  // Use sh -c so pipes, &&, env vars etc. work. On macOS the default shell is zsh.
  const shell = process.env.SHELL || '/bin/sh';
  return spawn(shell, ['-c', command], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '1', CI: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function registerScriptHandlers() {
  // ── Run a script ──────────────────────────────────────────────
  ipcMain.handle(
    'tide:script:run',
    async (e, payload: { workspaceId: string; command: string }) => {
      activeWc = e.sender;
      const { workspaceId, command } = payload;
      const key = procKey(workspaceId, command);

      // Already running?
      if (runningProcs.has(key)) {
        return { ok: false, reason: 'already running' };
      }

      const cwd = resolveWorkspacePath(workspaceId);
      if (!cwd) {
        return { ok: false, reason: 'workspace not found' };
      }
      if (!fs.existsSync(cwd)) {
        return { ok: false, reason: `directory does not exist: ${cwd}` };
      }

      try {
        const proc = spawnCommand(command, cwd);
        const entry: RunningProc = {
          proc,
          workspaceId,
          command,
          cwd,
          outputBuffer: [],
          detectedPorts: new Set<number>(),
        };

        // Intro line: `$ command`
        const intro: TerminalLine = { prompt: true, cwd, cmd: command };
        pushLine(entry, intro);
        emit(activeWc, 'script:output', {
          workspaceId, command, stream: 'info', line: `$ ${command}`,
        } satisfies ScriptOutputEvent);

        // stdout
        proc.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8');
          for (const line of text.split('\n')) {
            if (!line) continue;
            const tl: TerminalLine = { text: line };
            pushLine(entry, tl);
            emit(activeWc, 'script:output', {
              workspaceId, command, stream: 'stdout', line,
            } satisfies ScriptOutputEvent);
          }
          // Check for ports.
          const ports = detectPorts(text);
          for (const p of ports) {
            if (!entry.detectedPorts.has(p)) {
              entry.detectedPorts.add(p);
              log.info('port detected', { workspace: workspaceId, command, port: p, url: `http://localhost:${p}` });
              const portList = Array.from(entry.detectedPorts).map((port) => ({
                port,
                label: command,
                url: `http://localhost:${port}`,
              }));
              emit(activeWc, 'script:ports', {
                workspaceId, ports: portList,
              } satisfies ScriptPortEvent);
            }
          }
        });

        // stderr — many dev servers log to stderr.
        proc.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8');
          for (const line of text.split('\n')) {
            if (!line) continue;
            const tl: TerminalLine = { text: line, dim: true };
            pushLine(entry, tl);
            emit(activeWc, 'script:output', {
              workspaceId, command, stream: 'stderr', line,
            } satisfies ScriptOutputEvent);
          }
          // Check for ports in stderr too (some servers log there).
          const ports = detectPorts(text);
          for (const p of ports) {
            if (!entry.detectedPorts.has(p)) {
              entry.detectedPorts.add(p);
              const portList = Array.from(entry.detectedPorts).map((port) => ({
                port,
                label: command,
                url: `http://localhost:${port}`,
              }));
              emit(activeWc, 'script:ports', {
                workspaceId, ports: portList,
              } satisfies ScriptPortEvent);
            }
          }
        });

        // Exit
        proc.on('close', (code) => {
          log.info('script exited', { workspace: workspaceId, command, code });
          const exitLine: TerminalLine = {
            text: `[exited with code ${code}]`,
            dim: true,
            ...(code === 0 ? { ok: true } : { warn: true }),
          };
          pushLine(entry, exitLine);
          emit(activeWc, 'script:exit', {
            workspaceId, command, code,
          } satisfies ScriptExitEvent);
          emit(activeWc, 'script:output', {
            workspaceId, command, stream: 'info',
            line: code === 0 ? `[done]` : `[failed — exit ${code}]`,
          } satisfies ScriptOutputEvent);
          runningProcs.delete(key);
        });

        proc.on('error', (err) => {
          log.error('script process error', { workspace: workspaceId, command, error: err.message });
          const errLine: TerminalLine = { text: `[error: ${err.message}]`, warn: true };
          pushLine(entry, errLine);
          emit(activeWc, 'script:output', {
            workspaceId, command, stream: 'stderr', line: `[error: ${err.message}]`,
          } satisfies ScriptOutputEvent);
          runningProcs.delete(key);
        });

        runningProcs.set(key, entry);
        log.info('script started', { workspace: workspaceId, command, pid: proc.pid });
        return { ok: true, pid: proc.pid };
      } catch (err: any) {
        log.error('script spawn failed', { workspace: workspaceId, command, error: err?.message ?? 'spawn failed' });
        return { ok: false, reason: err?.message ?? 'spawn failed' };
      }
    },
  );

  // ── Stop a script ─────────────────────────────────────────────
  ipcMain.handle(
    'tide:script:stop',
    async (_e, payload: { workspaceId: string; command: string }) => {
      const key = procKey(payload.workspaceId, payload.command);
      const entry = runningProcs.get(key);
      if (!entry) return { ok: false, reason: 'not running' };
      try {
        log.info('stopping script', { workspace: payload.workspaceId, command: payload.command, pid: entry.proc.pid });
        entry.proc.kill('SIGTERM');
        // Force-kill after 3s if still alive.
        setTimeout(() => {
          if (!entry.proc.killed) {
            try { entry.proc.kill('SIGKILL'); } catch { /* already dead */ }
          }
        }, 3000);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'kill failed' };
      }
    },
  );

  // ── Get buffered terminal output for a workspace ──────────────
  ipcMain.handle(
    'tide:getScriptLines',
    async (_e, workspaceId: string) => {
      const lines: TerminalLine[] = [];
      for (const entry of runningProcs.values()) {
        if (entry.workspaceId === workspaceId) {
          lines.push(...entry.outputBuffer);
        }
      }
      return lines;
    },
  );

  // ── Get detected ports for a workspace ────────────────────────
  ipcMain.handle(
    'tide:getScriptPorts',
    async (_e, workspaceId: string) => {
      const ports: { port: number; label: string; url: string }[] = [];
      for (const entry of runningProcs.values()) {
        if (entry.workspaceId === workspaceId) {
          for (const port of entry.detectedPorts) {
            ports.push({ port, label: entry.command, url: `http://localhost:${port}` });
          }
        }
      }
      return ports;
    },
  );
}

/**
 * Kill all running processes for a workspace — called when the workspace
 * is removed or the app quits.
 */
export function killWorkspaceScripts(workspaceId: string): void {
  for (const [key, entry] of runningProcs.entries()) {
    if (entry.workspaceId === workspaceId) {
      try { entry.proc.kill('SIGTERM'); } catch { /* dead */ }
      runningProcs.delete(key);
    }
  }
}

/** Kill ALL running script processes — called on app quit. */
export function killAllScripts(): void {
  for (const [, entry] of runningProcs.entries()) {
    try { entry.proc.kill('SIGTERM'); } catch { /* dead */ }
  }
  runningProcs.clear();
}
