/** Path sandboxing: resolve tool target paths against the workspace root and refuse escapes, using path.relative() + leading-`..` check (string-prefix matching is unsafe). */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class PathEscapeError extends Error {
  constructor(
    message: string,
    public readonly requestedPath?: string,
    public readonly workspaceRoot?: string,
  ) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/** Resolve a path against the workspace root and verify it's inside; throws PathEscapeError on escape. Does NOT resolve symlinks. */
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

/** After resolving a real path (e.g. via `fs.realpath`), verify it's still inside the workspace — defends against a symlink whose link is inside root but whose target escapes. */
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

/** Resolve a target under ~/.claude, ~/.agent, or ~/.zcode, following symlinks + re-verifying; used by read_file for out-of-workspace skill/context files. */
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
  // Windows + macOS are case-insensitive. On Windows, `fs.realpathSync` may return an 8.3 short path (C:\Users\USER~1\.claude) while `os.homedir()` returns the long path (C:\Users\user.name). Resolve home through realpath too so both sides normalize identically, and compare case-insensitively — otherwise skill loading fails on Windows when the username contains a dot (see path-safety-windows test).
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
