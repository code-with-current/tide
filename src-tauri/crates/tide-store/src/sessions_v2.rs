//! sessions-v2.db reader ported from `app/core/ipc-adjacent/session-store-v2.ts` @ 91ec558.
//!
//! The db is part-normalized (`session`/`message`/`part`/`event`,
//! `user_version` 2, WAL journal). This module only reads — no migrations:
//! `open` fails unless `user_version` is exactly 2. Wire types mirror
//! `shared/rpc.ts` (`SessionMetaV2`, `SessionPartV2`, `SessionMessageV2` and
//! the two page shapes): camelCase, and nullable fields serialize as JSON
//! `null` (the TS types are `T | null`, not optional — never omit them).
//! Part `data` is passed through verbatim (`unknown` on the wire); the
//! renderer owns any kind→block mapping.
//!
//! The legacy `SessionHeader`/`ArchivedSessionHeader` readers derive the old
//! sidebar shapes from the same rows: ISO-8601 timestamps (`new
//! Date(ms).toISOString()` parity), message-row counts, and the TS filters
//! (subagents and archived rows never list; the archived list is archived
//! rows only). `worktree` is not derivable from v2 and is omitted.

use std::error::Error as StdError;
use std::fmt;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

const SESSION_COLUMNS: &str = "id, workspace_path, parent_id, title, model_id, provider_id, \
     tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, cost, \
     summary_additions, summary_deletions, summary_files, archived_at, \
     time_created, time_updated";

const MESSAGE_COLUMNS: &str = "id, role, model, time_created, time_completed";

#[derive(Debug)]
pub enum SessionsV2Error {
    /// Database file missing or unopenable.
    Open { path: PathBuf, cause: String },
    /// `user_version` is not 2 — M1 reads exactly v2 and never migrates.
    UnsupportedSchema { found: i64 },
    /// SQLite query/step failure.
    Db(rusqlite::Error),
    /// `part.data` is not valid JSON (`JSON.parse` in the TS threw the same way).
    InvalidPartData {
        part_id: String,
        message_id: String,
        source: serde_json::Error,
    },
}

impl fmt::Display for SessionsV2Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Open { path, cause } => {
                write!(f, "cannot open sessions-v2 db {}: {cause}", path.display())
            }
            Self::UnsupportedSchema { found } => {
                write!(f, "sessions-v2 db user_version is {found}, expected 2 — this build reads v2 only (no migrations)")
            }
            Self::Db(e) => write!(f, "sqlite: {e}"),
            Self::InvalidPartData {
                part_id, message_id, ..
            } => write!(f, "part {part_id} of message {message_id} has non-JSON data"),
        }
    }
}

impl StdError for SessionsV2Error {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        match self {
            Self::Db(e) => Some(e),
            Self::InvalidPartData { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for SessionsV2Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e)
    }
}

pub type Result<T> = std::result::Result<T, SessionsV2Error>;

/// `sessionListV2` params' `opts` (`SessionListOptsV2` in shared/rpc.ts).
/// TS `?` optionals: omitted on the wire when unset.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListOptsV2 {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

/// `sessionMessagesV2` params' `opts` (`SessionWindowOptsV2` in shared/rpc.ts).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWindowOptsV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

/// `SessionMetaV2` in shared/rpc.ts — one `session` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaV2 {
    pub id: String,
    pub workspace_path: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub model_id: Option<String>,
    pub provider_id: Option<String>,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_reasoning: i64,
    pub tokens_cache_read: i64,
    pub cost: f64,
    pub summary_additions: Option<i64>,
    pub summary_deletions: Option<i64>,
    pub summary_files: Option<i64>,
    pub archived_at: Option<i64>,
    pub time_created: i64,
    pub time_updated: i64,
}

/// `SessionPartV2` in shared/rpc.ts — one committed `part` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPartV2 {
    pub id: String,
    pub seq: i64,
    pub kind: String,
    pub data: Value,
}

/// `SessionMessageV2` in shared/rpc.ts — one `message` row with its parts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessageV2 {
    pub id: String,
    pub role: String,
    pub model: Option<String>,
    pub time_created: i64,
    pub time_completed: Option<i64>,
    pub parts: Vec<SessionPartV2>,
}

/// `sessionListV2` response: `{ sessions, nextCursor }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListPageV2 {
    pub sessions: Vec<SessionMetaV2>,
    pub next_cursor: Option<String>,
}

/// `sessionMessagesV2` response: `{ messages, nextBefore }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessagesPageV2 {
    pub messages: Vec<SessionMessageV2>,
    pub next_before: Option<String>,
}

/// `SessionHeader` in shared/rpc.ts — the legacy sidebar-list shape, derived
/// from v2 rows. Matching the 91ec558 producer (`sessionStore.listSessions`):
/// subagent rows (`parent_id` set) never appear, archived rows never appear,
/// `messageCount` counts ALL message rows, and a null `model_id` coerces to
/// `""`. `providerId`/`parentId` are TS `?` optionals — omitted when unset.
/// `worktree` is NOT derivable (the v2 schema has no worktree columns; only
/// the legacy JSON store carried it) and is omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeaderWire {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

/// `ArchivedSessionHeader` in shared/rpc.ts — the legacy Archived-section
/// shape (`sessionStore.listArchived`). Ordering follows the TS manifest's
/// insertion order: first-archive chronological.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedHeaderWire {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub model_id: String,
    pub archived_at: String,
    pub updated_at: String,
}

#[derive(Debug)]
pub struct SessionsV2 {
    conn: Connection,
}

impl SessionsV2 {
    /// Opens an existing sessions-v2.db for reading. WAL is a persistent
    /// property of the file (the writer set it), so a reader never issues
    /// `journal_mode`. A read-only handle is preferred, but opening one can
    /// fail when SQLite must rebuild the WAL index — in that case fall back
    /// to a read-write handle pinned with `query_only` so writes stay
    /// impossible either way.
    pub fn open<P: AsRef<Path>>(db_path: P) -> Result<Self> {
        let path = db_path.as_ref().to_path_buf();
        if !path.is_file() {
            return Err(SessionsV2Error::Open {
                path,
                cause: "file not found".into(),
            });
        }
        let conn = match open_read_only(&path) {
            Ok(conn) => conn,
            Err(_) => {
                let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                    .map_err(|e| SessionsV2Error::Open {
                        path: path.clone(),
                        cause: e.to_string(),
                    })?;
                conn.pragma_update(None, "query_only", true)?;
                conn
            }
        };
        let found: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if found != 2 {
            return Err(SessionsV2Error::UnsupportedSchema { found });
        }
        Ok(Self { conn })
    }

    /// Port of `listSessions`: newest first within a workspace, archived
    /// excluded unless requested. The cursor is inclusive — the id of the
    /// first row of the next page — and is null exactly when exhausted
    /// (fetch limit+1, hand back the lookahead row's id).
    pub fn list_sessions(
        &self,
        workspace_path: &str,
        opts: SessionListOptsV2,
    ) -> Result<SessionListPageV2> {
        let limit = opts.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        let fetch = limit as i64 + 1;
        let archived_filter = if opts.archived {
            "IS NOT NULL"
        } else {
            "IS NULL"
        };
        let mut sessions = match opts.cursor.as_deref() {
            Some(cursor) => {
                let sql = format!(
                    "SELECT {SESSION_COLUMNS} FROM session
                     WHERE workspace_path = ?1 AND archived_at {archived_filter}
                       AND (time_updated, id) <= (SELECT time_updated, id FROM session WHERE id = ?2)
                     ORDER BY time_updated DESC, id DESC LIMIT ?3"
                );
                self.query_sessions(&sql, rusqlite::params![workspace_path, cursor, fetch])?
            }
            None => {
                let sql = format!(
                    "SELECT {SESSION_COLUMNS} FROM session
                     WHERE workspace_path = ?1 AND archived_at {archived_filter}
                     ORDER BY time_updated DESC, id DESC LIMIT ?2"
                );
                self.query_sessions(&sql, rusqlite::params![workspace_path, fetch])?
            }
        };
        let next_cursor = sessions.get(limit).map(|s| s.id.clone());
        sessions.truncate(limit);
        Ok(SessionListPageV2 {
            sessions,
            next_cursor,
        })
    }

    /// Port of `sessionMessages`: fetch the newest `limit` messages (strictly
    /// below `before` when given), return them oldest-first with parts
    /// ordered by seq. A full page advertises its oldest id as `nextBefore`.
    pub fn session_messages(
        &self,
        session_id: &str,
        opts: SessionWindowOptsV2,
    ) -> Result<SessionMessagesPageV2> {
        let limit = opts.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        let fetch = limit as i64;
        let mut messages = match opts.before.as_deref() {
            Some(before) => {
                let sql = format!(
                    "SELECT {MESSAGE_COLUMNS} FROM message
                     WHERE session_id = ?1 AND id < ?2
                     ORDER BY id DESC LIMIT ?3"
                );
                self.query_messages(&sql, rusqlite::params![session_id, before, fetch])?
            }
            None => {
                let sql = format!(
                    "SELECT {MESSAGE_COLUMNS} FROM message
                     WHERE session_id = ?1
                     ORDER BY id DESC LIMIT ?2"
                );
                self.query_messages(&sql, rusqlite::params![session_id, fetch])?
            }
        };
        messages.reverse();
        for message in &mut messages {
            message.parts = self.parts_of(&message.id)?;
        }
        let next_before = if messages.len() == limit {
            Some(messages[0].id.clone())
        } else {
            None
        };
        Ok(SessionMessagesPageV2 {
            messages,
            next_before,
        })
    }

    /// Legacy `listSessions` (91ec558 sessionStore.ts) derived from v2 rows:
    /// non-archived, non-subagent sessions of one workspace, newest first.
    /// `workspace_id` is the config-workspace id the caller resolved
    /// `workspace_path` from — the TS headers carried it verbatim, so it is
    /// stamped onto every row here rather than reverse-mapped.
    pub fn list_session_headers(
        &self,
        workspace_path: &str,
        workspace_id: &str,
    ) -> Result<Vec<SessionHeaderWire>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.title, s.model_id, s.provider_id, s.time_created, s.time_updated, \
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) \
             FROM session s \
             WHERE s.workspace_path = ?1 AND s.archived_at IS NULL AND s.parent_id IS NULL \
             ORDER BY s.time_updated DESC, s.id DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![workspace_path], |row| {
            Ok(SessionHeaderWire {
                id: row.get(0)?,
                workspace_id: workspace_id.to_owned(),
                title: row.get(1)?,
                model_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                provider_id: row.get(3)?,
                created_at: iso_from_unix_ms(row.get(4)?),
                updated_at: iso_from_unix_ms(row.get(5)?),
                message_count: row.get(6)?,
                kind: "main".to_owned(),
                parent_id: None,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Legacy `listArchived` derived from v2 rows: archived sessions of one
    /// workspace, in first-archive order (the TS manifest's insertion order).
    pub fn list_archived_headers(
        &self,
        workspace_path: &str,
        workspace_id: &str,
    ) -> Result<Vec<ArchivedHeaderWire>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.title, s.model_id, s.archived_at, s.time_updated \
             FROM session s \
             WHERE s.workspace_path = ?1 AND s.archived_at IS NOT NULL \
             ORDER BY s.archived_at ASC, s.id ASC",
        )?;
        let rows = stmt.query_map(rusqlite::params![workspace_path], |row| {
            Ok(ArchivedHeaderWire {
                id: row.get(0)?,
                workspace_id: workspace_id.to_owned(),
                title: row.get(1)?,
                model_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                archived_at: iso_from_unix_ms(row.get::<_, Option<i64>>(3)?.unwrap_or_default()),
                updated_at: iso_from_unix_ms(row.get(4)?),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn query_sessions(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<SessionMetaV2>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, session_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn query_messages(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<SessionMessageV2>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, |row| {
            Ok(SessionMessageV2 {
                id: row.get(0)?,
                role: row.get(1)?,
                model: row.get(2)?,
                time_created: row.get(3)?,
                time_completed: row.get(4)?,
                parts: Vec::new(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn parts_of(&self, message_id: &str) -> Result<Vec<SessionPartV2>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, seq, kind, data FROM part WHERE message_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map(rusqlite::params![message_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let mut parts = Vec::new();
        for row in rows {
            let (id, seq, kind, data) = row?;
            let data = serde_json::from_str(&data).map_err(|source| {
                SessionsV2Error::InvalidPartData {
                    part_id: id.clone(),
                    message_id: message_id.to_owned(),
                    source,
                }
            })?;
            parts.push(SessionPartV2 { id, seq, kind, data });
        }
        Ok(parts)
    }
}

fn open_read_only(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| {
        SessionsV2Error::Open {
            path: path.to_path_buf(),
            cause: e.to_string(),
        }
    })?;
    // Force WAL-index recovery now, while the read-write fallback is possible.
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    Ok(conn)
}

fn session_from_row(row: &Row<'_>) -> rusqlite::Result<SessionMetaV2> {
    Ok(SessionMetaV2 {
        id: row.get(0)?,
        workspace_path: row.get(1)?,
        parent_id: row.get(2)?,
        title: row.get(3)?,
        model_id: row.get(4)?,
        provider_id: row.get(5)?,
        tokens_input: row.get(6)?,
        tokens_output: row.get(7)?,
        tokens_reasoning: row.get(8)?,
        tokens_cache_read: row.get(9)?,
        cost: row.get(10)?,
        summary_additions: row.get(11)?,
        summary_deletions: row.get(12)?,
        summary_files: row.get(13)?,
        archived_at: row.get(14)?,
        time_created: row.get(15)?,
        time_updated: row.get(16)?,
    })
}

/// `new Date(ms).toISOString()`: UTC, always 3 fractional digits, `Z` suffix.
/// The legacy headers carried ISO strings while v2 stores unix millis, so
/// every legacy-shaped reader converts through here.
fn iso_from_unix_ms(ms: i64) -> String {
    let secs_total = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs_total.div_euclid(86_400);
    let secs_of_day = secs_total.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hh, mm, ss) = (
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60,
    );
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// Days-since-epoch to (y, m, d) — Howard Hinnant's civil_from_days, valid
/// for the whole i64 range the millis column can hold (incl. pre-1970).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    /// The SCHEMA string from session-store-v2.ts, verbatim (bar formatting).
    const V2_SCHEMA: &str = "
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
        CREATE INDEX IF NOT EXISTS message_session ON message(session_id, id);
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
        CREATE INDEX IF NOT EXISTS part_message ON part(message_id, seq);
        CREATE TABLE IF NOT EXISTS event (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL, message_id TEXT, part_id TEXT,
          type TEXT NOT NULL,
          data TEXT NOT NULL, time_created INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS event_replay ON event(session_id, seq);";

    struct Db {
        dir: PathBuf,
        conn: Connection,
    }

    impl Drop for Db {
        fn drop(&mut self) {
            // The connection may still be open here (fields drop after this),
            // but unlinking open files is fine on unix and best-effort anyway.
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tide-store-sessions-v2-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Schema + representative seed: a mixed-part session, an archived
    /// session, two workspaces, and a 7-message session for windowing.
    fn synthetic_db(name: &str) -> Db {
        let dir = temp_dir(name);
        let mut db_path = dir.clone();
        db_path.push("sessions-v2.db");
        let conn = Connection::open(&db_path).unwrap();
        let _: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
            .unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(V2_SCHEMA).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();

        insert_session(&conn, "s-arch", "/ws/alpha", "Archived", 5_000, Some(4_900));
        insert_session(&conn, "s-two", "/ws/alpha", "Two", 4_000, None);
        insert_session(&conn, "s-one", "/ws/alpha", "One", 3_000, None);
        // Tie on time_updated — id DESC must break it ("s-three" > "s-four").
        insert_session(&conn, "s-three", "/ws/alpha", "Three", 2_000, None);
        insert_session(&conn, "s-four", "/ws/alpha", "Four", 2_000, None);
        insert_session(&conn, "s-beta", "/ws/beta", "Beta", 1_000, None);
        insert_session(&conn, "s-long", "/ws/gamma", "Long", 6_000, None);

        insert_message(&conn, "a1-m1", "s-one", "user", None);
        insert_part(&conn, "a1-m1-p0", "a1-m1", "s-one", 0, "text", r#"{"text":"hello tide"}"#);
        insert_message(&conn, "a1-m2", "s-one", "assistant", Some("model-x"));
        // Inserted out of seq order: the reader must return seq order.
        insert_part(&conn, "a1-m2-p2", "a1-m2", "s-one", 2, "tool",
            r#"{"toolName":"bash","input":{"cmd":"ls"},"output":"x\n","status":"completed","durationMs":12}"#);
        insert_part(&conn, "a1-m2-p0", "a1-m2", "s-one", 0, "thinking", r#"{"text":"pondering"}"#);
        insert_part(&conn, "a1-m2-p1", "a1-m2", "s-one", 1, "text", r#"{"text":"answer"}"#);

        for i in 1..=7 {
            let id = format!("msg-{i:02}");
            insert_message(&conn, &id, "s-long", "assistant", Some("model-x"));
            insert_part(&conn, &format!("{id}-p0"), &id, "s-long", 0, "text",
                &format!(r#"{{"text":"long {i}"}}"#));
        }

        Db { dir, conn }
    }

    fn insert_session(
        conn: &Connection,
        id: &str,
        workspace_path: &str,
        title: &str,
        time_updated: i64,
        archived_at: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO session (id, workspace_path, parent_id, title, model_id, provider_id, \
             tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, cost, \
             summary_additions, summary_deletions, summary_files, archived_at, \
             time_created, time_updated) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 10, 20, 1, 2, 0.5, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                id,
                workspace_path,
                if id == "s-one" { Some("s-parent") } else { None },
                title,
                if id == "s-one" { Some("model-x") } else { None },
                if id == "s-one" { Some("prov-1") } else { None },
                if id == "s-one" { Some(3) } else { None },
                if id == "s-one" { Some(4) } else { None },
                if id == "s-one" { Some(5) } else { None },
                archived_at,
                time_updated - 1_000,
                time_updated,
            ],
        )
        .unwrap();
    }

    fn insert_message(
        conn: &Connection,
        id: &str,
        session_id: &str,
        role: &str,
        model: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO message (id, session_id, role, model, time_created, time_completed) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                id,
                session_id,
                role,
                model,
                1_000,
                if role == "assistant" { Some(1_500) } else { None },
            ],
        )
        .unwrap();
    }

    fn insert_part(
        conn: &Connection,
        id: &str,
        message_id: &str,
        session_id: &str,
        seq: i64,
        kind: &str,
        data: &str,
    ) {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, seq, kind, data, time_created, time_updated) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1_000, 1_000)",
            rusqlite::params![id, message_id, session_id, seq, kind, data],
        )
        .unwrap();
    }

    fn open_at(db: &Db) -> SessionsV2 {
        let mut path = db.dir.clone();
        path.push("sessions-v2.db");
        SessionsV2::open(path).unwrap()
    }

    fn ids(sessions: &[SessionMetaV2]) -> Vec<&str> {
        sessions.iter().map(|s| s.id.as_str()).collect()
    }

    fn message_ids(messages: &[SessionMessageV2]) -> Vec<&str> {
        messages.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn list_orders_newest_first_and_filters_workspace_and_archive() {
        let db = synthetic_db("list-order");
        let store = open_at(&db);
        let page = store
            .list_sessions("/ws/alpha", SessionListOptsV2::default())
            .unwrap();
        assert_eq!(ids(&page.sessions), ["s-two", "s-one", "s-three", "s-four"]);
        assert_eq!(page.next_cursor, None);

        let archived = store
            .list_sessions("/ws/alpha", SessionListOptsV2 { archived: true, ..Default::default() })
            .unwrap();
        assert_eq!(ids(&archived.sessions), ["s-arch"]);

        let beta = store
            .list_sessions("/ws/beta", SessionListOptsV2::default())
            .unwrap();
        assert_eq!(ids(&beta.sessions), ["s-beta"]);

        let none = store
            .list_sessions("/ws/missing", SessionListOptsV2::default())
            .unwrap();
        assert!(none.sessions.is_empty());
        assert_eq!(none.next_cursor, None);
    }

    #[test]
    fn list_cursor_pages_inclusively_without_dupes() {
        let db = synthetic_db("list-cursor");
        let store = open_at(&db);
        let opts = SessionListOptsV2 { limit: Some(2), ..Default::default() };
        let page1 = store.list_sessions("/ws/alpha", opts.clone()).unwrap();
        assert_eq!(ids(&page1.sessions), ["s-two", "s-one"]);
        assert_eq!(page1.next_cursor.as_deref(), Some("s-three"));

        let page2 = store
            .list_sessions(
                "/ws/alpha",
                SessionListOptsV2 { cursor: page1.next_cursor, ..opts },
            )
            .unwrap();
        // Cursor is inclusive: s-three itself leads the next page.
        assert_eq!(ids(&page2.sessions), ["s-three", "s-four"]);
        assert_eq!(page2.next_cursor, None);

        // Unknown cursor: the TS row-value subquery yields NULL → empty page.
        let ghost = store
            .list_sessions(
                "/ws/alpha",
                SessionListOptsV2 { cursor: Some("nope".into()), ..opts },
            )
            .unwrap();
        assert!(ghost.sessions.is_empty());
        assert_eq!(ghost.next_cursor, None);
    }

    #[test]
    fn list_meta_matches_wire_shape() {
        let db = synthetic_db("wire-meta");
        let store = open_at(&db);
        let page = store
            .list_sessions("/ws/alpha", SessionListOptsV2::default())
            .unwrap();
        let one = page
            .sessions
            .iter()
            .find(|s| s.id == "s-one")
            .unwrap();
        assert_eq!(
            serde_json::to_value(one).unwrap(),
            json!({
                "id": "s-one",
                "workspacePath": "/ws/alpha",
                "parentId": "s-parent",
                "title": "One",
                "modelId": "model-x",
                "providerId": "prov-1",
                "tokensInput": 10,
                "tokensOutput": 20,
                "tokensReasoning": 1,
                "tokensCacheRead": 2,
                "cost": 0.5,
                "summaryAdditions": 3,
                "summaryDeletions": 4,
                "summaryFiles": 5,
                "archivedAt": null,
                "timeCreated": 2_000,
                "timeUpdated": 3_000,
            })
        );
        // Nullable fields stay present as null — the TS types are `T | null`.
        let two = page.sessions.iter().find(|s| s.id == "s-two").unwrap();
        let wire = serde_json::to_value(two).unwrap();
        assert_eq!(wire["parentId"], json!(null));
        assert_eq!(wire["modelId"], json!(null));
        assert_eq!(wire["summaryFiles"], json!(null));
        assert_eq!(wire["archivedAt"], json!(null));
    }

    #[test]
    fn messages_first_page_is_oldest_first_with_seq_ordered_parts() {
        let db = synthetic_db("msg-first-page");
        let store = open_at(&db);
        let page = store
            .session_messages("s-one", SessionWindowOptsV2::default())
            .unwrap();
        assert_eq!(message_ids(&page.messages), ["a1-m1", "a1-m2"]);
        assert_eq!(page.next_before, None);

        let user = &page.messages[0];
        assert_eq!(user.role, "user");
        assert_eq!(user.model, None);
        assert_eq!(user.time_completed, None);
        assert_eq!(user.parts.len(), 1);
        assert_eq!(user.parts[0].kind, "text");
        assert_eq!(user.parts[0].data, json!({ "text": "hello tide" }));

        let assistant = &page.messages[1];
        assert_eq!(assistant.model.as_deref(), Some("model-x"));
        assert_eq!(assistant.time_completed, Some(1_500));
        let kinds: Vec<&str> = assistant.parts.iter().map(|p| p.kind.as_str()).collect();
        assert_eq!(kinds, ["thinking", "text", "tool"]);
        assert_eq!(assistant.parts[1].seq, 1);
        assert_eq!(
            assistant.parts[2].data,
            json!({
                "toolName": "bash",
                "input": { "cmd": "ls" },
                "output": "x\n",
                "status": "completed",
                "durationMs": 12,
            })
        );
    }

    #[test]
    fn messages_wire_shape_is_camel_case_with_nulls() {
        let db = synthetic_db("wire-messages");
        let store = open_at(&db);
        let page = store
            .session_messages("s-one", SessionWindowOptsV2::default())
            .unwrap();
        let wire = serde_json::to_value(&page).unwrap();
        assert_eq!(
            wire,
            json!({
                "messages": [
                    {
                        "id": "a1-m1",
                        "role": "user",
                        "model": null,
                        "timeCreated": 1_000,
                        "timeCompleted": null,
                        "parts": [
                            { "id": "a1-m1-p0", "seq": 0, "kind": "text",
                              "data": { "text": "hello tide" } },
                        ],
                    },
                    {
                        "id": "a1-m2",
                        "role": "assistant",
                        "model": "model-x",
                        "timeCreated": 1_000,
                        "timeCompleted": 1_500,
                        "parts": [
                            { "id": "a1-m2-p0", "seq": 0, "kind": "thinking",
                              "data": { "text": "pondering" } },
                            { "id": "a1-m2-p1", "seq": 1, "kind": "text",
                              "data": { "text": "answer" } },
                            { "id": "a1-m2-p2", "seq": 2, "kind": "tool",
                              "data": { "toolName": "bash", "input": { "cmd": "ls" },
                                        "output": "x\n", "status": "completed",
                                        "durationMs": 12 } },
                        ],
                    },
                ],
                "nextBefore": null,
            })
        );
    }

    #[test]
    fn messages_window_cursors_walk_back() {
        let db = synthetic_db("msg-window");
        let store = open_at(&db);
        let limit = SessionWindowOptsV2 { limit: Some(3), ..Default::default() };

        let first = store.session_messages("s-long", limit.clone()).unwrap();
        assert_eq!(message_ids(&first.messages), ["msg-05", "msg-06", "msg-07"]);
        assert_eq!(first.next_before.as_deref(), Some("msg-05"));

        let second = store
            .session_messages(
                "s-long",
                SessionWindowOptsV2 { before: first.next_before, ..limit.clone() },
            )
            .unwrap();
        assert_eq!(message_ids(&second.messages), ["msg-02", "msg-03", "msg-04"]);
        assert_eq!(second.next_before.as_deref(), Some("msg-02"));

        let third = store
            .session_messages(
                "s-long",
                SessionWindowOptsV2 { before: second.next_before, ..limit },
            )
            .unwrap();
        assert_eq!(message_ids(&third.messages), ["msg-01"]);
        assert_eq!(third.next_before, None, "partial page: no more");

        // Direct before-cursor + below-all-cursor edge.
        let direct = store
            .session_messages(
                "s-long",
                SessionWindowOptsV2 { before: Some("msg-03".into()), limit: Some(3) },
            )
            .unwrap();
        assert_eq!(message_ids(&direct.messages), ["msg-01", "msg-02"]);
        assert_eq!(direct.next_before, None);

        let empty = store
            .session_messages(
                "s-long",
                SessionWindowOptsV2 { before: Some("msg-00".into()), limit: Some(3) },
            )
            .unwrap();
        assert!(empty.messages.is_empty());
        assert_eq!(empty.next_before, None);
    }

    #[test]
    fn messages_of_sessionless_and_empty_sessions() {
        let db = synthetic_db("msg-empty");
        let store = open_at(&db);
        let page = store
            .session_messages("s-beta", SessionWindowOptsV2::default())
            .unwrap();
        assert!(page.messages.is_empty());
        assert_eq!(page.next_before, None);

        let missing = store
            .session_messages("no-such-session", SessionWindowOptsV2::default())
            .unwrap();
        assert!(missing.messages.is_empty());
        assert_eq!(missing.next_before, None);
    }

    /// Explicit-column session seed for the legacy-header tests (the shared
    /// `insert_session` hardcodes parent/model specials for other tests).
    struct SeedSession {
        id: &'static str,
        workspace_path: &'static str,
        title: &'static str,
        parent_id: Option<&'static str>,
        model_id: Option<&'static str>,
        archived_at: Option<i64>,
        time_created: i64,
        time_updated: i64,
    }

    fn insert_session_full(conn: &Connection, seed: SeedSession) {
        conn.execute(
            "INSERT INTO session (id, workspace_path, parent_id, title, model_id, \
             archived_at, time_created, time_updated) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                seed.id,
                seed.workspace_path,
                seed.parent_id,
                seed.title,
                seed.model_id,
                seed.archived_at,
                seed.time_created,
                seed.time_updated
            ],
        )
        .unwrap();
    }

    #[test]
    fn headers_match_legacy_filters_order_and_counts() {
        let db = synthetic_db("headers-list");
        // /ws/alpha gains: a subagent (excluded), a null-model main, and a
        // second archived row archived BEFORE s-arch (manifest order check).
        insert_session_full(&db.conn, SeedSession {
            id: "s-sub", workspace_path: "/ws/alpha", title: "Child",
            parent_id: Some("s-two"), model_id: None, archived_at: None,
            time_created: 8_000, time_updated: 9_000,
        });
        insert_session_full(&db.conn, SeedSession {
            id: "s-nomodel", workspace_path: "/ws/alpha", title: "NoModel",
            parent_id: None, model_id: None, archived_at: None,
            time_created: 1_000, time_updated: 500,
        });
        insert_session_full(&db.conn, SeedSession {
            id: "s-arch-old", workspace_path: "/ws/alpha", title: "OldArchived",
            parent_id: None, model_id: None, archived_at: Some(3_000),
            time_created: 900, time_updated: 2_950,
        });
        for i in 1..=3 {
            insert_message(&db.conn, &format!("h-m{i}"), "s-two", "user", None);
        }
        insert_message(&db.conn, "h-sub-m1", "s-sub", "assistant", None);

        let store = open_at(&db);
        let headers = store.list_session_headers("/ws/alpha", "ws_alpha").unwrap();
        let ids: Vec<&str> = headers.iter().map(|h| h.id.as_str()).collect();
        // Subagent (s-sub, newest) and archived (s-arch, s-arch-old) excluded —
        // s-one too: the shared seed gives it a parent_id (subagent shape).
        // Remaining mains newest-first; the s-three/s-four tie breaks on id DESC.
        assert_eq!(ids, ["s-two", "s-three", "s-four", "s-nomodel"]);

        let two = &headers[0];
        assert_eq!(two.workspace_id, "ws_alpha");
        assert_eq!(two.message_count, 3, "all message rows count");
        assert_eq!(two.model_id, "");
        assert_eq!(two.provider_id, None);
        assert_eq!(two.kind, "main");
        assert_eq!(two.parent_id, None);
        assert_eq!(two.created_at, "1970-01-01T00:00:03.000Z");
        assert_eq!(two.updated_at, "1970-01-01T00:00:04.000Z");

        // Unknown workspace path: the TS filter matched nothing → empty list.
        assert!(store.list_session_headers("/ws/missing", "ws_x").unwrap().is_empty());
    }

    #[test]
    fn headers_wire_shape_is_camel_case_with_iso_timestamps() {
        let db = synthetic_db("headers-wire");
        insert_session_full(&db.conn, SeedSession {
            id: "s-iso", workspace_path: "/ws/alpha", title: "Iso",
            parent_id: None, model_id: Some("model-x"), archived_at: None,
            time_created: 951_782_400_000, time_updated: 1_759_000_000_123,
        });
        let store = open_at(&db);
        let headers = store.list_session_headers("/ws/alpha", "ws_1").unwrap();
        let iso = headers.iter().find(|h| h.id == "s-iso").unwrap();
        // providerId absent when null (TS `?` optional, dropped by JSON).
        assert_eq!(
            serde_json::to_value(iso).unwrap(),
            json!({
                "id": "s-iso",
                "workspaceId": "ws_1",
                "title": "Iso",
                "modelId": "model-x",
                "createdAt": "2000-02-29T00:00:00.000Z",
                "updatedAt": "2025-09-27T19:06:40.123Z",
                "messageCount": 0,
                "kind": "main",
            })
        );
    }

    #[test]
    fn archived_headers_list_archived_only_in_first_archive_order() {
        let db = synthetic_db("headers-archived");
        insert_session_full(&db.conn, SeedSession {
            id: "s-arch-old", workspace_path: "/ws/alpha", title: "OldArchived",
            parent_id: None, model_id: None, archived_at: Some(3_000),
            time_created: 900, time_updated: 2_950,
        });
        insert_session_full(&db.conn, SeedSession {
            id: "s-arch-beta", workspace_path: "/ws/beta", title: "OtherWorkspace",
            parent_id: None, model_id: None, archived_at: Some(9_999),
            time_created: 1, time_updated: 1,
        });

        let store = open_at(&db);
        let archived = store.list_archived_headers("/ws/alpha", "ws_alpha").unwrap();
        let ids: Vec<&str> = archived.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["s-arch-old", "s-arch"], "first-archive chronological");

        let old = &archived[0];
        assert_eq!(old.workspace_id, "ws_alpha");
        assert_eq!(old.model_id, "", "null model coerces like the TS shape");
        assert_eq!(old.archived_at, "1970-01-01T00:00:03.000Z");
        assert_eq!(old.updated_at, "1970-01-01T00:00:02.950Z");
        assert_eq!(
            serde_json::to_value(old).unwrap(),
            json!({
                "id": "s-arch-old",
                "workspaceId": "ws_alpha",
                "title": "OldArchived",
                "modelId": "",
                "archivedAt": "1970-01-01T00:00:03.000Z",
                "updatedAt": "1970-01-01T00:00:02.950Z",
            })
        );
        assert!(store.list_archived_headers("/ws/missing", "ws_x").unwrap().is_empty());
    }

    #[test]
    fn iso_from_unix_ms_matches_js_to_iso_string() {
        // Reference values from `new Date(ms).toISOString()`.
        assert_eq!(iso_from_unix_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_unix_ms(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(iso_from_unix_ms(1_759_000_000_123), "2025-09-27T19:06:40.123Z");
        assert_eq!(iso_from_unix_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_from_unix_ms(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        assert_eq!(iso_from_unix_ms(86_399_999), "1970-01-01T23:59:59.999Z");
    }

    #[test]
    fn non_json_part_data_is_an_error() {
        let db = synthetic_db("bad-part");
        insert_part(&db.conn, "a1-m1-bad", "a1-m1", "s-one", 9, "text", "not json{");
        let store = open_at(&db);
        let err = store
            .session_messages("s-one", SessionWindowOptsV2::default())
            .unwrap_err();
        assert!(
            err.to_string().contains("a1-m1-bad"),
            "error names the part: {err}"
        );
    }

    #[test]
    fn open_rejects_wrong_user_version_and_missing_file() {
        let db = synthetic_db("version-guard");
        db.conn.pragma_update(None, "user_version", 1).unwrap();
        let mut path = db.dir.clone();
        path.push("sessions-v2.db");
        let err = SessionsV2::open(&path).unwrap_err();
        assert!(err.to_string().contains("user_version"), "{err}");
        assert!(err.to_string().contains("expected 2"), "{err}");

        let mut missing = db.dir.clone();
        missing.pop();
        missing.push("absent.db");
        let err = SessionsV2::open(&missing).unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");
    }

    /// Dev-only sanity against the REAL ~/.tide (never part of `cargo test`):
    /// asserts open + list_sessions return Ok and prints counts only — never
    /// titles or part contents, which are the user's private data.
    #[test]
    #[ignore = "touches the real ~/.tide — run explicitly: cargo test -p tide-store -- --ignored --nocapture"]
    fn live_real_db_returns_ok() {
        let path = crate::paths::sessions_db_path();
        let store = SessionsV2::open(&path).expect("real sessions-v2.db opens");
        let mut stmt = store
            .conn
            .prepare("SELECT workspace_path, COUNT(*) FROM session GROUP BY workspace_path ORDER BY 2 DESC")
            .unwrap();
        let by_workspace: Vec<(String, i64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let total: i64 = by_workspace.iter().map(|(_, n)| n).sum();
        println!("sessions-v2: {total} sessions across {} workspaces", by_workspace.len());
        for (workspace, count) in &by_workspace {
            println!("  {workspace}: {count}");
        }
        for (workspace, count) in &by_workspace {
            let page = store
                .list_sessions(workspace, SessionListOptsV2::default())
                .expect("list_sessions over a real workspace");
            assert!(page.sessions.len() as i64 <= *count);
        }
        assert!(total >= 0);
    }

    /// Dev-only sanity for the legacy-header readers against the REAL ~/.tide
    /// (never part of `cargo test`): counts only — no titles or paths.
    #[test]
    #[ignore = "touches the real ~/.tide — run explicitly: cargo test -p tide-store -- --ignored --nocapture"]
    fn live_real_db_legacy_headers() {
        let path = crate::paths::sessions_db_path();
        let store = SessionsV2::open(&path).expect("real sessions-v2.db opens");
        let mut stmt = store
            .conn
            .prepare("SELECT DISTINCT workspace_path FROM session")
            .unwrap();
        let workspaces: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut total_headers = 0usize;
        let mut total_archived = 0usize;
        for workspace in &workspaces {
            total_headers += store
                .list_session_headers(workspace, "live")
                .expect("list_session_headers over a real workspace")
                .len();
            total_archived += store
                .list_archived_headers(workspace, "live")
                .expect("list_archived_headers over a real workspace")
                .len();
        }
        println!(
            "legacy headers over {} workspaces: {total_headers} active, {total_archived} archived",
            workspaces.len()
        );
    }
}
