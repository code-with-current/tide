/** Part-normalized session storage (sessions-v2.db). Streaming deltas land in
 * the append-only `event` table; parts materialize on commit. Replaces the
 * JSON-per-session store — see docs/plans/2026-08-21-part-normalized-sessions-design.md. */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  model_id TEXT, provider_id TEXT,
  tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
  tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
  archived_at INTEGER,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_list ON session(workspace_path, archived_at, time_updated DESC);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role TEXT NOT NULL, model TEXT,
  time_created INTEGER NOT NULL, time_completed INTEGER
);

CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS part_window ON part(session_id, id);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, message_id TEXT, part_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL, time_created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS event_replay ON event(session_id, seq);
`;

export type V2Db = Database.Database;

export interface SessionMetaV2 {
  id: string;
  workspacePath: string;
  parentId: string | null;
  title: string;
  modelId: string | null;
  providerId: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  cost: number;
  summaryAdditions: number | null;
  summaryDeletions: number | null;
  summaryFiles: number | null;
  archivedAt: number | null;
  timeCreated: number;
  timeUpdated: number;
}

export interface CreateSessionInput {
  id: string;
  workspacePath: string;
  title: string;
  modelId: string;
  providerId?: string | null;
  parentId?: string | null;
}

export interface SessionListOpts {
  archived?: boolean;
  cursor?: string | null;
  limit?: number;
}

export interface InsertMessageInput {
  id: string;
  sessionId: string;
  role: string;
  model?: string | null;
}

export interface InsertPartInput {
  id: string;
  messageId: string;
  sessionId: string;
  seq: number;
  kind: string;
  data: unknown;
}

export interface MessagePartV2 {
  id: string;
  seq: number;
  kind: string;
  data: unknown;
}

export interface MessageV2 {
  id: string;
  role: string;
  model: string | null;
  timeCreated: number;
  timeCompleted: number | null;
  parts: MessagePartV2[];
}

export interface MessageWindowOpts {
  limit?: number;
  before?: string | null;
}

export interface UsageDeltaV2 {
  inputTokens: number;
  outputTokens: number;
  tokensReasoning?: number;
  tokensCacheRead?: number;
  costUsd: number;
}

export interface SessionStoreV2 {
  db: V2Db;
  pragma: (name: string) => unknown;
  tables: () => string[];
  close: () => void;
  createSession(o: CreateSessionInput): void;
  listSessions(workspacePath: string, opts?: SessionListOpts): { sessions: SessionMetaV2[]; nextCursor: string | null };
  insertMessage(o: InsertMessageInput): void;
  insertPart(o: InsertPartInput): void;
  sessionMessages(sessionId: string, opts?: MessageWindowOpts): { messages: MessageV2[]; nextBefore: string | null };
  addUsage(sessionId: string, delta: UsageDeltaV2): void;
  archiveSession(id: string): void;
  deleteSession(id: string): void;
}

const SESSION_COLUMNS = `
  id, workspace_path AS "workspacePath", parent_id AS "parentId", title,
  model_id AS "modelId", provider_id AS "providerId",
  tokens_input AS "tokensInput", tokens_output AS "tokensOutput",
  tokens_reasoning AS "tokensReasoning", tokens_cache_read AS "tokensCacheRead",
  cost, summary_additions AS "summaryAdditions", summary_deletions AS "summaryDeletions",
  summary_files AS "summaryFiles", archived_at AS "archivedAt",
  time_created AS "timeCreated", time_updated AS "timeUpdated"`;

const MESSAGE_COLUMNS = `
  id, role, model,
  time_created AS "timeCreated", time_completed AS "timeCompleted"`;

export function createSessionStoreV2(dbPath: string): SessionStoreV2 {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Baseline for future schema changes; 1 was never shipped (legacy store had no version).
  // Only bump up — an older binary must not downgrade a newer db.
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion < 2) {
    db.pragma('user_version = 2');
  }
  return {
    db,
    pragma: (name) => db.pragma(name, { simple: true }),
    tables: () =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((r) => r.name),
    close: () => db.close(),
    createSession(o) {
      const now = Date.now();
      db.prepare(
        'INSERT INTO session (id, workspace_path, parent_id, title, model_id, provider_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(o.id, o.workspacePath, o.parentId ?? null, o.title, o.modelId, o.providerId ?? null, now, now);
    },
    // Cursor is inclusive: the id of the first row of the next page. We fetch limit+1
    // and hand back the lookahead row's id, so nextCursor is null exactly when exhausted.
    listSessions(workspacePath, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const archivedFilter = opts?.archived ? 'IS NOT NULL' : 'IS NULL';
      const rows = opts?.cursor
        ? (db
            .prepare(
              `SELECT ${SESSION_COLUMNS} FROM session
               WHERE workspace_path = ? AND archived_at ${archivedFilter}
                 AND (time_updated, id) <= (SELECT time_updated, id FROM session WHERE id = ?)
               ORDER BY time_updated DESC, id DESC LIMIT ?`,
            )
            .all(workspacePath, opts.cursor, limit + 1) as SessionMetaV2[])
        : (db
            .prepare(
              `SELECT ${SESSION_COLUMNS} FROM session
               WHERE workspace_path = ? AND archived_at ${archivedFilter}
               ORDER BY time_updated DESC, id DESC LIMIT ?`,
            )
            .all(workspacePath, limit + 1) as SessionMetaV2[]);
      const hasMore = rows.length > limit;
      return {
        sessions: hasMore ? rows.slice(0, limit) : rows,
        nextCursor: hasMore ? rows[limit].id : null,
      };
    },
    insertMessage(o) {
      db.prepare('INSERT INTO message (id, session_id, role, model, time_created) VALUES (?, ?, ?, ?, ?)').run(
        o.id,
        o.sessionId,
        o.role,
        o.model ?? null,
        Date.now(),
      );
    },
    insertPart(o) {
      const now = Date.now();
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, seq, kind, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(o.id, o.messageId, o.sessionId, o.seq, o.kind, JSON.stringify(o.data), now, now);
    },
    sessionMessages(sessionId, opts) {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const rows = opts?.before
        ? (db
            .prepare(
              `SELECT ${MESSAGE_COLUMNS} FROM message
               WHERE session_id = ? AND id < ?
               ORDER BY id DESC LIMIT ?`,
            )
            .all(sessionId, opts.before, limit) as Omit<MessageV2, 'parts'>[])
        : (db
            .prepare(
              `SELECT ${MESSAGE_COLUMNS} FROM message
               WHERE session_id = ?
               ORDER BY id DESC LIMIT ?`,
            )
            .all(sessionId, limit) as Omit<MessageV2, 'parts'>[]);
      rows.reverse();
      const partsStmt = db.prepare('SELECT id, seq, kind, data FROM part WHERE message_id = ? ORDER BY seq');
      const messages: MessageV2[] = rows.map((m) => ({
        ...m,
        parts: (partsStmt.all(m.id) as (Omit<MessagePartV2, 'data'> & { data: string })[]).map(
          (p): MessagePartV2 => ({ ...p, data: JSON.parse(p.data) }),
        ),
      }));
      return { messages, nextBefore: rows.length === limit ? rows[0].id : null };
    },
    addUsage(sessionId, delta) {
      db.prepare(
        `UPDATE session SET
           tokens_input = tokens_input + ?,
           tokens_output = tokens_output + ?,
           tokens_reasoning = tokens_reasoning + ?,
           tokens_cache_read = tokens_cache_read + ?,
           cost = cost + ?,
           time_updated = ?
         WHERE id = ?`,
      ).run(
        delta.inputTokens,
        delta.outputTokens,
        delta.tokensReasoning ?? 0,
        delta.tokensCacheRead ?? 0,
        delta.costUsd,
        Date.now(),
        sessionId,
      );
    },
    archiveSession(id) {
      db.prepare('UPDATE session SET archived_at = ? WHERE id = ?').run(Date.now(), id);
    },
    deleteSession(id) {
      db.prepare('DELETE FROM session WHERE id = ?').run(id);
    },
  };
}
