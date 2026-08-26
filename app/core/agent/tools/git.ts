/** git tool: all git subcommands allowed. The permission gate (riskTier: destructive → ask/full only) is the safety layer, not a command allowlist. */

import { spawn } from 'child_process';
import { toolEnv, killProcessTree } from './tool-env';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../path-safety';
import { getToolMeta } from './tool-meta';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';

const MAX_OUTPUT = 50 * 1024;

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

  // Co-authored-by trailer is handled by the prepare-commit-msg git hook
  // managed by git-coauthor.ts — works for every commit path (agent tool,
  // bash, UI panel, external terminal).
  let effectiveArgv = argv;

  return new Promise((resolve) => {
    const start = Date.now();
    // Performance env flags for git: disable optional locks (faster on large
    // repos), disable external diff tools (prevents spawning slow subprocesses),
    // and cap rename detection (the most expensive part of git diff).
    const gitEnv = {
      ...toolEnv(),
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
    };
    // Inject performance flags for diff specifically — --no-ext-diff prevents
    // spawning an external diff tool, --no-rename skips rename detection.
    let finalArgv = effectiveArgv;
    if (sub === 'diff' && !effectiveArgv.includes('--no-ext-diff')) {
      finalArgv = ['diff', '--no-ext-diff', '--no-color', ...effectiveArgv.slice(1)];
    }
    const child = spawn('git', finalArgv, {
      cwd,
      env: gitEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      // Use killProcessTree (not child.kill) so spawned sub-processes
      // (diff tools, hooks, etc.) are also terminated.
      killProcessTree(child.pid, 'SIGTERM');
      if (process.platform !== 'win32') {
        setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 500);
      }
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

const GIT_DESCRIPTION = [
  'Run any git subcommand in the workspace. Pass args as an array of strings.',
  'Git safety protocol:',
  '- Never amend after a failed pre-commit hook — the commit did not happen, so amend would modify the PREVIOUS commit. Fix the issue, re-stage, create a NEW commit.',
  '- Stage specific files by name; never `git add -A` / `git add .` (risks secrets and large binaries).',
  '- Never skip hooks (`--no-verify`), never force-push (especially main/master), never update git config, unless the user explicitly asks.',
  '- Never use `-i` flags (interactive) — they hang.',
  '- Never push unless the user explicitly asks. Do not commit files that look like secrets (.env, credentials) — warn instead.',
].join('\n');

export const gitTool: ToolRegistration = {
  name: 'git',
  definition: {
    name: 'git',
    description: GIT_DESCRIPTION,
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
    description: GIT_DESCRIPTION,
    inputSchema: z.object({
      args: z.array(z.string()).describe('Subcommand + flags, e.g. ["status", "--short"] or ["log", "-n", "5"].'),
    }),
    execute: async ({ args }) =>
      withPermission(ctx, 'git', { args }, () =>
        runGit(args, ctx.workspaceRoot, getToolMeta('git').timeoutMs),
      ),
  });
}
