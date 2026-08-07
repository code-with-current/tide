/**
 * Co-author attribution via `prepare-commit-msg` git hooks.
 *
 * Instead of injecting the trailer per-tool (which misses bash, external
 * terminals, and any path we forgot to wire), Tide writes a git hook into
 * each workspace's `.git/hooks/prepare-commit-msg`. This catches every
 * commit regardless of how it's made.
 *
 * - Setting enabled  → hook written (creates `.git/hooks` dir if needed).
 * - Setting disabled → hook removed if Tide wrote it.
 *
 * Hooks are marked with a sentinel comment so we never clobber a user's
 * own `prepare-commit-msg` hook.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import { listWorkspaces, getGeneralSettings } from './store.js';

const log = createLogger('git-coauthor');

const HOOK_SENTINEL = '# TIDE_COAUTHOR_HOOK';

export function buildHookContent(name: string, email: string): string {
  const trailer = `Co-authored-by: ${name} <${email}>`;
  return [
    '#!/bin/sh',
    HOOK_SENTINEL,
    '# Auto-managed by Tide — do not edit. Remove via Tide Settings → General.',
    '# Appends a Co-authored-by trailer to commit messages.',
    '',
    'set -e',
    '',
    '# Only amend regular commits (skip merge, squash, template).',
    'case "$2" in',
    '  commit|message|"")',
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
    '',
    `TRAILER='${trailer}'`,
    '',
    '# Skip if already present (e.g. git commit --amend).',
    'if grep -qF "$TRAILER" "$1"; then',
    '  exit 0',
    'fi',
    '',
    '# Ensure trailing newline before appending.',
    'if [ -s "$1" ] && [ "$(tail -c1 "$1")" != "" ]; then',
    '  printf "\\n" >> "$1"',
    'fi',
    '',
    'printf "\\n%s\\n" "$TRAILER" >> "$1"',
    '',
  ].join('\n');
}

/**
 * Resolve the `.git` dir for a workspace path. Handles both a standard
 * `.git/` directory and a `.git` file (worktree pointer). Returns null
 * if the workspace isn't a git repo.
 */
function resolveGitDir(workspacePath: string): string | null {
  const dotGit = path.join(workspacePath, '.git');
  if (!fs.existsSync(dotGit)) return null;

  // Worktree: .git is a file like "gitdir: /path/to/.git/worktrees/xxx"
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const gitdir = path.isAbsolute(match[1]) ? match[1] : path.resolve(workspacePath, match[1]);
        if (fs.existsSync(gitdir)) return gitdir;
      }
      return null;
    }
  } catch { /* unreadable — treat as non-repo */ }

  return dotGit;
}

/**
 * Write or remove the co-author hook for a single workspace based on
 * the current General settings. Safe to call on non-git workspaces (no-op).
 */
export function syncCoAuthorHook(workspacePath: string): void {
  const gitDir = resolveGitDir(workspacePath);
  if (!gitDir) return;

  const hooksDir = path.join(gitDir, 'hooks');
  const hookPath = path.join(hooksDir, 'prepare-commit-msg');

  let gs: { gitCoAuthored: boolean; gitCoAuthorName: string; gitCoAuthorEmail: string };
  try {
    gs = getGeneralSettings();
  } catch (e) {
    log.warn('failed to read general settings for hook sync', { error: e instanceof Error ? e.message : String(e) });
    return;
  }

  try {
    if (gs.gitCoAuthored) {
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }
      const content = buildHookContent(gs.gitCoAuthorName, gs.gitCoAuthorEmail);
      fs.writeFileSync(hookPath, content, { mode: 0o755 });
      fs.chmodSync(hookPath, 0o755);
      log.info('co-author hook written', { workspacePath, hookPath });
    } else {
      if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, 'utf8');
        if (existing.startsWith(HOOK_SENTINEL) || existing.includes(HOOK_SENTINEL)) {
          fs.unlinkSync(hookPath);
          log.info('co-author hook removed', { workspacePath, hookPath });
        }
      }
    }
  } catch (e) {
    log.error('failed to sync co-author hook', { workspacePath, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Sync hooks across all known workspaces. Called when the co-author
 * setting changes and at app startup.
 */
export function syncAllWorkspaceHooks(): void {
  let workspaces: { id: string; path: string }[];
  try {
    workspaces = listWorkspaces();
  } catch {
    return;
  }
  for (const ws of workspaces) {
    syncCoAuthorHook(ws.path);
  }
}
