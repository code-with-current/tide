/** Session persistence: thin wrapper around sessionStore, bound to Electron's userData. One JSON file per session; preserves the exact public API callers rely on. */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../logger.js';
import {
  createSessionStore,
  type SessionStore,
  type StoredMessage,
  type StoredSession,
  type SessionHeader,
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
import { abortSession, abortAllSessions } from '../agent/session-abort.js';
import type { Block } from '../../src/types/block.js';
import type { ActivityEvent } from '../../src/types/index.js';
import { appDataDir } from '../appPaths.js';

// Re-export types so existing callers don't break.
export type { StoredMessage, StoredSession, SessionHeader, ArchivedHeader };

export interface HydratedSession extends StoredSession {
  autonomyMode: 'ask' | 'plan' | 'edit' | 'full';
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
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
    costUsd: s.costUsd ?? s.usage?.costUsd ?? 0,
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
    _store = createSessionStore(appDataDir());
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

/** Shared singleton session store. Other modules MUST use this instead of
 *  createSessionStore() — separate instances have separate caches and clobber
 *  each other's writes on disk. */
export function getSessionStore(): SessionStore {
  return store();
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

/** Create a worktree for a session and persist its metadata; the orchestrator uses it as tool cwd. Throws on branch/path conflicts; renderer catches and falls back to the main checkout. */
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

/** Persist (or clear) the sticky skill reference. Set by the orchestrator when a `[[LOAD_SKILL:...]]` marker is processed; read on subsequent turns so the skill body stays in the system prompt for the whole session. Pass undefined to clear. */
export function setActiveSkillRef(
  sessionId: string,
  ref: { name: string; path: string; loadedAt: string } | undefined,
): void {
  store().setActiveSkillRef(sessionId, ref);
}

/** Copy a file from the workspace root into the worktree, mirroring subdirs; refuses path-traversal escapes and overwrites cleanly. */
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

/** Auto-detect common config files at the workspace root (.env, .env.local, etc.) for the new-session UI to pre-check. Returns relative paths that exist on disk. */
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

/** Headers only — no message bodies cross the IPC boundary for lists.
 *  Full sessions come from getSession on demand. */
export function listSessions(workspaceId: string): SessionHeader[] {
  return store().listSessions(workspaceId);
}

/** Sub-agent dispatch child headers for a parent session, newest first. */
export function listDispatches(parentId: string): SessionHeader[] {
  return store().listDispatches(parentId);
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
    thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
    providerId?: string;
  },
): HydratedSession {
  return hydrate(store().createSession(workspaceId, title, modelId, opts));
}

/** Fork a session into a new session with a different model. Copies the
 *  source's last assistant result message (with blocks/toolCalls/etc.) as
 *  the fork's first message — no LLM summarization. The source session is
 *  preserved unchanged. */
export async function forkWithSummary(
  sourceId: string,
  newModelId: string,
  opts?: {
    autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
    thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
    providerId?: string;
  },
): Promise<HydratedSession> {
  const forked = store().forkSession(sourceId, newModelId, opts);
  const source = store().getSession(sourceId);

  // Find the last assistant message with content — that's the result the user
  // is forking from. Copy it verbatim (blocks, toolCalls, reasoning, etc.) so
  // the fork starts with full context of where the conversation left off.
  const lastResult = source?.messages
    .slice().reverse()
    .find((m) => m.role === 'assistant' && m.content?.trim());

  if (lastResult) {
    store().addAssistantMessage(forked.id, {
      content: lastResult.content,
      blocks: lastResult.blocks,
      reasoning: lastResult.reasoning,
      reasoningTokens: lastResult.reasoningTokens,
      reasoningMs: lastResult.reasoningMs,
      totalMs: lastResult.totalMs,
      toolCalls: lastResult.toolCalls,
      timeline: lastResult.timeline,
      turn: {
        forkedFromResult: true,
        sourceTitle: source?.title ?? 'session',
      },
    });
  }

  return hydrate(store().getSession(forked.id)!);
}

export function updateSessionSettings(
  sessionId: string,
  patch: {
    autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
    thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
  },
): void {
  store().updateSessionSettings(sessionId, patch);
}

export function addMessage(sessionId: string, role: StoredMessage['role'], content: string, extra?: { attachments?: any[]; mentions?: any[] }): void {
  store().addMessage(sessionId, role, content, extra);
}

export function deleteSession(id: string): void {
  store().deleteSession(id);
  // Real session end: drop session-scoped "always allow" rules + any stale
  // permission-resolver state, and kill background dispatches bound to this
  // session's signal. Reachable from the delete button, ⌘⌫, and the
  // workspace-delete cascade. Best-effort — never fail the deletion over this.
  try {
    clearSessionRules(id);
    clearPermissionSession(id);
    abortSession(id);
  } catch {
    /* agent layer optional/unavailable — deletion already succeeded */
  }
}

export function clearAllSessions(): void {
  abortAllSessions();
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
    totalMs?: number;
    toolCalls?: any[];
    timeline?: any[];
    turn?: any;
  },
): void {
  store().addAssistantMessage(sessionId, message);
}

/** Upsert the final assistant message by messageId — updates the streaming
 *  partial in place (created by updatePartialAssistantMessage) instead of
 *  appending a second copy. */
export function finalizeAssistantMessage(
  sessionId: string,
  messageId: string,
  message: {
    content: string;
    blocks?: Block[];
    reasoning?: string;
    reasoningTokens?: number;
    reasoningMs?: number;
    totalMs?: number;
    toolCalls?: any[];
    timeline?: any[];
    turn?: any;
  },
): void {
  store().finalizeAssistantMessage(sessionId, messageId, message);
}

/** Update the last assistant message in-place (used by the streaming flush to persist partial state). If no assistant message exists yet, creates one. */
export function updatePartialAssistantMessage(
  sessionId: string,
  messageId: string,
  message: {
    content: string;
    blocks?: any[];
    reasoning?: string;
    toolCalls?: any[];
    timeline?: any[];
  },
): void {
  const s = store().getSession(sessionId);
  if (!s) return;
  // Find the assistant message by messageId (set as the message id in addAssistantMessage).
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === 'assistant' && last.id === messageId) {
    // Update in-place.
    last.content = message.content;
    if (message.blocks) last.blocks = message.blocks;
    if (message.reasoning !== undefined) last.reasoning = message.reasoning;
    if (message.toolCalls) last.toolCalls = message.toolCalls;
    if (message.timeline) last.timeline = message.timeline;
    last.createdAt = last.createdAt ?? new Date().toISOString();
    s.updatedAt = new Date().toISOString();
    store().updateSession(s);
  } else {
    // First flush — create the message.
    store().addAssistantMessage(sessionId, {
      content: message.content,
      blocks: message.blocks as Block[],
      reasoning: message.reasoning,
      toolCalls: message.toolCalls,
      timeline: message.timeline,
    });
    // Fix the id to match messageId so subsequent flushes find it.
    const msg = s.messages[s.messages.length - 1];
    if (msg) msg.id = messageId;
    store().updateSession(s);
  }
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
  lastStepUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoningTokens?: number;
    calls?: number;
    costUsd?: number;
  },
): void {
  store().addUsage(sessionId, delta, lastStepUsage);
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
