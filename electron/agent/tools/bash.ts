/** bash tool: shell execution in the workspace root with full operator support. Bounded by the autonomy-mode permission gate (riskTier 'destructive') plus a hard blocklist for catastrophic patterns. Output capped at 50KB / 1000 lines. Exports both legacy `bashTool` and new `createBashTool(ctx)` sharing one `runBash` body. */

import { spawn } from 'child_process';
import { toolEnv, wrapWithShell, killProcessTree } from './tool-env';
import { tool } from 'ai';
import { z } from 'zod';
import type { ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { getToolMeta } from './tool-meta';
import { withPermission } from '../permission-wrapper';

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

/** Shared execute body — parameterized so both envelopes can call it. */
export async function runBash(
  command: string,
  workspaceRoot: string,
  timeoutMs: number,
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

    // Early timeout for commands that are likely stuck (no output after 15s
    // AND the command is not a known long-runner). Prevents a hung `npm
    // install` or network fetch from blocking the agent for 2 minutes.
    const earlyKill = setTimeout(() => {
      if (killed) return;
      if (stdout.length === 0 && stderr.length === 0) {
        killed = true;
        killProcessTree(child.pid, 'SIGTERM');
        if (!isWin) setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 500);
      }
    }, 15_000);

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
      '(read_file, grep, glob) when they fit; use bash when they do not.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
      },
      required: ['command'],
    },
  },
  riskTier: 'destructive',
  requiresWorktree: false,
  timeoutMs: 60_000,
  autoApproveIn: ['full'],
  execute: async (args, ctx) => runBash(String(args.command ?? ''), ctx.workspaceRoot, ctx.timeoutMs),
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
      '(read_file, grep, glob) when they fit; use bash when they do not.',
    inputSchema: z.object({
      command: z.string().describe('Shell command to run.'),
    }),
    execute: async ({ command }) =>
      withPermission(ctx, 'bash', { command }, () =>
        runBash(command, ctx.workspaceRoot, getToolMeta('bash').timeoutMs),
      ),
  });
}
