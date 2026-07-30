/**
 * git tool — restricted git operations.
 *
 * Allows the read-only inspection subset (status, diff, log, show, branch,
 * ls-files, blame) plus the safe write operations (commit on the current
 * branch). Refuses anything that touches remotes (push, fetch, pull) or
 * that rewrites history (reset --hard, rebase, force-push).
 *
 * Worktree note: without §6 isolation, all git ops target the user's real
 * repo. The permission gate forces `ask` for this tool regardless of mode.
 */

import { spawn } from 'child_process';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../path-safety';
import { getToolMeta } from './tool-meta';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

const MAX_OUTPUT = 50 * 1024;

/** Whitelisted subcommands. Value = allowed flag patterns (regex); null = any flags. */
const ALLOWED_SUBCOMMANDS: Record<string, RegExp | null> = {
  status: null,
  diff: null,
  log: null,
  show: null,
  branch: null,
  'ls-files': null,
  blame: null,
  shortlog: null,
  describe: null,
  remote: /^(-v|--verbose)$/,
  'rev-parse': /^(-\S+|\S+)$/,
  commit: /^(-m\s|--message=?.*|-a|--all|-s|--signoff|--amend.*)$/,
};

/** Hard-refused subcommands regardless of mode (mutation of shared state). */
const ALWAYS_BLOCKED = new Set([
  'push', 'pull', 'fetch', 'reset', 'rebase', 'cherry-pick', 'revert',
  'merge', 'init', 'clone', 'mv', 'rm', 'clean', 'reflog', 'gc',
  'stash', 'submodule', 'config', 'tag', 'worktree', 'update-ref',
]);

/** Shared body — needs workspaceRoot (cwd) + timeoutMs (spawn timeout). */
export async function runGit(
  argv: string[],
  workspaceRoot: string,
  timeoutMs: number,
): Promise<ToolResult> {
  if (argv.length === 0) return { status: 'failed', output: 'Missing required arg: args' };

  let cwd: string;
  try {
    cwd = resolveInsideWorkspace(workspaceRoot, '.');
  } catch (e: any) {
    return { status: 'failed', output: `Workspace error: ${e.message}` };
  }

  const sub = argv[0];
  if (ALWAYS_BLOCKED.has(sub)) {
    return {
      status: 'rejected',
      output: `Refused: "git ${sub}" mutates shared state or rewrites history. Not allowed.`,
    };
  }
  if (!(sub in ALLOWED_SUBCOMMANDS)) {
    const allowed = Object.keys(ALLOWED_SUBCOMMANDS).sort().join(', ');
    return {
      status: 'rejected',
      output: `Refused: "git ${sub}" is not on the allowlist. Allowed: ${allowed}.`,
    };
  }
  const flagRule = ALLOWED_SUBCOMMANDS[sub];
  if (flagRule) {
    for (const f of argv.slice(1)) {
      if (!flagRule.test(f)) {
        return {
          status: 'rejected',
          output: `Refused: flag "${f}" not allowed with "git ${sub}".`,
        };
      }
    }
  }

  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('git', argv, {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* dead */ }
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length >= MAX_OUTPUT) return;
      stdout += d.toString('utf-8').slice(0, MAX_OUTPUT - stdout.length);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length >= MAX_OUTPUT) return;
      stderr += d.toString('utf-8').slice(0, MAX_OUTPUT - stderr.length);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const dur = Date.now() - start;
      if (killed) {
        resolve({
          status: 'timeout',
          output: `git ${argv.join(' ')} timed out after ${timeoutMs}ms.`,
          durationMs: dur,
        });
        return;
      }
      const out = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
      const status = code === 0 ? 'executed' : 'failed';
      resolve({
        status,
        output: out || `(no output, exit ${code})`,
        meta: `exit ${code ?? '?'} · ${dur}ms`,
        durationMs: dur,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: 'failed', output: `Spawn error: ${e.message}` });
    });
  });
}

export const gitTool: ToolRegistration = {
  name: 'git',
  definition: {
    name: 'git',
    description:
      'Run a restricted git subcommand in the workspace. Allowed: status, diff, ' +
      'log, show, branch, ls-files, blame, describe, remote -v, rev-parse, commit. ' +
      'Forbidden: anything that touches remotes (push/pull/fetch) or rewrites ' +
      'history (reset --hard, rebase). Pass args as an array of strings.',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subcommand + flags, e.g. ["status", "--short"] or ["log", "-n", "5"].',
        },
      },
      required: ['args'],
    },
  },
  riskTier: 'destructive',
  requiresWorktree: false,
  timeoutMs: 15_000,
  autoApproveIn: ['full'],
  execute: async (args, ctx) =>
    runGit(Array.isArray(args.args) ? (args.args as string[]) : [], ctx.workspaceRoot, ctx.timeoutMs),
};

// ─── SDK factory (Phase 2) ─────────────────────────────────────────────
// git is destructive tier → withPermission auto-approves only in 'full',
// prompts in ask/edit, requests plan→edit escalation. Same gate as bash.

export function createGitTool(ctx: ToolContext) {
  return tool({
    description:
      'Run a restricted git subcommand in the workspace. Allowed: status, diff, ' +
      'log, show, branch, ls-files, blame, describe, remote -v, rev-parse, commit. ' +
      'Forbidden: anything that touches remotes (push/pull/fetch) or rewrites ' +
      'history (reset --hard, rebase). Pass args as an array of strings.',
    inputSchema: z.object({
      args: z.array(z.string()).describe('Subcommand + flags, e.g. ["status", "--short"] or ["log", "-n", "5"].'),
    }),
    execute: async ({ args }) =>
      withPermission(ctx, 'git', { args }, () =>
        runGit(args, ctx.workspaceRoot, getToolMeta('git').timeoutMs),
      ),
  });
}
