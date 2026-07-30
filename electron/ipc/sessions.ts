/**
 * Session persistence — thin wrapper around sessionStore.
 *
 * The actual storage logic lives in ./sessionStore.js, parameterized by
 * directory and fully testable. This file binds it to Electron's userData
 * path and preserves the exact public API every existing caller relies on.
 *
 * On-disk layout: userData/sessions/<sessionId>.json, one file per session.
 * See docs/plans/2026-07-20-session-storage-rewrite-design.md.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../logger.js';
import {
  createSessionStore,
  type SessionStore,
  type StoredMessage,
  type StoredSession,
  type ArchivedHeader,
} from './sessionStore.js';

const log = createLogger('sessions');
import { listWorkspaces } from '../store.js';
import {
  listBranches as gitListBranches,
  worktreeAdd,
  worktreeRemove,
  worktreeStatus,
} from './git.js';
// Session-scoped permission rules live in the agent layer (in-memory). They
// must be cleared when a session is DELETED (real session end), not on every
// turn end — see orchestrator-sdk.ts turn-finally note. No import cycle:
// these agent modules do not import ipc/sessions.
import { clearSessionRules } from '../agent/permissions/rules.js';
import { clearSession as clearPermissionSession } from '../agent/permission-resolver.js';
import type { Block } from '../../src/types/block.js';
import type { ActivityEvent } from '../../src/types/index.js';

// Re-export types so existing callers don't break.
export type { StoredMessage, StoredSession, ArchivedHeader };

export interface HydratedSession extends StoredSession {
  autonomyMode: 'ask' | 'plan' | 'edit' | 'full';
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';
  status: 'idle' | 'active' | 'awaiting_permission' | 'error' | 'spend_capped';
  worktree?: { branch: string; path: string; baseCommit: string; baseBranch: string; ahead: number; behind: number };
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; reasoningTokens: number; calls: number; costUsd: number };
  costUsd: number;
  contextFiles: { path: string; status: 'M' | 'A' | 'ref' }[];
  activity: { id: string; type: string; label: string; at: string }[];
  mcpServers: { name: string; status: 'connected' | 'connecting' | 'error' }[];
  exposedPorts: { port: number; label: string; url: string }[];
}

function hydrate(s: StoredSession): HydratedSession {
  return {
    ...s,
    autonomyMode: s.autonomyMode ?? 'ask',
    thinkingLevel: s.thinkingLevel ?? 'medium',
    status: 'idle',
    usage: s.usage ?? { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, calls: 0, costUsd: 0 },
    costUsd: 0,
    contextFiles: [],
    // Preserve persisted activity (sessionStore.addActivity) instead of
    // wiping to [] on every hydrate — otherwise the feed never survives a reload.
    activity: (s.activity as ActivityEvent[] | undefined) ?? [],
    mcpServers: [],
    exposedPorts: [],
  };
}

// Singleton store, lazily instantiated (Electron's `app` is only available after app.whenReady).
let _store: SessionStore | null = null;
function store(): SessionStore {
  if (!_store) {
    _store = createSessionStore(app.getPath('userData'));
    _store.loadAll();
    // Wire the delete cascade: when a session with a worktree is deleted,
    // remove the worktree dir + branch before the JSON is unlinked. Without
    // this, deleting a worktree-enabled session would orphan .agent/worktrees/<branch>.
    _store.setDeleteHook(async (s) => {
      if (!s.worktree) return;
      try { await worktreeRemove(s.worktree.path, s.worktree.branch); }
      catch (e) { log.warn('worktree cleanup failed', { err: e }); }
    });
  }
  return _store;
}

// ── Branch + worktree lifecycle ───────────────────────────────────────
// Backed by electron/ipc/git.ts. Errors propagate to the renderer — the
// caller (MainScreen.handleSend) catches and falls back to no-worktree
// mode so the turn still runs even if `git worktree add` fails.

/** List local branches in the workspace's repo, for the base-branch
 *  select dropdown in the new-session UI. */
export async function listBranches(workspaceId: string): Promise<string[]> {
  const ws = listWorkspaces().find((w) => w.id === workspaceId);
  if (!ws?.path) return [];
  return gitListBranches(ws.path);
}

/** Create a worktree for a session and persist its metadata. The
 *  orchestrator reads `session.worktree.path` on the next turn and uses
 *  it as cwd for tool execution — no extra wiring needed.
 *
 *  Throws if the branch already exists, the base branch is missing, or
 *  the worktree path clashes with an existing entry. The renderer catches
 *  and surfaces to the user; the session still runs against the main
 *  workspace checkout. */
export async function createWorktree(
  sessionId: string,
  opts: {
    branchName: string;
    baseBranch: string;
    configFiles?: string[];
  },
): Promise<{ branch: string; path: string; baseBranch: string; baseCommit: string; ahead: number; behind: number }> {
  const s = store().getSession(sessionId);
  if (!s) throw new Error(`Session not found: ${sessionId}`);
  const ws = listWorkspaces().find((w) => w.id === s.workspaceId);
  if (!ws?.path) throw new Error('Workspace has no path — cannot create worktree');

  const location = ws.worktreeLocation || '.agent/worktrees/';
  log.info('creating worktree', { session: sessionId, branch: opts.branchName, base: opts.baseBranch });
  const { path: wtPath, baseCommit } = await worktreeAdd(ws.path, location, opts.branchName, opts.baseBranch);

  if (opts.configFiles && opts.configFiles.length > 0) {
    for (const rel of opts.configFiles) {
      try {
        copyConfigFile(ws.path, wtPath, rel);
      } catch (e) {
        log.warn('could not copy config file', { rel, err: e });
      }
    }
  }

  const { ahead, behind } = await worktreeStatus(wtPath, opts.baseBranch);
  const worktree = {
    branch: opts.branchName,
    path: wtPath,
    baseBranch: opts.baseBranch,
    baseCommit,
    ahead,
    behind,
  };
  store().setWorktree(sessionId, worktree);
  log.info('worktree created', { session: sessionId, branch: opts.branchName, path: wtPath });
  return worktree;
}

/**
 * Persist (or clear) the sticky skill reference. Set by the orchestrator when
 * a `[[LOAD_SKILL:...]]` marker is processed; read on subsequent turns so the
 * skill body stays in the system prompt for the whole session. Pass undefined
 * to clear.
 */
export function setActiveSkillRef(
  sessionId: string,
  ref: { name: string; path: string; loadedAt: string } | undefined,
): void {
  store().setActiveSkillRef(sessionId, ref);
}

/**
 * Copy a single file from the workspace root into the worktree, mirroring
 * any subdirectory structure. Refuses paths that escape either root
 * (path-traversal guard) and skips silently if the source doesn't exist
 * (the caller already warned at the createWorktree level). Overwrites
 * existing destination files — worktrees start clean from the base
 * branch, so gitignored config files won't pre-exist there.
 */
function copyConfigFile(workspaceRoot: string, worktreeRoot: string, relPath: string): void {
  const src = path.resolve(workspaceRoot, relPath);
  const dst = path.resolve(worktreeRoot, relPath);
  // Containment check — reject ../../etc/passwd style escapes.
  const wsRel = path.relative(workspaceRoot, src);
  const wtRel = path.relative(worktreeRoot, dst);
  if (wsRel.startsWith('..') || path.isAbsolute(wsRel)) {
    throw new Error(`Source path escapes workspace: ${relPath}`);
  }
  if (wtRel.startsWith('..') || path.isAbsolute(wtRel)) {
    throw new Error(`Destination path escapes worktree: ${relPath}`);
  }
  if (!fs.existsSync(src)) {
    throw new Error(`Source not found: ${relPath}`);
  }
  // Mirror subdirectories in the worktree (e.g., `config/.env`).
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/**
 * Auto-detect common config files at the workspace root — used by the
 * new-session UI to pre-check the files most users want copied (.env,
 * .env.local, etc.). Returns relative paths that exist on disk.
 */
export function listConfigFiles(workspaceId: string): string[] {
  const ws = listWorkspaces().find((w) => w.id === workspaceId);
  if (!ws?.path) return [];
  const candidates = [
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.test',
    '.env.dev',
    '.env.prod',
  ];
  const found: string[] = [];
  for (const name of candidates) {
    try {
      if (fs.statSync(path.join(ws.path, name)).isFile()) {
        found.push(name);
      }
    } catch { /* not present — skip */ }
  }
  return found;
}

/** Manually remove a session's worktree (without deleting the session).
 *  Rare — usually you want deleteSession, which cascades. Exposed so the
 *  user can collapse a worktree without losing the chat history. */
export async function removeWorktree(sessionId: string): Promise<void> {
  const s = store().getSession(sessionId);
  if (!s?.worktree) return;
  log.info('removing worktree', { session: sessionId, branch: s.worktree.branch, path: s.worktree.path });
  try {
    await worktreeRemove(s.worktree.path, s.worktree.branch);
  } catch (e) {
    log.warn('worktree remove failed', { session: sessionId, branch: s.worktree.branch, error: e instanceof Error ? e.message : String(e) });
  }
  store().setWorktree(sessionId, undefined as any);
}

// ── Public API (identical to the pre-rewrite signatures) ──

export function listSessions(workspaceId: string): HydratedSession[] {
  return store().listSessions(workspaceId).map(hydrate);
}

export function getSession(id: string): HydratedSession | undefined {
  const s = store().getSession(id);
  return s ? hydrate(s) : undefined;
}

export function createSession(
  workspaceId: string,
  title: string,
  modelId: string,
  opts?: {
    autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';
    providerId?: string;
  },
): HydratedSession {
  return hydrate(store().createSession(workspaceId, title, modelId, opts));
}

export function updateSessionSettings(
  sessionId: string,
  patch: {
    modelId?: string;
    autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';
    providerId?: string;
  },
): void {
  store().updateSessionSettings(sessionId, patch);
}

export function addMessage(sessionId: string, role: StoredMessage['role'], content: string): void {
  store().addMessage(sessionId, role, content);
}

export function deleteSession(id: string): void {
  store().deleteSession(id);
  // Real session end: drop session-scoped "always allow" rules + any stale
  // permission-resolver state. Reachable from the delete button, ⌘⌫, and the
  // workspace-delete cascade. Best-effort — never fail the deletion over this.
  try {
    clearSessionRules(id);
    clearPermissionSession(id);
  } catch {
    /* agent layer optional/unavailable — deletion already succeeded */
  }
}

export function clearAllSessions(): void {
  store().clearAllSessions();
}

export function archiveSession(sessionId: string): void {
  store().archiveSession(sessionId);
}

export function unarchiveSession(sessionId: string): void {
  store().unarchiveSession(sessionId);
}

export function renameSession(sessionId: string, title: string): void {
  store().renameSession(sessionId, title);
}

export function listArchivedSessions(workspaceId: string): ArchivedHeader[] {
  return store().listArchived(workspaceId);
}

export function addAssistantMessage(
  sessionId: string,
  message: {
    content: string;
    blocks?: Block[];
    reasoning?: string;
    reasoningTokens?: number;
    reasoningMs?: number;
    toolCalls?: any[];
    timeline?: any[];
    turn?: any;
  },
): void {
  store().addAssistantMessage(sessionId, message);
}

export function addUsage(
  sessionId: string,
  delta: {
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoningTokens?: number;
    calls?: number;
    costUsd?: number;
  },
): void {
  store().addUsage(sessionId, delta);
}

/** Append an audit event to the session's activity feed. Used by tools that
 *  load/invoke files (slash_command, future skill loader) so the Inspector
 *  surfaces "this file was loaded" alongside tool/read events. */
export function addActivity(
  sessionId: string,
  event: { type: ActivityEvent['type']; label: string; detail?: string; tone?: ActivityEvent['tone'] },
): void {
  store().addActivity(sessionId, {
    type: event.type,
    label: event.label,
    detail: event.detail,
    tone: event.tone ?? 'muted',
  });
}
