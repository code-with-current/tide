/**
 * Git source control IPC handlers.
 *
 * Each function runs git via spawn (no shell — args passed directly) in the
 * workspace root. No shell quoting needed since args are passed as an array.
 * No remote operations (push/fetch/pull) are exposed.
 *
 * Previously used execAsync (shell string) which required POSIX shell
 * quoting that doesn't work on Windows. Now uses spawn with shell:false
 * — args are passed directly to git, platform-independent.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { resolveInsideWorkspace } from '../agent/path-safety';
import { parseUnifiedDiff } from '../../src/lib/stream/parseDiff';
import { toolEnv } from '../agent/tools/tool-env';
import type { DiffHunk } from '../../src/types';

/**
 * Run git with the given args and return { stdout, stderr }.
 * Uses spawn with shell:false — no shell quoting needed, platform-independent.
 */
function runGit(args: string[], cwd: string, timeout = 5000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: toolEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* dead */ }
      reject(new Error(`git timed out after ${timeout}ms`));
    }, timeout);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git exit ${code}: ${stderr.trim()}`));
    });
  });
}

export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
  additions: number;
  deletions: number;
}

/** Get the git status of a workspace as structured file changes. */
export async function getGitStatus(rootDir: string): Promise<GitFileChange[]> {
  const { stdout: porcelain } = await runGit(['status', '--porcelain'], rootDir);
  if (!porcelain.trim()) return [];

  let numstat = '';
  try {
    const { stdout } = await runGit(['diff', '--numstat', 'HEAD'], rootDir);
    numstat = stdout;
  } catch { /* no HEAD yet — all untracked */ }

  const statMap = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    statMap.set(rest.join('\t'), {
      additions: add === '-' ? 0 : parseInt(add, 10),
      deletions: del === '-' ? 0 : parseInt(del, 10),
    });
  }

  const result: GitFileChange[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    const filePath = line.slice(3);

    let status: GitFileChange['status'];
    let staged: boolean;

    if (x === '?' && y === '?') {
      status = 'untracked'; staged = false;
    } else if (x === 'A') {
      status = 'added'; staged = true;
    } else if (x === 'D' || y === 'D') {
      status = 'deleted'; staged = x === 'D';
    } else if (x === 'R') {
      status = 'renamed'; staged = true;
    } else if (x === 'M' || y === 'M') {
      status = 'modified'; staged = x === 'M';
    } else {
      status = 'modified'; staged = x !== ' ' && x !== '?';
    }

    const stats = statMap.get(filePath) ?? { additions: 0, deletions: 0 };
    result.push({ path: filePath, status, staged, ...stats });
  }

  return result;
}

/** Stage or unstage a single file. */
export async function gitStage(rootDir: string, filePath: string, stage: boolean): Promise<void> {
  resolveInsideWorkspace(rootDir, filePath);
  if (stage) {
    await runGit(['add', '--', filePath], rootDir);
  } else {
    await runGit(['restore', '--staged', '--', filePath], rootDir);
  }
}

/** Commit staged changes. Returns the short SHA. */
export async function gitCommit(rootDir: string, message: string): Promise<string> {
  await runGit(['commit', '-m', message, '--'], rootDir, 10000);
  const { stdout } = await runGit(['rev-parse', '--short', 'HEAD'], rootDir);
  return stdout.trim();
}

/** Get the diff for a specific file as parsed hunks. */
export async function gitDiff(rootDir: string, filePath: string, staged: boolean): Promise<DiffHunk[]> {
  resolveInsideWorkspace(rootDir, filePath);
  const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
  const { stdout: raw } = await runGit(args, rootDir, 10000);
  return parseUnifiedDiff(raw);
}

// ─── Worktree primitives ─────────────────────────────────────────────
// Per-session isolation. Each session can spawn its own working tree at
// <workspace>/<worktreeLocation>/<branchName> so write tools land there
// instead of the user's main checkout. All shell-quoted via the helper
// above; no remote operations.

/** List local branches for the base-branch select dropdown.
 *  Strips the leading `* ` from the current branch and trims whitespace. */
export async function listBranches(rootDir: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(['branch', '--list', '--format=%(refname:short)'], rootDir);
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve the current branch name. */
export async function currentBranch(rootDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], rootDir);
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

/** Create a worktree at <rootDir>/<worktreeLocation>/<branchName>
 *  branched from `baseBranch`. Returns the absolute path + the base
 *  commit SHA. Throws on git failure (e.g., branch already exists,
 *  base branch missing, path clash with an existing worktree). */
export async function worktreeAdd(
  rootDir: string,
  worktreeLocation: string,
  branchName: string,
  baseBranch: string,
): Promise<{ path: string; baseCommit: string }> {
  const fullPath = path.resolve(rootDir, worktreeLocation, branchName);
  await runGit(['worktree', 'add', '-b', branchName, fullPath, baseBranch], rootDir, 15000);
  const { stdout } = await runGit(['rev-parse', '--short', 'HEAD'], rootDir);
  return { path: fullPath, baseCommit: stdout.trim() };
}

/** Remove a worktree + delete its branch. */
export async function worktreeRemove(worktreePath: string, branchName: string): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktreePath], worktreePath, 10000);
  } catch { /* already gone */ }
  try {
    await runGit(['branch', '-D', branchName], worktreePath);
  } catch { /* branch missing — fine */ }
}

/** Ahead/behind counts for a worktree vs its base branch. */
export async function worktreeStatus(
  worktreePath: string,
  baseBranch: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await runGit(['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`], worktreePath);
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}
