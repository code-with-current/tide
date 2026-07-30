/**
 * Pure session storage — no Electron imports, fully testable.
 *
 * All public functions on the returned object mirror the existing
 * `sessions.ts` API exactly. `sessions.ts` becomes a thin wrapper
 * that instantiates this with `app.getPath('userData')`.
 */

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
  toolCalls?: any[];
  timeline?: any[];
  turn?: any;
  attachments?: any[];
}

export interface StoredSession {
  id: string;
  workspaceId: string;
  title: string;
  modelId: string;
  /**
   * Provider half of the model selection. The same model id can exist under
   * multiple providers, so this disambiguates routing. Absent on sessions
   * created before this field existed — callers fall back to first-match by
   * modelId.
   */
  providerId?: string;
  messages: StoredMessage[];
  createdAt: string;
  updatedAt: string;
  autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';
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
  usage?: {
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
  /**
   * Sticky skill reference — set when a `[[LOAD_SKILL:...]]` marker is
   * processed on turn 1, re-injected into the system prompt on every
   * subsequent turn until cleared. Without this, continuation turns lose
   * the skill body because the marker was stripped from the persisted user
   * message and the orchestrator rebuilds the system prompt from scratch.
   * Cleared when the user issues a different slash command or a different
   * skill marker is processed (replacing the active skill).
   */
  activeSkillRef?: {
    name: string;
    path: string;
    loadedAt: string;
  };
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

export interface SessionStore {
  // Populated lazily on first access (or explicitly via loadAll()).
  loadAll(): void;
  listSessions(workspaceId: string): StoredSession[];
  getSession(id: string): StoredSession | undefined;
  createSession(
    workspaceId: string,
    title: string,
    modelId: string,
    opts?: {
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';
      providerId?: string;
    },
  ): StoredSession;
  updateSessionSettings(
    sessionId: string,
    patch: {
      modelId?: string;
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';
      providerId?: string;
    },
  ): void;
  addMessage(sessionId: string, role: StoredMessage['role'], content: string): void;
  addAssistantMessage(
    sessionId: string,
    message: {
      content: string;
      blocks?: any[];
      reasoning?: string;
      reasoningTokens?: number;
      reasoningMs?: number;
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
  /** Persist (or clear) the sticky skill reference. Set by the orchestrator
   *  when a `[[LOAD_SKILL:...]]` marker is processed; re-read on subsequent
   *  turns so the skill body stays in the system prompt for the whole session.
   *  Pass `undefined` to clear (different slash command, skill complete, etc.). */
  setActiveSkillRef(
    sessionId: string,
    ref: { name: string; path: string; loadedAt: string } | undefined,
  ): void;
  /** Hook called BEFORE the session JSON is unlinked during delete.
   *  Lets the runtime cascade-remove the worktree directory + branch.
   *  Set via `setDeleteHook` so the store stays decoupled from git. */
  setDeleteHook(fn: (session: StoredSession) => void): void;
}

export function createSessionStore(rootDir: string): SessionStore {
  const sessionsDir = path.join(rootDir, 'sessions');
  const cache = new Map<string, StoredSession>();
  const archivedCache = new Map<string, ArchivedHeader>();
  const manifestPath = path.join(sessionsDir, '_archived.json');
  let loaded = false;

  function ensureLoaded(): void {
    if (loaded) return;
    loadAll();
  }

  function writeSession(session: StoredSession): void {
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    const target = path.join(sessionsDir, `${session.id}.json`);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
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
      thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';
      providerId?: string;
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
    };
    writeSession(session);
    cache.set(session.id, session);
    return session;
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

    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
      return;
    }

    for (const entry of fs.readdirSync(sessionsDir)) {
      // Skip tmp orphans from interrupted writes (cleaned up here, not during write).
      if (!entry.endsWith('.json')) continue;
      if (entry.startsWith('_')) continue; // _archived.json manifest
      const idFromName = entry.replace(/\.json$/, '');
      if (archivedCache.has(idFromName)) continue; // skip archived — don't load full body
      const fullPath = path.join(sessionsDir, entry);
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(raw) as StoredSession;
        if (!parsed || typeof parsed.id !== 'string') {
          log.warn('skipping malformed session file', { file: entry });
          continue;
        }
        cache.set(parsed.id, parsed);
      } catch (e) {
        log.warn('failed to parse session file', { file: entry, err: e });
        // Don't surface to renderer here — Phase 5 error handling will
        // emit a sessionFileCorrupted event. For now, log + skip.
      }
    }
  }

  function listSessions(workspaceId: string): StoredSession[] {
    ensureLoaded();
    return Array.from(cache.values()).filter((s) => s.workspaceId === workspaceId);
  }

  function getSession(id: string): StoredSession | undefined {
    ensureLoaded();
    return cache.get(id);
  }

  function updateSessionSettings(
    sessionId: string,
    patch: {
      modelId?: string;
      autonomyMode?: 'ask' | 'plan' | 'edit' | 'full';
      thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max';
      providerId?: string;
    },
  ): void {
    ensureLoaded();
    const s = cache.get(sessionId);
    if (!s) return;
    if (patch.modelId !== undefined) s.modelId = patch.modelId;
    if (patch.providerId !== undefined) s.providerId = patch.providerId;
    if (patch.autonomyMode !== undefined) s.autonomyMode = patch.autonomyMode;
    if (patch.thinkingLevel !== undefined) s.thinkingLevel = patch.thinkingLevel;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function addMessage(
    sessionId: string,
    role: StoredMessage['role'],
    content: string,
  ): void {
    ensureLoaded();
    const s = cache.get(sessionId);
    if (!s) return;
    const now = new Date().toISOString();
    s.messages.push({
      id: `m_${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      createdAt: now,
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
      toolCalls?: any[];
      timeline?: any[];
      turn?: any;
    },
  ): void {
    ensureLoaded();
    const s = cache.get(sessionId);
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
      toolCalls: message.toolCalls,
      timeline: message.timeline,
      turn: message.turn,
    });
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
  ): void {
    ensureLoaded();
    const s = cache.get(sessionId);
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
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function addActivity(
    sessionId: string,
    event: Omit<ActivityRecord, 'id' | 'at'>,
  ): void {
    ensureLoaded();
    const s = cache.get(sessionId);
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
    if (!cache.has(id) && !archivedCache.has(id)) return;

    // Two-step flow: must be archived first.
    if (cache.has(id)) {
      throw new Error('Session must be archived before deletion');
    }

    // Cascade: if the session has a worktree, fire the delete hook so
    // the runtime can `git worktree remove` + `git branch -D` before we
    // unlink the JSON (which would orphan the worktree metadata).
    // The archived manifest only carries headers — read the full session
    // from disk to get the worktree field.
    const file = path.join(sessionsDir, `${id}.json`);
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const stored = JSON.parse(raw) as StoredSession;
      if (stored.worktree) deleteHook(stored);
    } catch { /* file missing or invalid — nothing to cascade */ }

    // Archived — proceed with delete.
    archivedCache.delete(id);
    writeManifest();
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
    const s = cache.get(sessionId);
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
    const s = cache.get(sessionId);
    if (!s) return;
    if (ref) s.activeSkillRef = ref;
    else delete s.activeSkillRef;
    s.updatedAt = new Date().toISOString();
    writeSession(s);
  }

  function clearAllSessions(): void {
    // Wipe in-memory state.
    cache.clear();
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
    const s = cache.get(id);
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
    writeSession(session); // persist the cleared archivedAt
  }

  function listArchived(workspaceId: string): ArchivedHeader[] {
    ensureLoaded();
    return Array.from(archivedCache.values()).filter(h => h.workspaceId === workspaceId);
  }

  function renameSession(id: string, title: string): void {
    ensureLoaded();
    const active = cache.get(id);
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
    getSession,
    createSession,
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
    setDeleteHook,
  };
}
