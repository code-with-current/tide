/**
 * Path sandboxing for tools.
 *
 * Per design doc §8: every file-touching tool MUST resolve its target path
 * against the workspace root and refuse anything that escapes it. We use
 * `path.relative()` + a leading-`..` check — *not* string-prefix matching,
 * which is wrong on `workspace-evil/` vs `workspace/`.
 *
 * Symlinks: resolved with `fs.realpath` and re-verified. A symlink whose
 * target escapes the workspace is refused. A symlink whose target stays
 * inside is allowed. This is the middle option from the design doc's list.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class PathEscapeError extends Error {
  constructor(
    message: string,
    public readonly requestedPath: string,
    public readonly workspaceRoot: string,
  ) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve a (possibly relative, possibly absolute) path against the workspace
 * root and verify the result is inside the root. Returns the resolved
 * absolute path on success, throws `PathEscapeError` on escape.
 *
 * Does NOT resolve symlinks — for tools that follow links, call
 * `assertResolvedInside()` after opening. For write/destructive tools that
 * must not follow symlinks, open with `O_NOFOLLOW` separately.
 */
export function resolveInsideWorkspace(workspaceRoot: string, target: string): string {
  const root = path.resolve(workspaceRoot);
  // Allow absolute paths that point inside the root, plus relative paths.
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
  const rel = path.relative(root, abs);
  if (rel === '' || rel === '.') return abs; // the root itself
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathEscapeError(
      `Path "${target}" resolves outside the workspace root`,
      target,
      root,
    );
  }
  return abs;
}

/**
 * After resolving a real path (e.g. via `fs.realpath`), verify it's still
 * inside the workspace. Use for tools that read symlinks — defends against
 * a symlink whose link itself is inside the root but whose target escapes.
 */
export function assertResolvedInside(workspaceRoot: string, resolvedAbs: string): void {
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, resolvedAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathEscapeError(
      `Resolved real path escapes workspace root (likely a symlink)`,
      resolvedAbs,
      root,
    );
  }
}

/**
 * Convenience for read tools: resolve the path AND follow any symlink,
 * re-verifying the target. Throws `PathEscapeError` on any escape.
 */
export function resolveAndFollowSymlinks(workspaceRoot: string, target: string): string {
  const resolved = resolveInsideWorkspace(workspaceRoot, target);
  // realpath follows symlinks recursively. If the file doesn't exist yet
  // (write_file creating a new file), realpath throws ENOENT — callers
  // should use resolveInsideWorkspace directly for the create case.
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch (e: any) {
    if (e.code === 'ENOENT') return resolved; // not yet created — that's fine for writes
    throw e;
  }
  assertResolvedInside(workspaceRoot, real);
  return real;
}

/**
 * Resolve an absolute target under the user's skill/agent roots (~/.claude or
 * ~/.agent), following symlinks + re-verifying. Used by read_file so the model
 * can load skill/agent/context files that live OUTSIDE the workspace (e.g.
 * `~/.claude/skills/brainstorming/SKILL.md`) — the progressive-disclosure
 * model where a `/name` invocation hands the model a path to read on demand.
 *
 * Only the user's own `.claude`/`.agent` dirs are reachable this way; arbitrary
 * filesystem access is still refused. Throws `PathEscapeError` otherwise.
 */
export function resolveUnderSkillRoot(target: string): string {
  const home = os.homedir();
  const resolved = path.resolve(target);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch (e: any) {
    if (e.code === 'ENOENT') real = resolved;
    else throw e;
  }
  // Windows + macOS are case-insensitive; also, on Windows `fs.realpathSync`
  // may return an 8.3 short path (e.g. C:\Users\USER~1\.claude) while
  // `os.homedir()` returns the long path (C:\Users\user.name). Resolve the
  // home dir through realpath too so both sides are normalized the same
  // way, and compare case-insensitively on case-insensitive filesystems.
  // Without this, skill loading fails on Windows when the username
  // contains a dot (USER~1 vs user.name) — see the path-safety-windows test.
  let realHome = home;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    /* fall back to the raw homedir string */
  }
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const eq = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const dir of ['.claude', '.agent', '.zcode']) {
    const root = path.join(realHome, dir);
    const rel = path.relative(root, real);
    // path.relative on Windows mixes separators when the inputs differ in
    // case form; normalize both to the platform sep before the prefix check.
    const relNorm = caseInsensitive ? rel.toLowerCase() : rel;
    if (relNorm && !relNorm.startsWith('..') && !path.isAbsolute(rel)) return real;
    // Also accept an exact match on the root itself.
    if (eq(real, root)) return real;
  }
  throw new PathEscapeError(
    `Resolved path is not under a skill root (~/.claude, ~/.agent, or ~/.zcode): ${target}`,
  );
}

/** Quick non-throwing check: is `target` (absolute) under ~/.claude, ~/.agent, or ~/.zcode? */
export function isUnderSkillRoot(target: string): boolean {
  try {
    resolveUnderSkillRoot(target);
    return true;
  } catch {
    return false;
  }
}
