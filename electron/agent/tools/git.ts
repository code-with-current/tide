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
import { toolEnv, killProcessTree } from './tool-env';
import { tool } from 'ai';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../path-safety';
import { getToolMeta } from './tool-meta';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';
import { createConfigStore } from '../../configStore.js';
import { appDataDir } from '../../appPaths.js';

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

  // ── Co-authoring: when gitCoAuthored is enabled in General settings,
  //    append a Co-authored-by trailer to commit messages. The trailer
  //    uses the user-configurable name + email (defaults to Tide /
  //    309788114+code-with-current@users.noreply.github.com).
  let effectiveArgv = argv;
  if (sub === 'commit') {
    try {
      const store = createConfigStore(appDataDir());
      const gs = store.getGeneralSettings();
      if (gs.gitCoAuthored) {
        const trailer = `\n\nCo-authored-by: ${gs.gitCoAuthorName} <${gs.gitCoAuthorEmail}>`;
        effectiveArgv = argv.map((arg) => {
          // -m "message" → append trailer inside the quotes
          if (arg.startsWith('-m "') && arg.endsWith('"')) {
            return arg.slice(0, -1) + trailer + '"';
          }
          // -m "message (unterminated quote — skip)
          if (arg === '-m') return arg; // next arg is the message, handled below
          return arg;
        });
        // Handle the case where -m and the message are separate args:
        // ["commit", "-m", "my message"] → append trailer to the message arg
        const mIdx = effectiveArgv.indexOf('-m');
        if (mIdx >= 0 && mIdx + 1 < effectiveArgv.length) {
          const msgArg = effectiveArgv[mIdx + 1];
          if (!msgArg.startsWith('-')) {
            effectiveArgv[mIdx + 1] = msgArg + trailer;
          }
        }
        // Handle --message="..." form
        effectiveArgv = effectiveArgv.map((arg) => {
          if (arg.startsWith('--message=') && !arg.includes('Co-authored-by')) {
            return arg + trailer.replace(/\n/g, '\\n');
          }
          return arg;
        });
      }
    } catch { /* config unreadable — skip co-authoring */ }
  }

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
