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

export function createSessionStoreV2(dbPath: string): {
  db: V2Db;
  pragma: (name: string) => unknown;
  tables: () => string[];
  close: () => void;
} {
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
  };
}
