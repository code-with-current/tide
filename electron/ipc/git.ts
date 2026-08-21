/** Git IPC handlers. Each function runs git via spawn with shell:false (args passed directly — no shell quoting, platform-independent) in the workspace root. No remote operations (push/fetch/pull) are exposed. */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveInsideWorkspace } from '../agent/path-safety';
import { parseUnifiedDiff } from '../../src/lib/stream/parse-diff';
import { clampContextLines } from '../../src/lib/diff/expand-context';
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
    const rawPath = line.slice(3);
    // For renames, porcelain shows "old -> new" — extract just the new path.
    const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ')[1] : rawPath;

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

export interface GitCommit {
  /** Short SHA. */
  sha: string;
  /** Author name. */
  author: string;
  /** ISO 8601 commit date. */
  date: string;
  /** First line of the commit message. */
  subject: string;
}

/** Recent commit history (newest first), limited to `limit` (default 100). */
export async function getGitLog(rootDir: string, limit = 100): Promise<GitCommit[]> {
  try {
    // \x1f (unit separator) delimits fields; %s is single-line so records split cleanly on \n.
    const SEP = '\x1f';
    const fmt = ['%h', '%an', '%aI', '%s'].join(SEP);
    const { stdout } = await runGit(['log', `--pretty=format:${fmt}`, '-n', String(limit)], rootDir, 10000);
    return stdout.split('\n').filter((l) => l.trim()).map((l) => {
      const [sha, author, date, subject] = l.split(SEP);
      return { sha, author, date, subject };
    });
  } catch {
    return [];
  }
}

/** Files changed in a commit vs its first parent (root-aware via --root). */
export async function getCommitFiles(rootDir: string, sha: string): Promise<GitFileChange[]> {
  let statLines = '';
  try {
    const { stdout } = await runGit(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', sha], rootDir);
    statLines = stdout;
  } catch { return []; }
  // numstat for +/- (best-effort — separate call; binary files show '-').
  const statMap = new Map<string, { additions: number; deletions: number }>();
  try {
    const { stdout } = await runGit(['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', sha], rootDir);
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [a, d, ...rest] = line.split('\t');
      statMap.set(rest.join('\t'), { additions: a === '-' ? 0 : parseInt(a, 10), deletions: d === '-' ? 0 : parseInt(d, 10) });
    }
  } catch { /* numstat unavailable — show 0/0 */ }

  const out: GitFileChange[] = [];
  for (const line of statLines.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const x = code[0];
    const status: GitFileChange['status'] = x === 'A' ? 'added' : x === 'D' ? 'deleted' : x === 'R' ? 'renamed' : 'modified';
    const s = statMap.get(path) ?? { additions: 0, deletions: 0 };
    out.push({ path, status, staged: true, ...s });
  }
  return out;
}

/** Unified diff of a single file at a commit (root-aware). */
export async function getCommitFileDiff(rootDir: string, sha: string, filePath: string): Promise<DiffHunk[]> {
  resolveInsideWorkspace(rootDir, filePath);
  const { stdout } = await runGit(['diff-tree', '--root', '-p', '--no-commit-id', sha, '--', filePath], rootDir, 10000);
  return parseUnifiedDiff(stdout);
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

/** Commit staged changes. Returns the short SHA. The Co-authored-by trailer
 *  is appended by the prepare-commit-msg hook managed by git-coauthor.ts. */
export async function gitCommit(rootDir: string, message: string): Promise<string> {
  await runGit(['commit', '-m', message, '--'], rootDir, 10000);
  const { stdout } = await runGit(['rev-parse', '--short', 'HEAD'], rootDir);
  return stdout.trim();
}

/** Get the diff for a specific file as parsed hunks. `contextLines` controls
 *  the number of unchanged context lines around each change (absent = git's
 *  default 3). Ladder values clamp to 1..200; a large sentinel (e.g. 100000)
 *  still yields a full-file diff view. */
export async function gitDiff(rootDir: string, filePath: string, staged: boolean, contextLines?: number): Promise<DiffHunk[]> {
  resolveInsideWorkspace(rootDir, filePath);
  const clamped = clampContextLines(contextLines);
  const contextArgs = clamped != null ? ['-U', String(clamped)] : [];
  const args = staged
    ? ['diff', ...contextArgs, '--cached', '--', filePath]
    : ['diff', ...contextArgs, '--', filePath];
  const { stdout: raw } = await runGit(args, rootDir, 10000);
  return parseUnifiedDiff(raw);
}

/** Get the current HEAD commit SHA (full). Used to capture pre-turn state
 *  so individual files can be reverted to exactly where they were before a
 *  turn's edits. Returns null if not a git repo. */
export async function gitHeadSha(rootDir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], rootDir);
    return stdout.trim() || null;
  } catch { return null; }
}

/** Restore a single file to its state at the given commit SHA. If the file
 * didn't exist at that commit (was created after), delete it from the
 * working tree. This is the per-file "undo this turn's changes" operation. */

// ─── Bulk working-tree ops (Git Panel "Stage All" group) ───────────────

/** Stage every change (tracked modifications + untracked files). */
export async function gitStageAll(rootDir: string): Promise<void> {
  await runGit(['add', '-A'], rootDir);
}

/** Unstage everything (keep working-tree edits). */
export async function gitUnstageAll(rootDir: string): Promise<void> {
  await runGit(['restore', '--staged', '.'], rootDir);
}

/** Discard ALL uncommitted changes: reset tracked files to HEAD and remove
 *  untracked files/dirs. Destructive — caller must confirm first. */
export async function gitRestoreAll(rootDir: string): Promise<void> {
  await runGit(['restore', '--staged', '--worktree', '.'], rootDir);
  await runGit(['clean', '-fd'], rootDir);
}

export interface GitStash { ref: string; message: string; }

/** Stash all changes (including untracked). Optional message. */
export async function gitStash(rootDir: string, message?: string): Promise<void> {
  const args = message ? ['stash', 'push', '-u', '-m', message] : ['stash', 'push', '-u'];
  await runGit(args, rootDir, 10000);
}

/** Pop the most recent stash (apply + drop). */
export async function gitStashPop(rootDir: string): Promise<void> {
  await runGit(['stash', 'pop'], rootDir, 15000);
}

/** List stashes, newest first. Empty array if none (or not a repo). */
export async function gitStashList(rootDir: string): Promise<GitStash[]> {
  try {
    const { stdout } = await runGit(['stash', 'list'], rootDir);
    return stdout.split('\n').filter((l) => l.trim()).map((l) => {
      const idx = l.indexOf(':');
      return idx === -1 ? { ref: l, message: '' } : { ref: l.slice(0, idx).trim(), message: l.slice(idx + 1).trim() };
    });
  } catch { return []; }
}

export async function gitRestoreFile(rootDir: string, filePath: string, sha: string): Promise<{ ok: boolean; error?: string }> {
  resolveInsideWorkspace(rootDir, filePath);
  try {
    // Check if the file existed at the target commit.
    const { stdout } = await runGit(['cat-file', '-e', `${sha}:${filePath}`], rootDir, 5000);
    // Existed → restore it from the commit.
    await runGit(['checkout', sha, '--', filePath], rootDir, 10000);
    return { ok: true };
  } catch {
    // File didn't exist at that commit → it was created during the turn. Delete it.
    try {
      const abs = resolveInsideWorkspace(rootDir, filePath);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
}

// ─── Worktree primitives: per-session isolation via <workspace>/<worktreeLocation>/<branchName>; no remote operations.

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

/** Recently checked-out branches from the reflog, excluding the current
 *  branch. Falls back to local branches sorted by latest commit date when
 *  the reflog is empty or unavailable. Powers the top-bar branch switcher. */
export async function recentBranches(rootDir: string, limit = 5): Promise<string[]> {
  const current = await currentBranch(rootDir);
  try {
    const { stdout } = await runGit(['reflog', 'show', '--format=%gs', '-n', '100'], rootDir, 5000);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/checkout: moving from (.+) to (.+)/);
      if (!m) continue;
      // "to" first (most recently visited), then "from".
      for (const b of [m[2], m[1]]) {
        if (b && b !== current && !seen.has(b)) { seen.add(b); ordered.push(b); }
      }
    }
    if (ordered.length > 0) return ordered.slice(0, limit);
  } catch { /* reflog unavailable — fall through */ }
  try {
    const { stdout } = await runGit(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', `--count=${limit + 1}`, 'refs/heads/'], rootDir);
    return stdout.split('\n').map((l) => l.trim()).filter((b) => b && b !== current).slice(0, limit);
  } catch { return []; }
}

/** Checkout a branch in the working directory. */
export async function gitCheckout(rootDir: string, branch: string): Promise<void> {
  await runGit(['checkout', branch, '--'], rootDir, 10000);
}

/** Create a new branch from the current HEAD and check it out. */
export async function gitCreateBranch(rootDir: string, branchName: string): Promise<void> {
  await runGit(['checkout', '-b', branchName, '--'], rootDir, 10000);
}

/** Resolve the current branch name. */
export async function currentBranch(rootDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], rootDir);
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

/** Live branch + short HEAD commit for the session's working directory
 *  (workspace root or a session worktree). Used by the Inspector so the Git
 *  section reflects branch changes made by tools mid-session (e.g. a new
 *  branch created via the git tool), instead of the stale persisted value. */
export async function branchInfo(rootDir: string): Promise<{ branch: string | null; headCommit: string | null }> {
  try {
    const branch = await currentBranch(rootDir);
    const { stdout: head } = await runGit(['rev-parse', '--short', 'HEAD'], rootDir);
    return { branch: branch ?? null, headCommit: head.trim() || null };
  } catch { return { branch: null, headCommit: null }; }
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
