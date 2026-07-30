/**
 * Git source control IPC handlers.
 *
 * Each function runs git via async exec (promisified) in the workspace root.
 * Paths are shell-quoted to prevent injection. No remote operations
 * (push/fetch/pull) are exposed.
 *
 * Previously used execSync which BLOCKED the main process event loop —
 * every git call froze the UI, IPC, and agent streaming until git finished.
 * Now async so the main process stays responsive.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { resolveInsideWorkspace } from '../agent/path-safety';
import { parseUnifiedDiff } from '../../src/lib/stream/parseDiff';

const execAsync = promisify(exec);
import type { DiffHunk } from '../../src/types';

/** Shell-quote a single argument for safe execSync. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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
  const { stdout: porcelain } = await execAsync('git status --porcelain', {
    cwd: rootDir, encoding: 'utf-8', timeout: 5000,
  });
  if (!porcelain.trim()) return [];

  let numstat = '';
  try {
    const { stdout } = await execAsync('git diff --numstat HEAD', {
      cwd: rootDir, encoding: 'utf-8', timeout: 5000,
    });
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
  const quoted = shellQuote(filePath);
  if (stage) {
    await execAsync(`git add -- ${quoted}`, { cwd: rootDir, timeout: 5000 });
  } else {
    await execAsync(`git restore --staged -- ${quoted}`, { cwd: rootDir, timeout: 5000 });
  }
}

/** Commit staged changes. Returns the short SHA. */
export async function gitCommit(rootDir: string, message: string): Promise<string> {
  const quoted = shellQuote(message);
  await execAsync(`git commit -m ${quoted} --`, { cwd: rootDir, timeout: 10000 });
  const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd: rootDir, encoding: 'utf-8' });
  return stdout.trim();
}

/** Get the diff for a specific file as parsed hunks. */
export async function gitDiff(rootDir: string, filePath: string, staged: boolean): Promise<DiffHunk[]> {
  resolveInsideWorkspace(rootDir, filePath);
  const quoted = shellQuote(filePath);
  const flag = staged ? '--cached' : '';
  const { stdout: raw } = await execAsync(`git diff ${flag} -- ${quoted}`, {
    cwd: rootDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
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
    const { stdout } = await execAsync('git branch --list --format=%(refname:short)', {
      cwd: rootDir, encoding: 'utf-8', timeout: 5000,
    });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve the current branch name. Falls back to 'main' if HEAD is
 *  detached or git is unavailable — used to default the base-branch
 *  select in the new-session UI. */
export async function currentBranch(rootDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: rootDir, encoding: 'utf-8', timeout: 5000,
    });
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
  const quotedPath = shellQuote(fullPath);
  const quotedBranch = shellQuote(branchName);
  const quotedBase = shellQuote(baseBranch);
  await execAsync(`git worktree add -b ${quotedBranch} ${quotedPath} ${quotedBase}`, {
    cwd: rootDir, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  const { stdout } = await execAsync('git rev-parse --short HEAD', {
    cwd: rootDir, encoding: 'utf-8', timeout: 5000,
  });
  return { path: fullPath, baseCommit: stdout.trim() };
}

/** Remove a worktree + delete its branch. Used on session delete and
 *  when the user manually removes a worktree-enabled session. */
export async function worktreeRemove(worktreePath: string, branchName: string): Promise<void> {
  const quotedPath = shellQuote(worktreePath);
  const quotedBranch = shellQuote(branchName);
  try {
    await execAsync(`git worktree remove --force ${quotedPath}`, { timeout: 10000 });
  } catch { /* already gone */ }
  try {
    await execAsync(`git branch -D ${quotedBranch}`, { timeout: 5000 });
  } catch { /* branch missing — fine */ }
}

/** Ahead/behind counts for a worktree vs its base branch. */
export async function worktreeStatus(
  worktreePath: string,
  baseBranch: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const quotedBase = shellQuote(baseBranch);
    const { stdout } = await execAsync(`git rev-list --left-right --count ${quotedBase}...HEAD`, {
      cwd: worktreePath, encoding: 'utf-8', timeout: 5000,
    });
    const [behind, ahead] = stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}
