/** bash_output + kill_shell tools: manage background shell processes for long-running work (dev servers, watchers, build loops) — the synchronous bash tool can background a command and the model polls/kills it later via a shared in-process registry keyed by shell id. */

import { spawn, type ChildProcess } from 'child_process';
import { toolEnv, wrapWithShell, killProcessTree } from './tool-env';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveAndFollowSymlinks } from '../path-safety';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

interface BgShell {
  id: string;
  command: string;
  proc: ChildProcess;
  cwd: string;
  startedAt: number;
  /** Buffered stdout+stderr — capped at 256KB to bound memory. */
  buffer: string;
  /** Ring-buffer offset the caller has already read; advanced by bash_output. */
  readCursor: number;
  exited: boolean;
  exitCode: number | null;
}

const MAX_BUFFER = 256 * 1024;
const shells = new Map<string, BgShell>();

/** Spawn a command in the background, returning the shell id. Exported so
 *  the bash tool can delegate here when args.background is true. */
export function spawnBackground(id: string, command: string, cwd: string): void {
  if (shells.has(id)) {
    killBackground(id);
  }
  const wrapped = wrapWithShell(command);
  const proc = spawn(wrapped.command, wrapped.args, {
    cwd,
    env: toolEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shell: BgShell = {
    id, command, proc, cwd,
    startedAt: Date.now(),
    buffer: '', readCursor: 0,
    exited: false, exitCode: null,
  };
  const append = (chunk: Buffer | string) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    shell.buffer += s;
    if (shell.buffer.length > MAX_BUFFER) {
      // Drop the oldest portion and shift the cursor so the next read picks up correctly.
      const excess = shell.buffer.length - MAX_BUFFER;
      shell.buffer = shell.buffer.slice(excess);
      shell.readCursor = Math.max(0, shell.readCursor - excess);
    }
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  proc.on('exit', (code) => {
    shell.exited = true;
    shell.exitCode = code;
  });
  proc.on('error', (err) => {
    append(`\n[spawn error: ${err.message}]`);
    shell.exited = true;
    shell.exitCode = -1;
  });
  shells.set(id, shell);
}

function killBackground(id: string): boolean {
  const shell = shells.get(id);
  if (!shell) return false;
  try {
    if (!shell.exited) killProcessTree(shell.proc.pid);
  } catch {
    // already dead
  }
  shells.delete(id);
  return true;
}

// ─── Shared bodies ─────────────────────────────────────────────────────
// Neither reads ctx — both address the in-process shell registry by id.

export async function runBashOutput(shellId: string): Promise<ToolResult> {
  if (!shellId) return { status: 'failed', output: 'Missing required arg: shell_id' };
  const shell = shells.get(shellId);
  if (!shell) {
    return { status: 'failed', output: `Unknown shell_id: ${shellId}. It may have been killed or never started.` };
  }
  const newOutput = shell.buffer.slice(shell.readCursor);
  shell.readCursor = shell.buffer.length;
  const status = shell.exited ? `exited (code ${shell.exitCode})` : 'running';
  const trimmed = newOutput.length > MAX_BUFFER
    ? newOutput.slice(newOutput.length - MAX_BUFFER) + `\n[…output truncated at ${MAX_BUFFER} bytes]`
    : newOutput;
  return {
    status: 'executed',
    output: trimmed || '(no new output)',
    meta: `${status} · ${trimmed.length} bytes`,
  };
}

export async function runKillShell(shellId: string): Promise<ToolResult> {
  if (!shellId) return { status: 'failed', output: 'Missing required arg: shell_id' };
  const killed = killBackground(shellId);
  if (!killed) {
    return { status: 'failed', output: `Unknown shell_id: ${shellId}. Nothing to kill.` };
  }
  return {
    status: 'executed',
    output: `Killed shell ${shellId}.`,
    meta: 'killed',
  };
}

// ─── Legacy envelopes ─────────────────────────────────────────────────

export const bashOutputTool: ToolRegistration = {
  name: 'bash_output',
  definition: {
    name: 'bash_output',
    description:
      'Read new output from a backgrounded bash shell since the last read. Use after ' +
      'starting a long-running command (e.g. a dev server) via bash with background:true. ' +
      'Returns the incremental stdout+stderr. The shell keeps running; call kill_shell ' +
      'to stop it.',
    input_schema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'The background shell id returned by bash.' },
      },
      required: ['shell_id'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 3_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, _ctx) => runBashOutput(String(args.shell_id ?? '')),
};

export const killShellTool: ToolRegistration = {
  name: 'kill_shell',
  definition: {
    name: 'kill_shell',
    description:
      'Kill a backgrounded bash shell by id. Use when a long-running command (dev server, ' +
      'watcher, etc.) is no longer needed. Sends SIGTERM.',
    input_schema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'The background shell id to kill.' },
      },
      required: ['shell_id'],
    },
  },
  riskTier: 'write', // terminating a process the user may have wanted
  requiresWorktree: false,
  timeoutMs: 3_000,
  autoApproveIn: ['edit', 'full'],
  execute: async (args, _ctx) => runKillShell(String(args.shell_id ?? '')),
};

// ─── SDK factories (Phase 2) ──────────────────────────────────────────

export function createBashOutputTool(ctx: ToolContext) {
  return tool({
    description:
      'Read new output from a backgrounded bash shell since the last read. Use after ' +
      'starting a long-running command (e.g. a dev server) via bash with background:true. ' +
      'Returns the incremental stdout+stderr. The shell keeps running; call kill_shell ' +
      'to stop it.',
    inputSchema: z.object({
      shell_id: z.string().describe('The background shell id returned by bash.'),
    }),
    execute: async ({ shell_id }) =>
      withPermission(ctx, 'bash_output', { shell_id }, () => runBashOutput(shell_id)),
  });
}

export function createKillShellTool(ctx: ToolContext) {
  return tool({
    description:
      'Kill a backgrounded bash shell by id. Use when a long-running command (dev server, ' +
      'watcher, etc.) is no longer needed. Sends SIGTERM.',
    inputSchema: z.object({
      shell_id: z.string().describe('The background shell id to kill.'),
    }),
    execute: async ({ shell_id }) =>
      withPermission(ctx, 'kill_shell', { shell_id }, () => runKillShell(shell_id)),
  });
}

/** Resolve cwd safely — used by the bash tool when delegating to background. */
export function safeCwd(workspaceRoot: string, relPath?: string): string {
  if (!relPath) return workspaceRoot;
  try {
    return resolveAndFollowSymlinks(workspaceRoot, relPath);
  } catch {
    return workspaceRoot;
  }
}
