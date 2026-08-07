/** bash tool: shell execution in the workspace root with full operator support. Supports background mode for long-running processes (dev servers, watchers). Bounded by the autonomy-mode permission gate (riskTier 'destructive') plus a hard blocklist for catastrophic patterns. Output capped at 50KB / 1000 lines. */

import { spawn } from 'child_process';
import { toolEnv, wrapWithShell, killProcessTree } from './tool-env';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { getToolMeta } from './tool-meta';
import { withPermission } from '../permission-wrapper';
import { spawnBackground, safeCwd } from './background-shell';

const MAX_OUTPUT = 50 * 1024;
const MAX_LINES = 1000;

/** Hard blocklist: catastrophic/irreversible patterns (rm -rf /, sudo, fork bombs, etc.), matched case-insensitively against the raw command. */
const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f?|--recursive)\s+([-~./]|\/(?:usr|etc|var|bin|sbin|System|Library|Users|home|root|boot|dev|proc|sys)\b)/i,
  /\brm\s+(-[a-z]*r[a-z]*f?|--recursive)\s+\/$/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bchmod\s+-R\s+[0-7]{3,4}\s+\//i,
  /\bchown\s+-R\b/i,
  />\s*\/dev\/(sda|hda|nvme|disk)/i,
];

function blockedReason(command: string): string | null {
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(command)) {
      return `Refused: command matches a blocked pattern (catastrophic / irreversible operation).`;
    }
  }
  return null;
}

/** Shared execute body — parameterized so both envelopes can call it. When background is true, spawns via spawnBackground and returns immediately. */
export async function runBash(
  command: string,
  workspaceRoot: string,
  timeoutMs: number,
  background?: boolean,
): Promise<{
  status: 'executed' | 'failed' | 'rejected' | 'timeout';
  output: string;
  meta?: string;
  durationMs?: number;
  display?: { kind: 'command'; command: string };
}> {
  const trimmed = command.trim();
  if (!trimmed) return { status: 'failed', output: 'Missing required arg: command' };

  const blocked = blockedReason(trimmed);
  if (blocked) return { status: 'rejected', output: blocked };

  // Background mode: spawn in the process registry, return immediately with the shell id.
  // The model polls output via bash_output and stops it via kill_shell.
  if (background) {
    const id = `sh_${Math.random().toString(36).slice(2, 8)}`;
    spawnBackground(id, trimmed, safeCwd(workspaceRoot));
    return {
      status: 'executed',
      output: `Backgrounded as ${id}. Use bash_output({ shell_id: "${id}" }) to read new output, kill_shell({ shell_id: "${id}" }) to stop it.`,
      meta: 'backgrounded',
      display: { kind: 'command', command: trimmed },
    };
  }

  // Platform-aware shell wrapping: Unix uses $SHELL -l -c (resolves nvm/fnm),
  // Windows uses cmd.exe /c. toolEnv() augments PATH for GUI app context.
  const wrapped = wrapWithShell(trimmed);
  const isWin = process.platform === 'win32';

  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: workspaceRoot,
      env: toolEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin, // Unix only — Windows doesn't support process groups
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child.pid, 'SIGTERM');
      if (!isWin) setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 500);
    }, timeoutMs);

    // Early timeout for commands that are likely stuck (no output after 60s
    // AND the command is not a known long-runner). Package managers (npm,
    // pnpm, yarn, pip, cargo, bun) can go silent for 30s+ while resolving.
    const LONG_RUNNERS = /\b(npm|npx|pnpm|yarn|pnpx|pip|pip3|uv|poetry|cargo|go\s+mod|bun|brew|apt|dnf|gem\s+install)\b/;
    const earlyKillAfter = LONG_RUNNERS.test(trimmed) ? 120_000 : 60_000;
    const earlyKill = setTimeout(() => {
      if (killed) return;
      if (stdout.length === 0 && stderr.length === 0) {
        killed = true;
        killProcessTree(child.pid, 'SIGTERM');
        if (!isWin) setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 500);
      }
    }, earlyKillAfter);

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length >= MAX_OUTPUT) { truncated = true; return; }
      stdout += d.toString('utf-8').slice(0, MAX_OUTPUT - stdout.length);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length >= MAX_OUTPUT) { truncated = true; return; }
      stderr += d.toString('utf-8').slice(0, MAX_OUTPUT - stderr.length);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(earlyKill);
      const dur = Date.now() - start;

      const trimToLines = (s: string) => {
        const lines = s.split('\n');
        if (lines.length <= MAX_LINES) return s;
        return lines.slice(0, MAX_LINES).join('\n') + `\n... (${lines.length - MAX_LINES} more lines)`;
      };
      stdout = trimToLines(stdout);
      stderr = trimToLines(stderr);

      if (killed) {
        resolve({
          status: 'timeout',
          output: `Command timed out after ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          durationMs: dur,
          display: { kind: 'command', command: trimmed },
        });
        return;
      }

      const out = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
      const note = truncated ? ' (output truncated)' : '';
      const status = code === 0 ? 'executed' : 'failed';
      resolve({
        status,
        output: out + note,
        meta: `exit ${code ?? '?'} · ${dur}ms${note}`,
        durationMs: dur,
        display: { kind: 'command', command: trimmed },
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: 'failed', output: `Spawn error: ${e.message}` });
    });
  });
}

// ─── Legacy envelope (deleted in Phase 3) ──────────────────────────────

export const bashTool: ToolRegistration = {
  name: 'bash',
  definition: {
    name: 'bash',
    description:
      'Run a shell command in the workspace root. Supports the full shell: ' +
      'pipes (|), redirects (> >> 2>&1), chaining (&& ||), and any binary on PATH. ' +
      'Use for builds, tests, linters, installs, git operations, and ad-hoc ' +
      'inspection. Output is capped at 50KB / 1000 lines. Avoid destructive ' +
      'system commands — they are blocked. Prefer the dedicated tools ' +
      '(read_file, grep, glob) when they fit; use bash when they do not. ' +
      'For long-running commands (dev servers, watchers), set background:true ' +
      'to spawn in the background — the command returns immediately with a ' +
      'shell_id; poll output via bash_output, stop via kill_shell.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        background: { type: 'boolean', description: 'If true, spawn in the background and return a shell_id immediately. Use bash_output to poll and kill_shell to stop.', default: false },
      },
      required: ['command'],
    },
  },
  riskTier: 'destructive',
  requiresWorktree: false,
  timeoutMs: 500_000,
  autoApproveIn: ['full'],
  execute: async (args, ctx) => runBash(String(args.command ?? ''), ctx.workspaceRoot, ctx.timeoutMs, args.background === true),
};

// ─── New SDK factory envelope (Phase 3+) ───────────────────────────────
// Permission gating is applied here inside execute via withPermission (not at the orchestrator layer); bash auto-approves only in 'full' mode.

export function createBashTool(ctx: ToolContext) {
  return tool({
    description:
      'Run a shell command in the workspace root. Supports the full shell: ' +
      'pipes (|), redirects (> >> 2>&1), chaining (&& ||), and any binary on PATH. ' +
      'Use for builds, tests, linters, installs, git operations, and ad-hoc ' +
      'inspection. Output is capped at 50KB / 1000 lines. Avoid destructive ' +
      'system commands — they are blocked. Prefer the dedicated tools ' +
      '(read_file, grep, glob) when they fit; use bash when they do not. ' +
      'For long-running commands (dev servers, watchers), set background:true ' +
      'to spawn in the background — the command returns immediately with a ' +
      'shell_id; poll output via bash_output, stop via kill_shell.',
    inputSchema: z.object({
      command: z.string().describe('Shell command to run.'),
      background: z.boolean().optional().describe('If true, spawn in the background and return a shell_id immediately. Use bash_output to poll and kill_shell to stop.'),
    }),
    execute: async ({ command, background }) =>
      withPermission(ctx, 'bash', { command, background }, () =>
        runBash(command, ctx.workspaceRoot, getToolMeta('bash').timeoutMs, background === true),
      ),
  });
}
