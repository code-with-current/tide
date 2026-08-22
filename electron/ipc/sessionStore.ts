/** Pure (Electron-free) session storage; `sessions.ts` wraps this with `app.getPath('userData')` and mirrors its API. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('sessions');

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  blocks?: any[];
  reasoning?: string;
  reasoningTokens?: number;
  reasoningMs?: number;
  totalMs?: number;
  toolCalls?: any[];
  timeline?: any[];
  turn?: any;
  attachments?: any[];
  compactionInfo?: { tokensBefore: number; tokensAfter: number };
}

export interface StoredSession {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  /** Provider half of model selection (disambiguates routing when the same modelId exists under multiple providers); absent on legacy sessions, which fall back to first-match by modelId. */
  providerId?: string;
  messages: StoredMessage[];
  createdAt: string;
  updatedAt: string;
  autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
  archivedAt?: string;
  /** Per-session git worktree isolation. Populated by setWorktree()
   *  when the user starts a session with worktree enabled. Tools run
   *  against `worktree.path` instead of the workspace's main checkout. */
  worktree?: {
    branch: string;
    path: string;
    baseCommit: string;
    baseBranch: string;
    ahead: number;
    behind: number;
  };
  /** Sub-agent linkage — set when this session was created by a
   *  dispatch_agent call. Absent on all legacy sessions (= main). */
  parentId?: string;
  kind?: 'main' | 'subagent';
  dispatch?: { agentName: string; title?: string; task: string; status?: 'running' | 'completed' | 'error' | 'interrupted' };
  /** Lossless ModelMessage[] transcript for resume — subagent sessions only. */
  modelMessages?: unknown[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    reasoningTokens: number;
    calls: number;
    costUsd: number;
  };
  /** Usage from the last completed turn only — used by the context-window
   *  meter. `usage` above is cumulative (sum across all turns). */
  lastTurnUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    reasoningTokens: number;
    calls: number;
    costUsd: number;
  };
  /** Audit trail of notable per-turn events (file loads, permission asks,
   *  tool reads/executions). Appended by addActivity; shown in the Inspector. */
  activity?: ActivityRecord[];
  /** Sticky skill reference set when a `[[LOAD_SKILL:...]]` marker is processed, re-injected into the system prompt on subsequent turns until cleared (different slash command or skill marker). */
  activeSkillRef?: {
    name: string;
    path: string;
    loadedAt: string;
  };
  /** Lineage: set when this session was forked from another (model change). */
  forkedFrom?: {
    sessionId: string;
    title: string;
  };
  /** Persisted todo list (flat) — survives app restart. Single source of
   *  truth for the floating panel. The legacy `todoGroups` field below is
   *  kept only to migrate old sessions on load (flattened into `todos`). */
  todos?: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    priority?: 'high' | 'medium' | 'low';
  }>;
  /** @deprecated legacy multi-group storage — read-only, flattened into `todos` on load. */
  todoGroups?: Array<{
    id: string;
    title: string;
    items: Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      priority?: 'high' | 'medium' | 'low';
    }>;
    createdAt: number;
  }>;
}

/** Shape persisted into StoredSession.activity. Structurally compatible with
 *  src/types ActivityEvent (the renderer hydrates to that). Kept local so
 *  sessionStore stays pure (no src/types import). */
export interface ActivityRecord {
  id: string;
  type: string;
  label: string;
  detail?: string;
  at: string;
  tone: 'ok' | 'warn' | 'bad' | 'accent' | 'muted';
}

export interface ArchivedHeader {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  archivedAt: string;
  updatedAt: string;
}

/** Lightweight list entry persisted in sessions/_index.json. The sidebar and
 *  session switchers only need these fields; full bodies load lazily via
 *  getSession. Kept in sync by writeSession on every mutation. */
export interface SessionHeader {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  providerId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Sub-agent linkage — present only on dispatch-created sessions. */
  kind?: 'main' | 'subagent';
  parentId?: string;
  /** Present when the session runs in an isolated git worktree — lets the
   *  branch popover group these branches under Worktrees without loading
   *  full session bodies. */
  worktree?: { branch: string; path: string; baseCommit: string; baseBranch: string; ahead: number; behind: number };
}

export interface SessionStore {
  // Populated lazily on first access (or explicitly via loadAll()).
  loadAll(): void;
  listSessions(workspaceId: string): SessionHeader[];
  /** Subagent dispatch headers for a parent session, newest first. */
  listDispatches(parentId: string): SessionHeader[];
  /** All subagent dispatch sessions (any parent), full bodies. Used by
   *  quit-time cleanup to mark still-running background dispatches
   *  interrupted. */
  listAllDispatches(): StoredSession[];
  /** Update a dispatch child's lifecycle status (running/completed/error/
   *  interrupted). Best-effort: unknown id is a no-op. */
  setDispatchStatus(id: string, status: 'running' | 'completed' | 'error' | 'interrupted'): void;
  /** Overwrite a dispatch child's transcript — chat messages plus the
   *  lossless ModelMessage[] needed for resume. */
  saveDispatchTranscript(id: string, messages: StoredMessage[], modelMessages: unknown[]): void;
  getSession(id: string): StoredSession | undefined;
  createSession(
    workspaceId: string,
    title: string,
    modelId: string,
    opts?: {
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
      providerId?: string;
      parentId?: string;
      kind?: 'main' | 'subagent';
      dispatch?: StoredSession['dispatch'];
    },
  ): StoredSession;
  /** Fork a session into a new session with a different model. Copies workspaceId/autonomy/thinking; starts with empty messages (the summary is added separately). Sets forkedFrom lineage. */
  forkSession(
    sourceId: string,
    newModelId: string,
    opts?: {
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
      providerId?: string;
    },
  ): StoredSession;
  /** Patch a session's mutable settings. NOTE: modelId/providerId are intentionally NOT mutable here — a session's model is locked at creation. Changing models requires forking into a new session (see forkSession). */
  updateSessionSettings(
    sessionId: string,
    patch: {
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
    },
  ): void;
  addMessage(sessionId: string, role: StoredMessage['role'], content: string, extra?: { attachments?: any[]; mentions?: any[] }): void;
  addAssistantMessage(
    sessionId: string,
    message: {
      content: string;
      blocks?: any[];
      reasoning?: string;
      reasoningTokens?: number;
      reasoningMs?: number;
      totalMs?: number;
      toolCalls?: any[];
      timeline?: any[];
      turn?: any;
    },
  ): void;
  addUsage(
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
  ): void;
  /** Append an audit event to the session's activity feed (Inspector). */
  addActivity(
    sessionId: string,
    event: Omit<ActivityRecord, 'id' | 'at'>,
  ): void;
  archiveSession(id: string): void;
  unarchiveSession(id: string): void;
  renameSession(id: string, title: string): void;
  listArchived(workspaceId: string): ArchivedHeader[];
  deleteSession(id: string): void;
  clearAllSessions(): void;
  /** Persist worktree metadata onto a session. Called after a successful
   *  `git worktree add` — the orchestrator reads this to resolve cwd. */
  setWorktree(
    sessionId: string,
    worktree: {
      branch: string;
      path: string;
      baseCommit: string;
      baseBranch: string;
      ahead: number;
      behind: number;
    },
  ): void;
  /** Persist (or clear with undefined) the sticky skill reference so the skill body stays in the system prompt across turns. */
  setActiveSkillRef(
    sessionId: string,
    ref: { name: string; path: string; loadedAt: string } | undefined,
  ): void;
  /** Write a full session object back to disk + cache. Used by the streaming flush to persist partial assistant turns. */
  updateSession(session: StoredSession): void;
  /** Persist the flat todo list so it survives app restart. */
  setTodos(sessionId: string, todos: Array<{ content: string; status: string; priority?: string }>): void;
  /** Upsert the final assistant message by messageId (updates the streaming
   *  partial in place; appends if none). Prevents partial+finalize duplicates. */
  finalizeAssistantMessage(
    sessionId: string,
    messageId: string,
    message: { content: string; blocks?: any[]; reasoning?: string; reasoningTokens?: number; reasoningMs?: number; totalMs?: number; toolCalls?: any[]; timeline?: any[]; turn?: any; compactionInfo?: { tokensBefore: number; tokensAfter: number } },
  ): void;
  /** Hook called BEFORE the session JSON is unlinked during delete.
   *  Lets the runtime cascade-remove the worktree directory + branch.
   *  Set via `setDeleteHook` so the store stays decoupled from git. */
  setDeleteHook(fn: (session: StoredSession) => void): void;
}

export function createSessionStore(rootDir: string): SessionStore {
  const sessionsDir = path.join(rootDir, 'sessions');
  const cache = new Map<string, StoredSession>();
  const headers = new Map<string, SessionHeader>();
  const archivedCache = new Map<string, ArchivedHeader>();
  const manifestPath = path.join(sessionsDir, '_archived.json');
  const indexPath = path.join(sessionsDir, '_index.json');
  let loaded = false;

  function ensureLoaded(): void {
    if (loaded) return;
    loadAll();
  }

  function headerOf(s: StoredSession): SessionHeader {
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      title: s.title,
      modelId: s.modelId,
      providerId: s.providerId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.parentId ? { parentId: s.parentId } : {}),
      ...(s.worktree ? { worktree: s.worktree } : {}),
    };
  }

  function writeIndex(): void {
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const tmp = `${indexPath}.tmp`;
    // v2: headers carry `worktree`. Versioned so an older cache without the
    // field is discarded once and rebuilt from the session files.
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, entries: Array.from(headers.values()) }, null, 2), 'utf-8');
    fs.renameSync(tmp, indexPath);
  }

  function readIndex(): void {
    headers.clear();
    if (!fs.existsSync(indexPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (parsed && parsed.v === 2 && Array.isArray(parsed.entries)) {
        for (const h of parsed.entries) {
          if (h && typeof h.id === 'string') headers.set(h.id, h);
        }
      }
    } catch (e) {
      log.warn('failed to parse _index.json', { err: e });
    }
  }

  /** Lazy body load: headers are always resident; full session JSON parses
   *  on first access only. Mutation paths must go through this, not cache.get. */
  function getOrLoad(id: string): StoredSession | undefined {
    const cached = cache.get(id);
    if (cached) return cached;
    if (!headers.has(id)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf-8')) as StoredSession;
      if (!parsed || typeof parsed.id !== 'string') return undefined;
      cache.set(parsed.id, parsed);
      return parsed;
    } catch (e) {
      log.warn('failed to lazy-load session', { id, err: e });
      return undefined;
    }
  }

  function writeSession(session: StoredSession): void {
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const target = path.join(sessionsDir, `${session.id}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
    headers.set(session.id, headerOf(session));
    writeIndex();
  }

  function writeManifest(): void {
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const tmp = `${manifestPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: Array.from(archivedCache.values()) }, null, 2), 'utf-8');
    fs.renameSync(tmp, manifestPath);
  }

  function readManifest(): void {
    archivedCache.clear();
    if (!fs.existsSync(manifestPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (parsed && Array.isArray(parsed.entries)) {
        for (const h of parsed.entries) {
          if (h && typeof h.id === 'string') archivedCache.set(h.id, h);
        }
      }
    } catch (e) {
      log.warn('failed to parse _archived.json', { err: e });
    }
  }

  function createSession(
    workspaceId: string,
    title: string,
    modelId: string,
    opts?: {
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
      providerId?: string;
      parentId?: string;
      kind?: 'main' | 'subagent';
      dispatch?: StoredSession['dispatch'];
    },
  ): StoredSession {
    ensureLoaded();
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: `s_${Math.random().toString(36).slice(2, 10)}`,
      workspaceId,
      title: title || 'New session',
      modelId,
      providerId: opts?.providerId,
      messages: [],
      createdAt: now,
      updatedAt: now,
      autonomyMode: opts?.autonomyMode ?? 'ask',
      thinkingLevel: opts?.thinkingLevel ?? 'medium',
      ...(opts?.parentId ? { parentId: opts.parentId } : {}),
      ...(opts?.kind ? { kind: opts.kind } : {}),
      ...(opts?.dispatch ? { dispatch: opts.dispatch } : {}),
    };
    writeSession(session);
    cache.set(session.id, session);
    if (opts?.kind === 'subagent' && opts?.parentId) pruneDispatchTranscript(opts.parentId, session.id);
    return session;
  }

  function forkSession(
    sourceId: string,
    newModelId: string,
    opts?: {
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
      providerId?: string;
    },
  ): StoredSession {
    ensureLoaded();
    const source = getOrLoad(sourceId);
    if (!source) throw new Error(`forkSession: source session ${sourceId} not found`);
    const now = new Date().toISOString();
    const forked: StoredSession = {
      id: `s_${Math.random().toString(36).slice(2, 10)}`,
      workspaceId: source.workspaceId,
      title: `Fork of ${source.title}`,
      modelId: newModelId,
      providerId: opts?.providerId,
      messages: [],
      createdAt: now,
      updatedAt: now,
      autonomyMode: opts?.autonomyMode ?? source.autonomyMode ?? 'ask',
      thinkingLevel: opts?.thinkingLevel ?? source.thinkingLevel ?? 'medium',
      forkedFrom: { sessionId: source.id, title: source.title },
    };
    writeSession(forked);
    cache.set(forked.id, forked);
    return forked;
  }

  function migrateLegacy(): void {
    const legacyPath = path.join(rootDir, 'sessions.json');
    const bakPath = path.join(rootDir, 'sessions.json.bak');

    if (!fs.existsSync(legacyPath)) return;
    if (fs.existsSync(bakPath)) return; // already migrated

    let parsed: { sessions?: StoredSession[] };
    try {
      parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    } catch (e) {
      log.warn('legacy sessions.json corrupt, moving aside', { error: e instanceof Error ? e.message : String(e) });
      // Corrupted — move aside so next startup is clean, then bail.
      const broken = path.join(rootDir, `sessions.json.broken-${Date.now()}`);
      fs.renameSync(legacyPath, broken);
      log.error('legacy file unparseable; moved aside', { dest: path.basename(broken) });
      return;
    }

    if (!parsed || !Array.isArray(parsed.sessions)) {
      // Wrong shape — treat as corrupted.
      const broken = path.join(rootDir, `sessions.json.broken-${Date.now()}`);
      fs.renameSync(legacyPath, broken);
      log.error('legacy file shape unexpected; moved aside', { dest: path.basename(broken) });
      return;
    }

    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    for (const session of parsed.sessions) {
      if (!session || typeof session.id !== 'string') continue;
      writeSession(session); // idempotent if file already exists (same data)
    }

    // Commit step — rename is the atomicity hinge.
    fs.renameSync(legacyPath, bakPath);
    log.info('migrated legacy sessions', { count: parsed.sessions.length });
  }

  function loadAll(): void {
    loaded = true; // set FIRST so ensureLoaded doesn't recurse
    cache.clear();
    migrateLegacy(); // no-op if already migrated or no legacy file
    readManifest();
    readIndex();

    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
      return;
    }

    // Reconcile the index with the directory: parse ONLY files the index
    // doesn't know about (normally zero), drop entries whose file is gone.
    // Session bodies are never parsed here — they lazy-load via getOrLoad.
    let indexDirty = false;
    const onDisk = new Set<string>();
    for (const entry of fs.readdirSync(sessionsDir)) {
      // Skip tmp orphans from interrupted writes (cleaned up here, not during write).
      if (!entry.endsWith('.json')) continue;
      if (entry.startsWith('_')) continue; // _archived.json / _index.json manifests
      const idFromName = entry.replace(/\.json$/, '');
      if (archivedCache.has(idFromName)) continue; // skip archived — don't load full body
      onDisk.add(idFromName);
      if (headers.has(idFromName)) continue;
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, entry), 'utf-8');
        const parsed = JSON.parse(raw) as StoredSession;
        if (!parsed || typeof parsed.id !== 'string') {
          log.warn('skipping malformed session file', { file: entry });
          continue;
        }
        headers.set(parsed.id, headerOf(parsed));
        indexDirty = true;
      } catch (e) {
        log.warn('failed to parse session file', { file: entry, err: e });
      }
    }
    for (const id of Array.from(headers.keys())) {
      if (!onDisk.has(id)) {
        headers.delete(id);
        indexDirty = true;
      }
    }
    if (indexDirty) writeIndex();
  }

  function listSessions(workspaceId: string): SessionHeader[] {
    ensureLoaded();
    return Array.from(headers.values()).filter((h) => h.workspaceId === workspaceId && h.kind !== 'subagent');
  }

  function listDispatches(parentId: string): SessionHeader[] {
    ensureLoaded();
    return Array.from(headers.values())
      .filter((h) => h.kind === 'subagent' && h.parentId === parentId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  function listAllDispatches(): StoredSession[] {
    ensureLoaded();
    return Array.from(headers.values())
      .filter((h) => h.kind === 'subagent')
      .map((h) => getOrLoad(h.id))
      .filter((s): s is StoredSession => Boolean(s));
  }

  function setDispatchStatus(id: string, status: 'running' | 'completed' | 'error' | 'interrupted'): void {
    ensureLoaded();
    const s = getOrLoad(id);
    if (!s?.dispatch) return;
    s.dispatch.status = status;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  const DISPATCH_CAP = 20;

  /** deleteSession requires the two-step archive→delete flow — calling it on
   *  an active session throws. keepId shields a just-created child: the
   *  updatedAt sort is unstable on timestamp ties, and without it a burst of
   *  dispatches created within the same millisecond could evict the child
   *  whose id createSession is about to return. */
  function pruneDispatchTranscript(parentId: string, keepId?: string): void {
    for (const child of listDispatches(parentId).slice(DISPATCH_CAP)) {
      if (child.id === keepId) continue;
      archiveSession(child.id);
      deleteSession(child.id);
    }
  }

  function saveDispatchTranscript(id: string, messages: StoredMessage[], modelMessages: unknown[]): void {
    ensureLoaded();
    const s = getOrLoad(id);
    if (!s) return;
    s.messages = messages;
    s.modelMessages = modelMessages;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function getSession(id: string): StoredSession | undefined {
    ensureLoaded();
    return getOrLoad(id);
  }

  /** Model is locked: only autonomy/thinking are mutable on an existing session. To change the model, fork (see forkSession). */
  function updateSessionSettings(
    sessionId: string,
    patch: {
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
    },
  ): void {
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    if (patch.autonomyMode !== undefined) s.autonomyMode = patch.autonomyMode;
    if (patch.thinkingLevel !== undefined) s.thinkingLevel = patch.thinkingLevel;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function addMessage(
    sessionId: string,
    role: StoredMessage['role'],
    content: string,
    extra?: { attachments?: any[]; mentions?: any[] },
  ): void {
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    const now = new Date().toISOString();
    s.messages.push({
      id: `m_${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      createdAt: now,
      // Persist attachments + mentions so chips survive reload — without
      // these, handleChipOpen can't match attachments (no absPath/isImage)
      // and the viewer can't reopen attached files.
      ...(extra?.attachments?.length ? { attachments: extra.attachments } : {}),
      ...(extra?.mentions?.length ? { mentions: extra.mentions } : {}),
    });
    s.updatedAt = now;
    if (s.title === 'New session' && role === 'user') {
      s.title = content.slice(0, 50) + (content.length > 50 ? '…' : '');
    }
    writeSession(s);
  }

  function addAssistantMessage(
    sessionId: string,
    message: {
      content: string;
      blocks?: any[];
      reasoning?: string;
      reasoningTokens?: number;
      reasoningMs?: number;
      totalMs?: number;
      toolCalls?: any[];
      timeline?: any[];
      turn?: any;
    },
  ): void {
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    const now = new Date().toISOString();
    s.messages.push({
      id: `m_${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content: message.content,
      createdAt: now,
      blocks: message.blocks,
      reasoning: message.reasoning,
      reasoningTokens: message.reasoningTokens,
      reasoningMs: message.reasoningMs,
      totalMs: message.totalMs,
      toolCalls: message.toolCalls,
      timeline: message.timeline,
      turn: message.turn,
    });
    s.updatedAt = now;
    writeSession(s);
  }

  /** Upsert an assistant message by messageId. The streaming flush already
   *  created this message (with this id) in storage; at turn end we must
   *  UPDATE it in place rather than append — otherwise the partial + the
   *  finalize produce two copies. Falls back to append when no partial exists
   *  (a short turn that never flushed). */
  function finalizeAssistantMessage(
    sessionId: string,
    messageId: string,
    message: {
      content: string;
      blocks?: any[];
      reasoning?: string;
      reasoningTokens?: number;
      reasoningMs?: number;
      totalMs?: number;
      toolCalls?: any[];
      timeline?: any[];
      turn?: any;
      compactionInfo?: { tokensBefore: number; tokensAfter: number };
      stopReason?: string | null;
    },
  ): void {
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    const now = new Date().toISOString();
    const existing = s.messages.find((m) => m.id === messageId && m.role === 'assistant');
    if (existing) {
      existing.content = message.content;
      if (message.blocks) existing.blocks = message.blocks;
      if (message.reasoning !== undefined) existing.reasoning = message.reasoning;
      if (message.reasoningTokens !== undefined) existing.reasoningTokens = message.reasoningTokens;
      if (message.reasoningMs !== undefined) existing.reasoningMs = message.reasoningMs;
      if (message.totalMs !== undefined) existing.totalMs = message.totalMs;
      if (message.toolCalls) existing.toolCalls = message.toolCalls;
      if (message.timeline) existing.timeline = message.timeline;
      if (message.turn !== undefined) existing.turn = message.turn;
      if (message.compactionInfo !== undefined) existing.compactionInfo = message.compactionInfo;
      if (message.stopReason !== undefined) existing.stopReason = message.stopReason ?? undefined;
    } else {
      s.messages.push({
        id: messageId,
        role: 'assistant',
        content: message.content,
        createdAt: now,
        blocks: message.blocks,
        reasoning: message.reasoning,
        reasoningTokens: message.reasoningTokens,
        reasoningMs: message.reasoningMs,
        totalMs: message.totalMs,
        toolCalls: message.toolCalls,
        timeline: message.timeline,
        turn: message.turn,
        compactionInfo: message.compactionInfo,
        stopReason: message.stopReason,
      });
    }
    s.updatedAt = now;
    writeSession(s);
  }

  function addUsage(
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
    /** The LAST step's actual usage — what the model's most recent request
     *  consumed. Stored as lastTurnUsage for the context meter. If omitted,
     *  falls back to the delta (for single-step turns they are the same). */
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
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    const cur = s.usage ?? {
      inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
      reasoningTokens: 0, calls: 0, costUsd: 0,
    };
    s.usage = {
      inputTokens: cur.inputTokens + (delta.inputTokens ?? 0),
      outputTokens: cur.outputTokens + (delta.outputTokens ?? 0),
      cacheRead: cur.cacheRead + (delta.cacheRead ?? 0),
      cacheWrite: cur.cacheWrite + (delta.cacheWrite ?? 0),
      reasoningTokens: cur.reasoningTokens + (delta.reasoningTokens ?? 0),
      calls: cur.calls + (delta.calls ?? 0),
      costUsd: cur.costUsd + (delta.costUsd ?? 0),
    };
    // Also update the top-level session.costUsd — the SessionHero displays
    // THIS field (not s.usage.costUsd). Both stay in sync.
    s.costUsd = s.usage.costUsd;
    // Store the last step's usage as lastTurnUsage — the context-window meter reads THIS (not cumulative s.usage) to show "how full is the context right now". For multi-step turns, lastStepUsage is the final LLM call's input tokens; falls back to delta for single-step turns or older callers.
    const src = lastStepUsage ?? delta;
    s.lastTurnUsage = {
      inputTokens: src.inputTokens ?? 0,
      outputTokens: src.outputTokens ?? 0,
      cacheRead: src.cacheRead ?? 0,
      cacheWrite: src.cacheWrite ?? 0,
      reasoningTokens: src.reasoningTokens ?? 0,
      calls: src.calls ?? 1,
      costUsd: src.costUsd ?? 0,
    };
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function addActivity(
    sessionId: string,
    event: Omit<ActivityRecord, 'id' | 'at'>,
  ): void {
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    if (!Array.isArray(s.activity)) s.activity = [];
    // Newest-first (matches the Inspector's render order). Cap to keep the
    // persisted file from growing unbounded over a long session.
    s.activity.unshift({
      id: `a_${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...event,
    });
    if (s.activity.length > 200) s.activity.length = 200;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function deleteSession(id: string): void {
    ensureLoaded();
    // Unknown id: silent no-op (matches existing patterns).
    if (!headers.has(id) && !archivedCache.has(id)) return;

    // Two-step flow: must be archived first.
    if (headers.has(id)) {
      throw new Error('Session must be archived before deletion');
    }

    // Cascade: if the session has a worktree, fire the delete hook so the runtime can `git worktree remove` + `git branch -D` before we unlink the JSON (which would orphan worktree metadata). The archived manifest only carries headers — read the full session from disk to get the worktree field.
    const file = path.join(sessionsDir, `${id}.json`);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const stored = JSON.parse(raw) as StoredSession;
      if (stored.worktree) deleteHook(stored);
    } catch { /* file missing or invalid — nothing to cascade */ }

    // Archived — proceed with delete.
    archivedCache.delete(id);
    writeManifest();
    headers.delete(id);
    writeIndex();
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
  }

  let deleteHook: (s: StoredSession) => void = () => {};
  function setDeleteHook(fn: (s: StoredSession) => void): void {
    deleteHook = fn;
  }

  function setWorktree(
    sessionId: string,
    worktree: {
      branch: string;
      path: string;
      baseCommit: string;
      baseBranch: string;
      ahead: number;
      behind: number;
    },
  ): void {
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    s.worktree = worktree;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function setActiveSkillRef(
    sessionId: string,
    ref: { name: string; path: string; loadedAt: string } | undefined,
  ): void {
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    if (ref) s.activeSkillRef = ref;
    else delete s.activeSkillRef;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function updateSession(session: StoredSession): void {
    ensureLoaded();
    cache.set(session.id, session);
    writeSession(session);
  }

  function setTodos(sessionId: string, todos: Array<{ content: string; status: string; priority?: string }>): void {
    ensureLoaded();
    const s = getOrLoad(sessionId);
    if (!s) return;
    s.todos = todos as any;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function clearAllSessions(): void {
    // Wipe in-memory state.
    cache.clear();
    headers.clear();
    archivedCache.clear();
    loaded = true;

    // Wipe on-disk state. Remove the whole sessions/ directory and recreate empty.
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Remove legacy artifacts.
    for (const legacy of ['sessions.json.bak']) {
      const p = path.join(rootDir, legacy);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
    for (const entry of fs.readdirSync(rootDir)) {
      if (entry.startsWith('sessions.json.broken-')) {
        try { fs.unlinkSync(path.join(rootDir, entry)); } catch { /* ignore */ }
      }
    }
    // Note: config.json is intentionally untouched.
  }

  function archiveSession(id: string): void {
    ensureLoaded();
    const s = getOrLoad(id);
    if (!s) return; // already archived or unknown — idempotent
    const header: ArchivedHeader = {
      id: s.id,
      workspaceId: s.workspaceId,
      title: s.title,
      modelId: s.modelId,
      archivedAt: new Date().toISOString(),
      updatedAt: s.updatedAt,
    };
    cache.delete(id);
    headers.delete(id);
    archivedCache.set(id, header);
    writeManifest();
    // Full session file on disk is intentionally left untouched.
  }

  function unarchiveSession(id: string): void {
    ensureLoaded();
    const header = archivedCache.get(id);
    if (!header) return; // not archived — idempotent

    // Lazy-load the full session from disk.
    const file = path.join(sessionsDir, `${id}.json`);
    let session: StoredSession | undefined;
    try {
      session = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      log.warn('failed to load archived session', { id, err: e });
      return;
    }
    if (!session) return;

    delete session.archivedAt; // presence === archived; clearing unarchives
    cache.set(id, session);
    archivedCache.delete(id);
    writeManifest();
    writeSession(session); // persist the cleared archivedAt (also restores its header)
  }

  function listArchived(workspaceId: string): ArchivedHeader[] {
    ensureLoaded();
    return Array.from(archivedCache.values()).filter(h => h.workspaceId === workspaceId);
  }

  function renameSession(id: string, title: string): void {
    ensureLoaded();
    const active = getOrLoad(id);
    if (active) {
      active.title = title;
      active.updatedAt = new Date().toISOString();
      writeSession(active);
      return;
    }
    const header = archivedCache.get(id);
    if (header) {
      header.title = title;
      writeManifest();
      return;
    }
    // unknown id — silent no-op (matches existing patterns)
  }

  return {
    loadAll,
    listSessions,
    listDispatches,
    listAllDispatches,
    setDispatchStatus,
    saveDispatchTranscript,
    getSession,
    createSession,
    forkSession,
    updateSessionSettings,
    addMessage,
    addAssistantMessage,
    addUsage,
    addActivity,
    deleteSession,
    clearAllSessions,
    archiveSession,
    unarchiveSession,
    renameSession,
    listArchived,
    setWorktree,
    setActiveSkillRef,
    updateSession,
    setTodos,
    finalizeAssistantMessage,
    setDeleteHook,
  };
}
