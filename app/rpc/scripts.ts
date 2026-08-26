/** Scripts RPC — port of electron/ipc/scripts.ts (tide:script:run / stop /
 * getScriptLines / getScriptPorts). Spawns workspace scripts through the
 * platform-aware shell wrapper, streams stdout/stderr lines and detected
 * dev-server ports via the scriptOutput/scriptExit/scriptPorts messages
 * (payload shapes match the Electron script:* channels verbatim). */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { wrapWithShell, toolEnv, killProcessTree } from '../core/agent/tools/tool-env';
import { createLogger } from '../core/logger.js';
import type {
  ScriptExitEvent,
  ScriptOutputEvent,
  ScriptPort,
  ScriptPortsEvent,
  ScriptRunResult,
  ScriptTerminalLine,
} from '../../shared/rpc';

const log = createLogger('scripts-rpc');

interface RunningProc {
  proc: ChildProcess;
  workspaceId: string;
  command: string;
  cwd: string | null;
  outputBuffer: ScriptTerminalLine[];
  detectedPorts: Set<number>;
}

// Key: `${workspaceId}:${command}`
const runningProcs = new Map<string, RunningProc>();

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

export function detectPorts(text: string): number[] {
  const found = new Set<number>();
  for (const re of PORT_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const port = parseInt(m[1], 10);
      if (port >= 1024 && port <= 65535) found.add(port);
    }
  }
  return Array.from(found);
}

export interface ScriptsRpcEvents {
  output: (e: ScriptOutputEvent) => void;
  exit: (e: ScriptExitEvent) => void;
  ports: (e: ScriptPortsEvent) => void;
}

export interface ScriptsRpcOpts {
  events: ScriptsRpcEvents;
  /** Resolve a workspaceId to its on-disk root (tests inject temp dirs). */
  workspacePathOf?: (workspaceId: string) => string | null;
  /** Spawn seam — production uses the shell-wrapped spawn; tests stub it. */
  spawnCommand?: (command: string, cwd: string) => ChildProcess;
}

export function registerScriptsRpc(opts: ScriptsRpcOpts) {
  const { output, exit, ports: portsOut } = opts.events;
  const workspacePathOf =
    opts.workspacePathOf ?? (() => null);
  const spawnCommand =
    opts.spawnCommand ??
    ((command: string, cwd: string) => {
      const wrapped = wrapWithShell(command);
      const env = toolEnv({ FORCE_COLOR: '1' });
      delete env.CI;
      return spawn(wrapped.command, wrapped.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    });

  const pushLine = (proc: RunningProc, line: ScriptTerminalLine) => {
    proc.outputBuffer.push(line);
    if (proc.outputBuffer.length > 500) {
      proc.outputBuffer.splice(0, proc.outputBuffer.length - 500);
    }
  };

  const reportPorts = (entry: RunningProc, newlyDetected: number[]) => {
    for (const p of newlyDetected) {
      if (!entry.detectedPorts.has(p)) {
        entry.detectedPorts.add(p);
        const portList: ScriptPort[] = Array.from(entry.detectedPorts).map((port) => ({
          port,
          label: entry.command,
          url: `http://localhost:${port}`,
        }));
        portsOut({ workspaceId: entry.workspaceId, ports: portList });
      }
    }
  };

  return {
    scriptRun: ({ workspaceId, command }: { workspaceId: string; command: string }): ScriptRunResult => {
      const key = procKey(workspaceId, command);

      if (runningProcs.has(key)) {
        return { ok: false, reason: 'already running' };
      }

      const cwd = workspacePathOf(workspaceId);
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

        pushLine(entry, { prompt: true, cwd, cmd: command });
        output({ workspaceId, command, stream: 'info', line: `$ ${command}` });

        proc.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8');
          for (const line of text.split('\n')) {
            if (!line) continue;
            pushLine(entry, { text: line });
            output({ workspaceId, command, stream: 'stdout', line });
          }
          reportPorts(entry, detectPorts(text));
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8');
          for (const line of text.split('\n')) {
            if (!line) continue;
            pushLine(entry, { text: line, dim: true });
            output({ workspaceId, command, stream: 'stderr', line });
          }
          reportPorts(entry, detectPorts(text));
        });

        proc.on('close', (code) => {
          log.info('script exited', { workspace: workspaceId, command, code });
          pushLine(entry, {
            text: `[exited with code ${code}]`,
            dim: true,
            ...(code === 0 ? { ok: true } : { warn: true }),
          });
          exit({ workspaceId, command, code });
          output({
            workspaceId,
            command,
            stream: 'info',
            line: code === 0 ? `[done]` : `[failed — exit ${code}]`,
          });
          runningProcs.delete(key);
        });

        proc.on('error', (err) => {
          log.error('script process error', { workspace: workspaceId, command, error: err.message });
          pushLine(entry, { text: `[error: ${err.message}]`, warn: true });
          output({ workspaceId, command, stream: 'stderr', line: `[error: ${err.message}]` });
          runningProcs.delete(key);
        });

        runningProcs.set(key, entry);
        log.info('script started', { workspace: workspaceId, command, pid: proc.pid });
        return { ok: true, pid: proc.pid };
      } catch (err) {
        log.error('script spawn failed', { workspace: workspaceId, command, error: err instanceof Error ? err.message : 'spawn failed' });
        return { ok: false, reason: err instanceof Error ? err.message : 'spawn failed' };
      }
    },

    scriptStop: ({ workspaceId, command }: { workspaceId: string; command: string }) => {
      const key = procKey(workspaceId, command);
      const entry = runningProcs.get(key);
      if (!entry) return { ok: false, reason: 'not running' };
      try {
        log.info('stopping script', { workspace: workspaceId, command, pid: entry.proc.pid });
        killProcessTree(entry.proc.pid);
        // Force-kill after 3s if still alive (Unix only — Windows taskkill is
        // already forceful).
        setTimeout(() => {
          if (!entry.proc.killed && process.platform !== 'win32') {
            killProcessTree(entry.proc.pid, 'SIGKILL');
          }
        }, 3000);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'kill failed' };
      }
    },

    scriptLines: ({ workspaceId }: { workspaceId: string }) => {
      const lines: ScriptTerminalLine[] = [];
      for (const entry of runningProcs.values()) {
        if (entry.workspaceId === workspaceId) {
          lines.push(...entry.outputBuffer);
        }
      }
      return { lines };
    },

    scriptPorts: ({ workspaceId }: { workspaceId: string }) => {
      const ports: ScriptPort[] = [];
      for (const entry of runningProcs.values()) {
        if (entry.workspaceId === workspaceId) {
          for (const port of entry.detectedPorts) {
            ports.push({ port, label: entry.command, url: `http://localhost:${port}` });
          }
        }
      }
      return { ports };
    },
  };
}

/** Kill all running script processes for a workspace — called when the
 *  workspace is removed. */
export function killWorkspaceScripts(workspaceId: string): void {
  for (const [key, entry] of runningProcs.entries()) {
    if (entry.workspaceId === workspaceId) {
      try { killProcessTree(entry.proc.pid); } catch { /* dead */ }
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
