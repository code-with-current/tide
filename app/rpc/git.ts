/** Git RPC — port of the git-domain channels from electron/ipc/handlers.ts
 *  (tide:gitStatus … tide:gitDiscardFile) plus the push-based watcher from
 *  electron/ipc/git-watcher.ts. Every op resolves the git cwd through the
 *  same chain the Electron shell used: the active session's worktree path
 *  first, then the workspace's main checkout. The git core and the
 *  session/workspace lookups are injectable so tests run against temp state. */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createLogger } from '../core/logger.js';
import { toolEnv } from '../core/agent/tools/tool-env';
import type {
  GitAheadBehindResult,
  GitBranchDetailed,
  GitBranchInfoResult,
  GitBulkOp,
  GitCommit,
  GitCommitResult,
  GitConflictEntry,
  GitFileChange,
  GitMergeResult,
  GitOpResult,
  GitRevertResult,
  GitSessionScope,
  GitStash,
} from '../../shared/rpc';
import type { DiffHunk } from '../../src/types';

const log = createLogger('git-rpc');

/** The git core surface the handlers dispatch to — satisfied structurally by
 *  app/core/ipc-adjacent/git.js. */
export interface GitDomain {
  getGitStatus(root: string): Promise<GitFileChange[]>;
  getGitLog(root: string, limit?: number): Promise<GitCommit[]>;
  getCommitFiles(root: string, sha: string): Promise<GitFileChange[]>;
  getCommitFileDiff(root: string, sha: string, filePath: string): Promise<DiffHunk[]>;
  gitStage(root: string, filePath: string, stage: boolean): Promise<void>;
  gitCommit(root: string, message: string): Promise<string>;
  gitDiff(root: string, filePath: string, staged: boolean, contextLines?: number): Promise<DiffHunk[]>;
  branchInfo(root: string): Promise<GitBranchInfoResult>;
  gitHeadSha(root: string): Promise<string | null>;
  gitRestoreFile(root: string, filePath: string, sha: string): Promise<GitOpResult>;
  gitStageAll(root: string): Promise<void>;
  gitUnstageAll(root: string): Promise<void>;
  gitRestoreAll(root: string): Promise<void>;
  gitStash(root: string, message?: string): Promise<void>;
  gitStashPop(root: string): Promise<void>;
  gitStashList(root: string): Promise<GitStash[]>;
  gitCheckout(root: string, branch: string): Promise<void>;
  gitCreateBranch(root: string, branchName: string, sha?: string): Promise<void>;
  recentBranches(root: string): Promise<string[]>;
  gitAmend(root: string, message?: string): Promise<string>;
  gitRevertCommit(root: string, sha: string): Promise<GitRevertResult>;
  gitFetch(root: string): Promise<GitOpResult>;
  gitPush(root: string): Promise<GitOpResult>;
  gitPull(root: string): Promise<GitOpResult>;
  gitAheadBehind(root: string): Promise<GitAheadBehindResult | null>;
  gitListBranchesDetailed(root: string): Promise<GitBranchDetailed[]>;
  gitDeleteBranch(root: string, name: string, force: boolean): Promise<GitOpResult>;
  gitMergeBranch(root: string, name: string): Promise<GitMergeResult>;
  gitConflictFiles(root: string): Promise<GitConflictEntry[]>;
  gitResolveFile(root: string, filePath: string, side: 'ours' | 'theirs'): Promise<GitOpResult>;
  gitStagedDiff(root: string): Promise<string>;
  gitCommitMessage(root: string, sha: string): Promise<string>;
  gitDiscardFile(root: string, filePath: string): Promise<GitOpResult>;
}

export interface GitRpcOpts {
  /** Pushes the watcher's debounced change pings. */
  gitChanged: (msg: { workspaceId: string }) => void;
  /** Resolve a session's worktree path (worktree-first cwd chain). */
  sessionWorktreeOf?: (sessionId: string) => string | undefined;
  /** Resolve a workspace's main checkout path. */
  workspacePathOf?: (workspaceId: string) => string | undefined;
}

// ── Watcher (straight port of electron/ipc/git-watcher.ts) ────────

interface WatchEntry {
  root: string;
  close: () => void;
}

const watchers = new Map<string, WatchEntry>();
const WATCH_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 2500;

function porcelainSnapshot(root: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain'], { cwd: root, env: toolEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

export function startGitWatcher(workspaceId: string, root: string, emit: (workspaceId: string) => void) {
  const existing = watchers.get(workspaceId);
  if (existing) {
    if (existing.root === root) return;
    existing.close();
  }

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleEmit = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      emit(workspaceId);
    }, WATCH_DEBOUNCE_MS);
  };

  let closed = false;
  try {
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (closed) return;
      const f = String(filename ?? '');
      if (f.endsWith('.lock') || f.startsWith('.git/COMMIT_EDITMSG')) return;
      scheduleEmit();
    });
    watchers.set(workspaceId, {
      root,
      close: () => {
        closed = true;
        clearTimeout(debounce);
        watcher.close();
      },
    });
  } catch {
    // Linux: recursive watch unsupported (ERR_FEATURE_UNUSABLE) — poll instead.
    let last: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (closed) return;
      const snap = await porcelainSnapshot(root);
      if (closed) return;
      if (last !== null && snap !== last) emit(workspaceId);
      last = snap;
      if (!closed) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();
    watchers.set(workspaceId, {
      root,
      close: () => {
        closed = true;
        clearTimeout(timer);
      },
    });
  }
}

export function registerGitRpc(git: GitDomain, opts: GitRpcOpts) {
  const sessionWorktreeOf =
    opts.sessionWorktreeOf ?? (() => undefined);
  const workspacePathOf =
    opts.workspacePathOf ?? (() => undefined);

  // Prefer the active session's worktree path (so the Git Panel shows worktree
  // changes when one is isolated), fall back to the workspace's main checkout.
  const resolveGitCwd = ({ workspaceId, sessionId }: GitSessionScope): string | undefined => {
    if (sessionId) {
      const worktree = sessionWorktreeOf(sessionId);
      if (worktree) return worktree;
    }
    return workspacePathOf(workspaceId);
  };

  const noWorkspace: GitOpResult = { ok: false, error: 'no workspace' };

  return {
    gitStatus: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      startGitWatcher(scope.workspaceId, root, (workspaceId) => opts.gitChanged({ workspaceId }));
      try { return await git.getGitStatus(root); } catch { return []; }
    },

    gitLog: async ({ limit, ...scope }: GitSessionScope & { limit?: number }) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      try { return await git.getGitLog(root, limit); } catch { return []; }
    },

    gitCommitFiles: async ({ sha, ...scope }: GitSessionScope & { sha: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      try { return await git.getCommitFiles(root, sha); } catch { return []; }
    },

    gitCommitFileDiff: async ({ sha, filePath, ...scope }: GitSessionScope & { sha: string; filePath: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      try { return await git.getCommitFileDiff(root, sha, filePath); } catch { return []; }
    },

    gitBulk: async ({ op, opts: bulkOpts, ...scope }: GitSessionScope & { op: GitBulkOp; opts?: { message?: string } }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      try {
        switch (op) {
          case 'stage-all': await git.gitStageAll(root); break;
          case 'unstage-all': await git.gitUnstageAll(root); break;
          case 'restore-all': await git.gitRestoreAll(root); break;
          case 'stash': await git.gitStash(root, bulkOpts?.message); break;
          case 'stash-pop': await git.gitStashPop(root); break;
          default: return { ok: false, error: `unknown op: ${op}` };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    gitStashList: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      try { return await git.gitStashList(root); } catch { return []; }
    },

    gitBranchInfo: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return { branch: null, headCommit: null };
      try { return await git.branchInfo(root); } catch { return { branch: null, headCommit: null }; }
    },

    gitRecentBranches: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      try { return await git.recentBranches(root); } catch { return []; }
    },

    gitCheckout: async ({ branch, ...scope }: GitSessionScope & { branch: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      try { await git.gitCheckout(root, branch); return { ok: true }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },

    gitCreateBranch: async ({ branchName, sha, ...scope }: GitSessionScope & { branchName: string; sha?: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      try { await git.gitCreateBranch(root, branchName, sha); return { ok: true }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },

    gitStage: async ({ filePath, stage, ...scope }: GitSessionScope & { filePath: string; stage: boolean }) => {
      const root = resolveGitCwd(scope);
      if (!root) return { ok: false };
      try { await git.gitStage(root, filePath, stage); return { ok: true }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    },

    gitCommit: async ({ message, ...scope }: GitSessionScope & { message: string }): Promise<GitCommitResult> => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      try {
        const sha = await git.gitCommit(root, message);
        return { ok: true, sha };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    gitDiff: async ({ filePath, staged, contextLines, ...scope }: GitSessionScope & { filePath: string; staged: boolean; contextLines?: number }) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      try { return await git.gitDiff(root, filePath, staged, contextLines); } catch { return []; }
    },

    gitHeadSha: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return { sha: null };
      try { return { sha: await git.gitHeadSha(root) }; } catch { return { sha: null }; }
    },

    gitRestoreFile: async ({ filePath, sha, ...scope }: GitSessionScope & { filePath: string; sha: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitRestoreFile(root, filePath, sha);
    },

    gitAmend: async ({ message, ...scope }: GitSessionScope & { message: string | null }): Promise<GitCommitResult> => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      try {
        const sha = await git.gitAmend(root, message ?? undefined);
        return { ok: true, sha };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    gitRevert: async ({ sha, ...scope }: GitSessionScope & { sha: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitRevertCommit(root, sha);
    },

    gitFetch: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitFetch(root);
    },

    gitPush: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitPush(root);
    },

    gitPull: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitPull(root);
    },

    gitAheadBehind: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return null;
      try { return await git.gitAheadBehind(root); } catch { return null; }
    },

    gitBranchesDetailed: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      try { return await git.gitListBranchesDetailed(root); } catch { return []; }
    },

    gitDeleteBranch: async ({ name, force, ...scope }: GitSessionScope & { name: string; force: boolean }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitDeleteBranch(root, name, force);
    },

    gitMergeBranch: async ({ name, ...scope }: GitSessionScope & { name: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitMergeBranch(root, name);
    },

    gitConflictFiles: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return [];
      try { return await git.gitConflictFiles(root); } catch { return []; }
    },

    gitResolveFile: async ({ filePath, side, ...scope }: GitSessionScope & { filePath: string; side: 'ours' | 'theirs' }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitResolveFile(root, filePath, side);
    },

    gitStagedDiff: async (scope: GitSessionScope) => {
      const root = resolveGitCwd(scope);
      if (!root) return { text: '' };
      try { return { text: await git.gitStagedDiff(root) }; } catch { return { text: '' }; }
    },

    gitCommitMessage: async ({ sha, ...scope }: GitSessionScope & { sha: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return { text: '' };
      try { return { text: await git.gitCommitMessage(root, sha) }; } catch { return { text: '' }; }
    },

    gitDiscardFile: async ({ filePath, ...scope }: GitSessionScope & { filePath: string }) => {
      const root = resolveGitCwd(scope);
      if (!root) return noWorkspace;
      return await git.gitDiscardFile(root, filePath);
    },
  };
}
