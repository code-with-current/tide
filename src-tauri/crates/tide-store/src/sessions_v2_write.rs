//! sessions-v2.db write path + EventSink persistence, ported from
//! `app/core/ipc-adjacent/session-store-v2.ts` and `app/core/agent/event-sink.ts`
//! @ 91ec558.
//!
//! # Division of labor with the app crate (T4)
//!
//! The TS EventSink owned three things: a ~50ms flush timer + buffer, the
//! single WAL transaction per flush, and the live-consumer floor map. Here the
//! timer/buffering (mpsc plumbing, `onFlush` forwarding to the renderer, the
//! live-session set) belongs to the app crate; this module provides the
//! transactional primitives it drives:
//!
//! - [`WriteBatch::commit`] — one transaction per flush: event inserts (seq =
//!   rowid), part materialization on `part.commit`, message completion + usage
//!   rollup on `message.end`, and `turn.end`-anchored pruning. Returns
//!   per-session [`FlushBatchWire`]es (the `shared/rpc.ts` wire contract pushed
//!   as `orchestratorEvents`).
//! - [`mark_live`] / [`replay_events`] — the reconnect path. The TS
//!   sync-atomicity contract (replay → markLive with no await between; an
//!   interleaved flush could prune past a read-but-unregistered cursor) maps
//!   to: hold the same lock around both calls in T4.
//!
//! # Semantics ported verbatim
//!
//! - **Push-only degradation**: on DB failure the TS sink still delivered the
//!   batch with `seq` absent and `firstSeq`/`lastSeq` 0 — streaming continues,
//!   replay is simply unavailable. [`WriteBatch::commit`] mirrors this: it
//!   never fails, it reports `persisted: false` plus the error string.
//! - **Floor pruning**: on `turn.end`, events of that session below the
//!   live-consumer floor are deleted; with no live consumer ever registered,
//!   ALL non-`turn.end` events go. `turn.end` markers always stay. Committed
//!   parts, not events, are the durable record — pruning past a consumer only
//!   costs replay, never data.
//! - **Part mutation**: the TS never UPDATEd part rows. Tool parts arrive
//!   complete at `part.commit` (the tracker emits them once, at `tool-end`);
//!   re-commits of an existing part id are ignored (insert-if-absent).
//!   [`SessionsV2Writer::update_part_data`] is the escape hatch for an
//!   orchestrator that needs evolving tool part data — it rewrites `data` and
//!   bumps `time_updated`.
//! - **Usage rollups**: `message.end`'s `data.usage` increments the session's
//!   token/cost columns (`SinkUsage` shape: `reasoningTokens`/`cacheRead`),
//!   while the direct [`add_usage`] takes the store's `UsageDeltaV2` shape
//!   (`tokensReasoning`/`tokensCacheRead`) — the two TS interfaces genuinely
//!   differed; both are kept.
//! - **Ids**: same formats as 91ec558 (`s_` + 8 base36, `m_`/`p_` +
//!   time-base36 + `_` + 6 base36 random). Message-window cursors order by id,
//!   so message ids must stay time-sortable.
//! - **better-sqlite3 parity**: 5s busy timeout (its default), WAL,
//!   `foreign_keys = ON`. A missing session row fails a message insert via FK
//!   — the TS relied on exactly that to disable v2 emission for legacy-only
//!   sessions.
//!
//! Timestamps are caller-supplied unix millis (the TS inlined `Date.now()`;
//! an explicit clock keeps the store deterministic and lets the app own time).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sessions_v2::{Result, SessionsV2Error};

/// The SCHEMA string from session-store-v2.ts, verbatim (bar formatting).
/// The writer creates/upgrade-checks the db; the reader only validates.
pub const SCHEMA: &str = "
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
    CREATE INDEX IF NOT EXISTS event_replay ON event(session_id, seq);
    CREATE TABLE IF NOT EXISTS session_todos (
      session_id TEXT PRIMARY KEY,
      todos TEXT NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_worktree (
      session_id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_settings (
      session_id TEXT PRIMARY KEY,
      autonomy_mode TEXT,
      thinking_level TEXT,
      time_updated INTEGER NOT NULL
    );";

/// better-sqlite3's default `timeout` option — how long a second writer waits
/// for the lock before SQLITE_BUSY. WAL never blocks readers.
const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);

/// `SinkEvent['type']` — the four orchestrator-stream event kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SinkEventType {
    #[serde(rename = "part.delta")]
    PartDelta,
    #[serde(rename = "part.commit")]
    PartCommit,
    #[serde(rename = "message.end")]
    MessageEnd,
    #[serde(rename = "turn.end")]
    TurnEnd,
}

impl SinkEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PartDelta => "part.delta",
            Self::PartCommit => "part.commit",
            Self::MessageEnd => "message.end",
            Self::TurnEnd => "turn.end",
        }
    }

    fn from_db_str(s: &str) -> Option<Self> {
        match s {
            "part.delta" => Some(Self::PartDelta),
            "part.commit" => Some(Self::PartCommit),
            "message.end" => Some(Self::MessageEnd),
            "turn.end" => Some(Self::TurnEnd),
            _ => None,
        }
    }
}

/// `SinkEvent` in shared/rpc.ts (inlined from event-types.ts). The `?`
/// optionals are omitted on the wire when unset; `seq` is present iff the
/// transaction committed (persisted rowid, ascending within a batch).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkEventWire {
    pub r#type: SinkEventType,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub part_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

/// `FlushBatch` in shared/rpc.ts — one flushed partition of events, delivered
/// per session. Degraded push-only delivery carries `firstSeq`/`lastSeq` 0
/// and unstamped events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushBatchWire {
    pub events: Vec<SinkEventWire>,
    pub first_seq: i64,
    pub last_seq: i64,
}

/// `UsageDeltaV2` — the session-store `addUsage` parameter shape.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDeltaV2 {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub tokens_reasoning: Option<i64>,
    pub tokens_cache_read: Option<i64>,
    pub cost_usd: f64,
}

/// `SinkUsage` — the `message.end` `data.usage` shape (note the field names
/// genuinely differ from [`UsageDeltaV2`]; both existed in the TS).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkUsage {
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    pub reasoning_tokens: Option<i64>,
    pub cache_read: Option<i64>,
    #[serde(default)]
    pub cost_usd: f64,
}

/// `CreateSessionInput` from session-store-v2.ts. `modelId` is required
/// (non-nullable there too); the db column itself stays nullable.
#[derive(Debug, Clone, PartialEq)]
pub struct CreateSessionInput<'a> {
    pub id: &'a str,
    pub workspace_path: &'a str,
    pub title: &'a str,
    pub model_id: &'a str,
    pub provider_id: Option<&'a str>,
    pub parent_id: Option<&'a str>,
}

/// `InsertMessageInput` — lands the row at turn start; `time_completed` stays
/// NULL until the sink's `message.end` completes it.
#[derive(Debug, Clone, PartialEq)]
pub struct InsertMessageInput<'a> {
    pub id: &'a str,
    pub session_id: &'a str,
    pub role: &'a str,
    pub model: Option<&'a str>,
}

/// `InsertPartInput` — plain insert; duplicate ids raise (the sink's
/// insert-if-absent lives on the `part.commit` path instead).
#[derive(Debug, Clone, PartialEq)]
pub struct InsertPartInput<'a> {
    pub id: &'a str,
    pub message_id: &'a str,
    pub session_id: &'a str,
    pub seq: i64,
    pub kind: &'a str,
    pub data: &'a Value,
}

/// Set-or-keep patch for [`SessionsV2Writer::update_session`]; `time_updated`
/// is always bumped. `None` fields keep their stored value (setting a column
/// back to NULL is not expressible — the TS had no such operation either).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SessionPatch<'a> {
    pub title: Option<&'a str>,
    pub model_id: Option<&'a str>,
    pub provider_id: Option<&'a str>,
}

/// A pending flush: events buffered by the app crate's sink task, committed
/// atomically by [`SessionsV2Writer::commit_batch`]. Drained on commit (the
/// TS swapped the buffer out the same way) — a failed commit still consumes
/// the events, matching the push-only degradation.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WriteBatch {
    events: Vec<SinkEventWire>,
}

impl WriteBatch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, event: SinkEventWire) {
        self.events.push(event);
    }

    pub fn extend(&mut self, events: impl IntoIterator<Item = SinkEventWire>) {
        self.events.extend(events);
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn events(&self) -> &[SinkEventWire] {
        &self.events
    }
}

/// What [`SessionsV2Writer::commit_batch`] did: the per-session batches to
/// push (always produced — degraded when unpersisted) and whether the WAL
/// transaction landed.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitOutcome {
    pub batches: Vec<FlushBatchWire>,
    pub persisted: bool,
    pub persist_error: Option<String>,
}

/// `s_${Math.random().toString(36).slice(2, 10)}` — the legacy store's session
/// id, reused verbatim as the v2 twin id.
pub fn new_session_id() -> String {
    format!("s_{}", random_base36(8))
}

/// `ws_${Math.random().toString(36).slice(2, 10)}` — the configStore's
/// workspace id (the workspaces-rpc add handler minted it).
pub fn new_workspace_id() -> String {
    format!("ws_{}", random_base36(8))
}

/// `m_${Date.now().toString(36)}_${...}` — chronologically sortable (the
/// message-window cursor orders by id).
pub fn new_message_id() -> String {
    message_id_at(unix_ms_now())
}

pub fn message_id_at(ms: u64) -> String {
    format!("m_{}_{}", to_base36(ms), random_base36(6))
}

/// `p_${Date.now().toString(36)}_${...}` — part id; same shape as messages.
pub fn new_part_id() -> String {
    part_id_at(unix_ms_now())
}

pub fn part_id_at(ms: u64) -> String {
    format!("p_{}_{}", to_base36(ms), random_base36(6))
}

/// Read-write handle to sessions-v2.db. Owns the live-consumer floor map the
/// `turn.end` pruner consults; keep it behind one lock in the app crate so
/// `replay_events` + `mark_live` stay back-to-back (the TS sync-atomicity
/// contract).
#[derive(Debug)]
pub struct SessionsV2Writer {
    conn: Connection,
    path: PathBuf,
    live_seq: HashMap<String, i64>,
    /// Message rows sort chronologically by their time-prefixed id
    /// (`ORDER BY id`), so two messages stamped the same millisecond can
    /// invert order on the random suffix. `insert_message` bumps its
    /// `now_ms` past the last one it wrote.
    last_message_ms: std::cell::Cell<i64>,
}

impl SessionsV2Writer {
    /// Opens (creating if needed) sessions-v2.db for writing: parent dirs,
    /// WAL, `foreign_keys = ON`, 5s busy timeout, schema, `user_version`
    /// bumped up to 2 only. A db newer than 2 is refused — this build knows
    /// exactly v2 and must not write a newer schema blind.
    pub fn open<P: AsRef<Path>>(db_path: P) -> Result<Self> {
        let path = db_path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| SessionsV2Error::Open {
                    path: path.clone(),
                    cause: e.to_string(),
                })?;
            }
        }
        let conn = Connection::open(&path).map_err(|e| SessionsV2Error::Open {
            path: path.clone(),
            cause: e.to_string(),
        })?;
        let _: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
            .map_err(|e| SessionsV2Error::Open {
                path: path.clone(),
                cause: e.to_string(),
            })?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(BUSY_TIMEOUT)?;
        conn.execute_batch(SCHEMA)?;
        let found: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        match found.cmp(&2) {
            std::cmp::Ordering::Greater => {
                return Err(SessionsV2Error::UnsupportedSchema { found });
            }
            std::cmp::Ordering::Less => conn.pragma_update(None, "user_version", 2)?,
            std::cmp::Ordering::Equal => {}
        }
        Ok(Self {
            conn,
            path,
            live_seq: HashMap::new(),
            last_message_ms: std::cell::Cell::new(i64::MIN),
        })
    }

    pub fn db_path(&self) -> &Path {
        &self.path
    }

    /// The session's `workspace_path` — None when no such session row exists.
    /// The T4 command layer uses this as both the existence check and the
    /// turn's workspace root source.
    pub fn session_workspace_path(&self, id: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT workspace_path FROM session WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok()
    }

    /// The session's `parent_id` — `None` when no such session row exists,
    /// `Some(None)` for a root session. The dispatch runner validates
    /// `resumeFrom` ids against it (a resumable dispatch must be a child of
    /// the asking session).
    pub fn session_parent_id(&self, id: &str) -> Option<Option<String>> {
        self.conn
            .query_row(
                "SELECT parent_id FROM session WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok()
    }

    /// `createSession`: one session row; `time_created` == `time_updated`.
    pub fn create_session(&self, o: CreateSessionInput<'_>, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO session (id, workspace_path, parent_id, title, model_id, \
                 provider_id, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    o.id,
                    o.workspace_path,
                    o.parent_id,
                    o.title,
                    o.model_id,
                    o.provider_id,
                    now_ms
                ],
            )
            ?;
        Ok(())
    }

    /// Title/model/provider rename + `time_updated` bump (COALESCE keeps the
    /// `None` fields).
    pub fn update_session(&self, id: &str, patch: SessionPatch<'_>, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE session SET title = COALESCE(?2, title), \
                 model_id = COALESCE(?3, model_id), provider_id = COALESCE(?4, provider_id), \
                 time_updated = ?5 WHERE id = ?1",
                params![id, patch.title, patch.model_id, patch.provider_id, now_ms],
            )
            ?;
        Ok(())
    }

    /// `addUsage`: increment the token/cost rollup columns and touch the row.
    pub fn add_usage(&self, session_id: &str, delta: UsageDeltaV2, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE session SET tokens_input = tokens_input + ?2, \
                 tokens_output = tokens_output + ?3, \
                 tokens_reasoning = tokens_reasoning + ?4, \
                 tokens_cache_read = tokens_cache_read + ?5, cost = cost + ?6, \
                 time_updated = ?7 WHERE id = ?1",
                params![
                    session_id,
                    delta.input_tokens,
                    delta.output_tokens,
                    delta.tokens_reasoning.unwrap_or(0),
                    delta.tokens_cache_read.unwrap_or(0),
                    delta.cost_usd,
                    now_ms
                ],
            )
            ?;
        Ok(())
    }

    /// `archiveSession`: stamps `archived_at` only (time_updated untouched —
    /// the TS didn't bump it either, so archived sessions keep their list
    /// position).
    pub fn archive_session(&self, id: &str, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE session SET archived_at = ?2 WHERE id = ?1",
                params![id, now_ms],
            )
            ?;
        Ok(())
    }

    /// `deleteSession`: cascades to messages/parts (FKs are ON). Events carry
    /// no FK and are left behind, exactly like the TS; the side tables
    /// (todos/worktree/settings) carry none either and are cleared here.
    pub fn delete_session(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM session WHERE id = ?1", params![id])
            ?;
        self.conn
            .execute("DELETE FROM session_todos WHERE session_id = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM session_worktree WHERE session_id = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM session_settings WHERE session_id = ?1", params![id])?;
        Ok(())
    }

    /// `clearAllSessions`: wipe every row of every table (the TS removed the
    /// whole sessions directory). The db file + schema survive.
    pub fn clear_all(&self) -> Result<()> {
        self.conn.execute_batch(
            "DELETE FROM event; DELETE FROM part; DELETE FROM message; DELETE FROM session; \
             DELETE FROM session_todos; DELETE FROM session_worktree; DELETE FROM session_settings;",
        )?;
        Ok(())
    }

    /// The session's existence + archive state — `None` when no such row.
    /// The command layer's two-step archive→delete flow probes with this.
    pub fn session_archived(&self, id: &str) -> Option<bool> {
        self.conn
            .query_row(
                "SELECT archived_at IS NOT NULL FROM session WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok()
    }

    /// `unarchiveSession`: clear `archived_at` (idempotent; the row keeps its
    /// list position — time_updated untouched, like the TS).
    pub fn unarchive_session(&self, id: &str) -> Result<()> {
        self.conn
            .execute("UPDATE session SET archived_at = NULL WHERE id = ?1", params![id])
            ?;
        Ok(())
    }

    /// Archive/unarchive every session of a workspace for the workspace-level
    /// cascades (TS `cascadeOps`). `main_only` matches the TS asymmetry: the
    /// archive cascade came from `listSessions` (mains only) while the
    /// unarchive cascade came from `listArchived` (everything archived).
    pub fn archive_workspace_sessions(&self, workspace_path: &str, now_ms: i64, main_only: bool) -> Result<usize> {
        let sql = if main_only {
            "UPDATE session SET archived_at = ?2 WHERE workspace_path = ?1 \
             AND archived_at IS NULL AND parent_id IS NULL"
        } else {
            "UPDATE session SET archived_at = ?2 WHERE workspace_path = ?1 AND archived_at IS NULL"
        };
        Ok(self.conn.execute(sql, params![workspace_path, now_ms])?)
    }

    /// Unarchive every archived session of a workspace (the unarchive
    /// cascade came from `listArchived` — subagents included).
    pub fn unarchive_workspace_sessions(&self, workspace_path: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE session SET archived_at = NULL WHERE workspace_path = ?1 AND archived_at IS NOT NULL",
            params![workspace_path],
        )?)
    }

    /// The ids of every session row under a workspace path (any archive
    /// state) — the workspace-delete cascade iterates them.
    pub fn session_ids_by_workspace(&self, workspace_path: &str) -> Vec<String> {
        let mut stmt = match self.conn.prepare(
            "SELECT id FROM session WHERE workspace_path = ?1 ORDER BY time_created ASC, id ASC",
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(params![workspace_path], |row| row.get(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    /// The last text part id of a message (`None` when it has no text part or
    /// no such message) — the finalize-upsert targets it.
    pub fn last_text_part_of(&self, message_id: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT id FROM part WHERE message_id = ?1 AND kind = 'text' \
                 ORDER BY seq DESC, id DESC LIMIT 1",
                params![message_id],
                |row| row.get(0),
            )
            .ok()
    }

    /// `store.setTodos` twin: the TS persisted the session's todo list on
    /// the legacy JSON session row; the v2 schema has no todos column, so
    /// it lands in the `session_todos` side table (additive — created by
    /// the schema batch, `user_version` stays 2). Full replacement per
    /// call, like the TS assignment.
    pub fn set_session_todos(&self, session_id: &str, todos: &Value, now_ms: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO session_todos (session_id, todos, time_updated) VALUES (?1, ?2, ?3) \
             ON CONFLICT(session_id) DO UPDATE SET todos = ?2, time_updated = ?3",
            params![session_id, todos.to_string(), now_ms],
        )?;
        Ok(())
    }

    /// The session's persisted todo list (`null`-free: `None` when never
    /// written or unparsable) — the reader twin of
    /// [`SessionsV2Writer::set_session_todos`].
    pub fn session_todos(&self, session_id: &str) -> Option<Vec<Value>> {
        let raw: String = self
            .conn
            .query_row(
                "SELECT todos FROM session_todos WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .ok()?;
        serde_json::from_str::<Vec<Value>>(&raw).ok()
    }

    /// Persist (or clear with `None`) the session's worktree metadata — the
    /// twin of the legacy JSON row's `worktree` field, landed in an additive
    /// side table like `session_todos` (the v2 schema has no column).
    pub fn set_session_worktree(
        &self,
        session_id: &str,
        worktree: Option<&Value>,
        now_ms: i64,
    ) -> Result<()> {
        match worktree {
            Some(worktree) => {
                self.conn.execute(
                    "INSERT INTO session_worktree (session_id, worktree, time_updated) \
                     VALUES (?1, ?2, ?3) \
                     ON CONFLICT(session_id) DO UPDATE SET worktree = ?2, time_updated = ?3",
                    params![session_id, worktree.to_string(), now_ms],
                )?;
            }
            None => {
                self.conn
                    .execute("DELETE FROM session_worktree WHERE session_id = ?1", params![session_id])?;
            }
        }
        Ok(())
    }

    /// The session's persisted worktree metadata (unparsable rows read as
    /// absent, like [`SessionsV2Writer::session_todos`]).
    pub fn session_worktree(&self, session_id: &str) -> Option<Value> {
        let raw: String = self
            .conn
            .query_row(
                "SELECT worktree FROM session_worktree WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Patch the session's per-session settings (autonomy/thinking), the
    /// twin of the legacy JSON row's fields. Set-or-keep: `None` fields keep
    /// their stored value (the TS only assigned defined patch fields).
    pub fn set_session_settings(
        &self,
        session_id: &str,
        autonomy_mode: Option<&str>,
        thinking_level: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO session_settings (session_id, autonomy_mode, thinking_level, time_updated) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(session_id) DO UPDATE SET \
               autonomy_mode = COALESCE(?2, autonomy_mode), \
               thinking_level = COALESCE(?3, thinking_level), \
               time_updated = ?4",
            params![session_id, autonomy_mode, thinking_level, now_ms],
        )?;
        Ok(())
    }

    /// The session's persisted settings (`None` fields when never written).
    pub fn session_settings(&self, session_id: &str) -> Option<(Option<String>, Option<String>)> {
        self.conn
            .query_row(
                "SELECT autonomy_mode, thinking_level FROM session_settings WHERE session_id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
    }

    /// `insertMessage`: the assistant (or twin user) message row at turn
    /// start. A missing session row fails here via the FK — the caller treats
    /// that as "v2 emission off" for the turn.
    /// Reserves a message slot: a strictly-monotonic timestamp plus the
    /// message id minted from it. Events streamed before the insert carry
    /// this id unchanged — minting from the same clock as the row's
    /// `time_created` is what keeps `ORDER BY id` chronological.
    pub fn next_message_slot(&self) -> (String, i64) {
        let mut ms = unix_ms_now() as i64;
        let last = self.last_message_ms.get();
        if ms <= last {
            ms = last + 1;
        }
        self.last_message_ms.set(ms);
        (message_id_at(ms as u64), ms)
    }

    pub fn insert_message(&self, o: InsertMessageInput<'_>, now_ms: i64) -> Result<()> {
        let now_ms = now_ms.max(self.last_message_ms.get() + 1);
        self.last_message_ms.set(now_ms);
        self.conn
            .execute(
                "INSERT INTO message (id, session_id, role, model, time_created) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![o.id, o.session_id, o.role, o.model, now_ms],
            )
            ?;
        Ok(())
    }

    /// `bumpMessageCompleted` (the sink's `message.end` side effect): stamps
    /// `time_completed`.
    pub fn complete_message(&self, message_id: &str, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE message SET time_completed = ?2 WHERE id = ?1",
                params![message_id, now_ms],
            )
            ?;
        Ok(())
    }

    /// `insertPart`: plain part insert (data JSON-encoded).
    pub fn insert_part(&self, o: InsertPartInput<'_>, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO part (id, message_id, session_id, seq, kind, data, \
                 time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    o.id,
                    o.message_id,
                    o.session_id,
                    o.seq,
                    o.kind,
                    encode_json(Some(o.data)),
                    now_ms
                ],
            )
            ?;
        Ok(())
    }

    /// Rewrite a committed part's `data` in place. The TS never updated part
    /// rows — tool parts landed complete at `part.commit` and re-commits were
    /// ignored — so nothing at 91ec558 called this; it exists for an
    /// orchestrator that streams evolving tool part data. Returns the affected
    /// row count (0 = no such part).
    pub fn update_part_data(&self, part_id: &str, data: &Value, now_ms: i64) -> Result<usize> {
        self.conn
            .execute(
                "UPDATE part SET data = ?2, time_updated = ?3 WHERE id = ?1",
                params![part_id, encode_json(Some(data)), now_ms],
            )
            .map_err(Into::into)
    }

    /// One event row; returns the assigned `seq` (AUTOINCREMENT rowid).
    pub fn insert_event(&self, event: &SinkEventWire, now_ms: i64) -> Result<i64> {
        let tx = self.conn.unchecked_transaction()?;
        let seq = insert_event_tx(&tx, event, now_ms)?;
        tx.commit()?;
        Ok(seq)
    }

    /// `replay`: events of a session strictly after `after_seq`, seq-ascending,
    /// `limit` rows (None = unbounded). Rows come back seq-stamped.
    pub fn replay_events(
        &self,
        session_id: &str,
        after_seq: i64,
        limit: Option<usize>,
    ) -> Result<Vec<SinkEventWire>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, session_id, message_id, part_id, type, data FROM event \
             WHERE session_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![session_id, after_seq, limit.map(|l| l as i64).unwrap_or(-1)],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )?;
        let mut events = Vec::new();
        for row in rows {
            let (seq, session_id, message_id, part_id, kind, data) = row?;
            let kind = SinkEventType::from_db_str(&kind).ok_or_else(|| {
                SessionsV2Error::MalformedEvent {
                    detail: format!("event seq {seq} has unknown type {kind:?}"),
                }
            })?;
            events.push(SinkEventWire {
                r#type: kind,
                session_id,
                message_id,
                part_id,
                data: Some(decode_json(&data, seq)?),
                seq: Some(seq),
            });
        }
        Ok(events)
    }

    /// `markLive`: advance the session's floor to the HIGHEST confirmed
    /// watermark (monotonic — a stale subscriber can't lower it). Callers pass
    /// `last_delivered_seq + 1`: pruning deletes `seq < floor`, so the floor
    /// moves PAST the delivered rows to make them reclaimable.
    pub fn mark_live(&mut self, session_id: &str, last_seq: i64) {
        let floor = self.live_seq.entry(session_id.to_owned()).or_insert(0);
        if last_seq > *floor {
            *floor = last_seq;
        }
    }

    /// The session's current floor, if any live consumer ever registered.
    pub fn live_floor(&self, session_id: &str) -> Option<i64> {
        self.live_seq.get(session_id).copied()
    }

    /// `pruneEvents` outside a flush: `floor` = the live watermark (None =
    /// never-live session → delete every non-`turn.end` event). `turn.end`
    /// markers always stay. The flush path calls this per `turn.end` inside
    /// the batch transaction; this is the standalone form.
    pub fn prune_events_below_floor(&self, session_id: &str, floor: Option<i64>) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        prune_events_tx(&tx, session_id, floor)?;
        Ok(tx.commit()?)
    }

    /// The flush: drain `batch` and apply it in ONE transaction (events →
    /// `part.commit` materialization → `message.end` completion/rollup →
    /// `turn.end` prune), returning the per-session `FlushBatch`es in
    /// first-event order. Never fails: on DB error the transaction rolls back
    /// whole and the drained events come back unstamped (`firstSeq`/`lastSeq`
    /// 0) with `persisted: false` — push-only degradation, streaming survives.
    pub fn commit_batch(&self, batch: &mut WriteBatch, now_ms: i64) -> CommitOutcome {
        if batch.is_empty() {
            return CommitOutcome {
                batches: Vec::new(),
                persisted: true,
                persist_error: None,
            };
        }
        let events = std::mem::take(&mut batch.events);
        match self.flush_tx(&events, now_ms) {
            Ok(batches) => CommitOutcome {
                batches,
                persisted: true,
                persist_error: None,
            },
            Err(e) => CommitOutcome {
                batches: degraded_batches(&events),
                persisted: false,
                persist_error: Some(e.to_string()),
            },
        }
    }

    fn flush_tx(&self, events: &[SinkEventWire], now_ms: i64) -> Result<Vec<FlushBatchWire>> {
        let tx = self.conn.unchecked_transaction()?;
        let mut stamped: Vec<(String, SinkEventWire)> = Vec::with_capacity(events.len());
        for event in events {
            let seq = insert_event_tx(&tx, event, now_ms)?;
            stamped.push((
                event.session_id.clone(),
                SinkEventWire {
                    seq: Some(seq),
                    ..event.clone()
                },
            ));
            match event.r#type {
                SinkEventType::PartCommit => {
                    if let (Some(part_id), Some(message_id)) =
                        (event.part_id.as_deref(), event.message_id.as_deref())
                    {
                        commit_part_tx(&tx, event, part_id, message_id, now_ms)?;
                    }
                }
                SinkEventType::MessageEnd => {
                    if let Some(message_id) = event.message_id.as_deref() {
                        tx.execute(
                            "UPDATE message SET time_completed = ?2 WHERE id = ?1",
                            params![message_id, now_ms],
                        )?;
                        if let Some(usage) = event.data.as_ref().and_then(|d| d.get("usage")) {
                            let usage: SinkUsage = serde_json::from_value(usage.clone())
                                .map_err(|e| SessionsV2Error::MalformedEvent {
                                    detail: format!("message.end usage: {e}"),
                                })?;
                            add_usage_tx(&tx, &event.session_id, usage, now_ms)?;
                        }
                    }
                }
                SinkEventType::TurnEnd => {
                    let floor = self.live_seq.get(&event.session_id).copied();
                    prune_events_tx(&tx, &event.session_id, floor)?;
                }
                SinkEventType::PartDelta => {}
            }
        }
        tx.commit()?;
        Ok(group_batches(stamped))
    }
}

fn insert_event_tx(tx: &Transaction<'_>, event: &SinkEventWire, now_ms: i64) -> Result<i64> {
    tx.execute(
        "INSERT INTO event (session_id, message_id, part_id, type, data, time_created) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            event.session_id,
            event.message_id,
            event.part_id,
            event.r#type.as_str(),
            encode_json(event.data.as_ref()),
            now_ms
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

/// `part.commit` materialization: insert the part only if its id is new
/// (`partExists` guard — re-commits are no-ops). Body: `{ kind, data, seq? }`
/// with `seq` defaulting to 0, mirroring `$seq: body.seq ?? 0`.
fn commit_part_tx(
    tx: &Transaction<'_>,
    event: &SinkEventWire,
    part_id: &str,
    message_id: &str,
    now_ms: i64,
) -> Result<()> {
    let exists: i64 =
        tx.query_row("SELECT COUNT(*) FROM part WHERE id = ?1", params![part_id], |row| {
            row.get(0)
        })?;
    if exists > 0 {
        return Ok(());
    }
    let body = event.data.as_ref().ok_or_else(|| SessionsV2Error::MalformedEvent {
        detail: format!("part.commit {part_id} has no body"),
    })?;
    let kind = body
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| SessionsV2Error::MalformedEvent {
            detail: format!("part.commit {part_id} body has no kind"),
        })?;
    let seq = body.get("seq").and_then(Value::as_i64).unwrap_or(0);
    let data = body.get("data").cloned().unwrap_or_else(|| Value::Object(Default::default()));
    tx.execute(
        "INSERT INTO part (id, message_id, session_id, seq, kind, data, time_created, \
         time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            part_id,
            message_id,
            event.session_id,
            seq,
            kind,
            encode_json(Some(&data)),
            now_ms
        ],
    )?;
    Ok(())
}

fn add_usage_tx(tx: &Transaction<'_>, session_id: &str, usage: SinkUsage, now_ms: i64) -> Result<()> {
    tx.execute(
        "UPDATE session SET tokens_input = tokens_input + ?2, \
         tokens_output = tokens_output + ?3, tokens_reasoning = tokens_reasoning + ?4, \
         tokens_cache_read = tokens_cache_read + ?5, cost = cost + ?6, time_updated = ?7 \
         WHERE id = ?1",
        params![
            session_id,
            usage.input_tokens,
            usage.output_tokens,
            usage.reasoning_tokens.unwrap_or(0),
            usage.cache_read.unwrap_or(0),
            usage.cost_usd,
            now_ms
        ],
    )?;
    Ok(())
}

/// `pruneEvents`: with a floor, delete `seq < floor`; without one, delete
/// everything. `turn.end` rows survive both.
fn prune_events_tx(tx: &Transaction<'_>, session_id: &str, floor: Option<i64>) -> Result<()> {
    match floor {
        Some(floor) => {
            tx.execute(
                "DELETE FROM event WHERE session_id = ?1 AND seq < ?2 AND type != 'turn.end'",
                params![session_id, floor],
            )?;
        }
        None => {
            tx.execute(
                "DELETE FROM event WHERE session_id = ?1 AND type != 'turn.end'",
                params![session_id],
            )?;
        }
    }
    Ok(())
}

/// Group stamped events into per-session batches, first-event order (the TS
/// Map preserved insertion order the same way).
fn group_batches(stamped: Vec<(String, SinkEventWire)>) -> Vec<FlushBatchWire> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, Vec<SinkEventWire>> = HashMap::new();
    for (session_id, event) in stamped {
        if !grouped.contains_key(&session_id) {
            order.push(session_id.clone());
        }
        grouped.entry(session_id).or_default().push(event);
    }
    order
        .into_iter()
        .map(|session_id| {
            let events = grouped.remove(&session_id).unwrap_or_default();
            let last_seq = events.last().and_then(|e| e.seq).unwrap_or(0);
            let first_seq = events.first().and_then(|e| e.seq).unwrap_or(0);
            FlushBatchWire {
                events,
                first_seq,
                last_seq,
            }
        })
        .collect()
}

/// Push-only degradation: same partitioning, but no seq anywhere and
/// `firstSeq`/`lastSeq` 0.
fn degraded_batches(events: &[SinkEventWire]) -> Vec<FlushBatchWire> {
    let stamped = events
        .iter()
        .map(|e| (e.session_id.clone(), e.clone()))
        .collect::<Vec<_>>();
    group_batches(stamped)
        .into_iter()
        .map(|mut batch| {
            for event in &mut batch.events {
                event.seq = None;
            }
            batch.first_seq = 0;
            batch.last_seq = 0;
            batch
        })
        .collect()
}

/// `JSON.stringify(x ?? {})`: null/undefined coerce to `{}`.
fn encode_json(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "{}".to_owned(),
        Some(value) => value.to_string(),
    }
}

fn decode_json(raw: &str, seq: i64) -> Result<Value> {
    serde_json::from_str(raw).map_err(|source| SessionsV2Error::InvalidEventData { seq, source })
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn to_base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `Math.random().toString(36).slice(2, n)` parity: n lowercase base36 chars
/// from a splitmix64 stream seeded per call (clock, pid, counter). Not
/// cryptographic — neither was Math.random.
fn random_base36(len: usize) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut state = (unix_ms_now() << 16)
        ^ (u64::from(std::process::id()) << 32)
        ^ COUNTER.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
    let mut out = String::with_capacity(len);
    for _ in 0..len {
        state = state
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .wrapping_add(0x1234_5678_9ABC_DEF0);
        out.push(DIGITS[((state >> 32) % 36) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions_v2::{SessionListOptsV2, SessionWindowOptsV2, SessionsV2};
    use serde_json::json;
    use std::fs;

    const T0: i64 = 10_000;

    struct Dir(PathBuf);

    impl Dir {
        fn db(&self) -> PathBuf {
            self.0.join("sessions-v2.db")
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(name: &str) -> Dir {
        let path = std::env::temp_dir().join(format!(
            "tide-store-v2-write-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Dir(path)
    }

    fn writer_at(name: &str) -> (Dir, SessionsV2Writer) {
        let dir = temp_dir(name);
        let writer = SessionsV2Writer::open(dir.db()).unwrap();
        (dir, writer)
    }

    fn reader_at(dir: &Dir) -> SessionsV2 {
        SessionsV2::open(dir.db()).unwrap()
    }

    fn delta(sid: &str, mid: &str, pid: &str, text: &str) -> SinkEventWire {
        SinkEventWire {
            r#type: SinkEventType::PartDelta,
            session_id: sid.to_owned(),
            message_id: Some(mid.to_owned()),
            part_id: Some(pid.to_owned()),
            data: Some(json!({ "text": text })),
            seq: None,
        }
    }

    fn text_commit(sid: &str, mid: &str, pid: &str, text: &str, seq: i64) -> SinkEventWire {
        SinkEventWire {
            r#type: SinkEventType::PartCommit,
            session_id: sid.to_owned(),
            message_id: Some(mid.to_owned()),
            part_id: Some(pid.to_owned()),
            data: Some(json!({ "kind": "text", "data": { "text": text }, "seq": seq })),
            seq: None,
        }
    }

    fn tool_commit(sid: &str, mid: &str, pid: &str, seq: i64, tool: Value) -> SinkEventWire {
        SinkEventWire {
            r#type: SinkEventType::PartCommit,
            session_id: sid.to_owned(),
            message_id: Some(mid.to_owned()),
            part_id: Some(pid.to_owned()),
            data: Some(json!({ "kind": "tool", "data": tool, "seq": seq })),
            seq: None,
        }
    }

    fn message_end(sid: &str, mid: &str, usage: Value) -> SinkEventWire {
        SinkEventWire {
            r#type: SinkEventType::MessageEnd,
            session_id: sid.to_owned(),
            message_id: Some(mid.to_owned()),
            part_id: None,
            data: Some(json!({ "usage": usage })),
            seq: None,
        }
    }

    fn turn_end(sid: &str, mid: &str) -> SinkEventWire {
        SinkEventWire {
            r#type: SinkEventType::TurnEnd,
            session_id: sid.to_owned(),
            message_id: Some(mid.to_owned()),
            part_id: None,
            data: None,
            seq: None,
        }
    }

    /// (seq, type) of a session's surviving event rows, ascending.
    fn event_rows(writer: &SessionsV2Writer, sid: &str) -> Vec<(i64, String)> {
        let mut stmt = writer
            .conn
            .prepare("SELECT seq, type FROM event WHERE session_id = ?1 ORDER BY seq")
            .unwrap();
        stmt.query_map(rusqlite::params![sid], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    }

    #[test]
    fn open_creates_wal_db_with_v2_schema_and_reopens() {
        let dir = temp_dir("open-create");
        let nested = dir.0.join("deeply/nested");
        let db_path = nested.join("sessions-v2.db");
        let writer = SessionsV2Writer::open(&db_path).unwrap();
        assert!(db_path.is_file(), "parent dirs created + db written");
        let version: i64 = writer
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);
        let mode: String = writer
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let tables: Vec<String> = {
            let mut stmt = writer
                .conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        for table in ["event", "message", "part", "session"] {
            assert!(tables.contains(&table.to_owned()), "table {table}");
        }
        // Reopen is idempotent (CREATE IF NOT EXISTS, version already 2).
        drop(writer);
        SessionsV2Writer::open(&db_path).unwrap();
    }

    #[test]
    fn open_refuses_newer_schema() {
        let (dir, writer) = writer_at("newer-schema");
        writer.conn.pragma_update(None, "user_version", 3).unwrap();
        drop(writer);
        let err = SessionsV2Writer::open(dir.db()).unwrap_err();
        assert!(err.to_string().contains("expected 2"), "{err}");
    }

    #[test]
    fn insert_message_with_missing_session_fails_fk() {
        let (_dir, writer) = writer_at("fk-guard");
        let err = writer
            .insert_message(
                InsertMessageInput { id: "m_1", session_id: "ghost", role: "assistant", model: None },
                T0,
            )
            .unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("foreign key"),
            "the TS relied on this FK to disable v2 emission: {err}"
        );
    }

    #[test]
    fn id_formats_match_the_ts_scheme() {
        let session = new_session_id();
        assert!(session.starts_with("s_"), "{session}");
        assert_eq!(session.len(), 10, "s_ + 8 base36 chars");
        assert!(session[2..].chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));

        let message = new_message_id();
        assert!(message.starts_with("m_"), "{message}");
        let (time, rand) = message[2..].split_once('_').unwrap();
        assert_eq!(rand.len(), 6, "6 random base36 chars");
        assert!(time.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()));

        let part = new_part_id();
        assert!(part.starts_with('p') && part[1..].starts_with('_'), "{part}");

        // Same-era timestamps produce equal-length base36 prefixes, so the
        // message-window cursor (ORDER BY id) sorts by creation time.
        let a = message_id_at(1_759_000_000_000);
        let b = message_id_at(1_759_000_001_000);
        assert!(a < b, "{a} < {b}");
        assert!(part_id_at(1_759_000_000_000) < part_id_at(1_759_000_001_000));

        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        // Date.now() at 91ec558-era values is 8 base36 digits — fixed width,
        // so equal-era ids always compare by their time prefixes correctly.
        assert_eq!(to_base36(1_759_000_000_000).len(), 8);
    }

    #[test]
    fn create_session_round_trips_through_the_reader() {
        let (dir, writer) = writer_at("create-session");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_new",
                    workspace_path: "/ws/rt",
                    title: "New session",
                    model_id: "model-x",
                    provider_id: Some("prov-1"),
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        let reader = reader_at(&dir);
        let page = reader
            .list_sessions("/ws/rt", SessionListOptsV2::default())
            .unwrap();
        assert_eq!(
            serde_json::to_value(&page.sessions).unwrap(),
            json!([{
                "id": "s_new",
                "workspacePath": "/ws/rt",
                "parentId": null,
                "title": "New session",
                "modelId": "model-x",
                "providerId": "prov-1",
                "tokensInput": 0,
                "tokensOutput": 0,
                "tokensReasoning": 0,
                "tokensCacheRead": 0,
                "cost": 0.0,
                "summaryAdditions": null,
                "summaryDeletions": null,
                "summaryFiles": null,
                "archivedAt": null,
                "timeCreated": T0,
                "timeUpdated": T0,
            }])
        );
    }

    /// The full M2 shape: a user text part, an assistant text+tool turn with
    /// deltas, usage rollups and turn.end pruning, then a second turn — all
    /// through WriteBatch commits, read back with the existing readers.
    #[test]
    fn multi_turn_round_trip_via_write_batches() {
        let (dir, writer) = writer_at("round-trip");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_rt",
                    workspace_path: "/ws/rt",
                    title: "Round trip",
                    model_id: "model-x",
                    provider_id: Some("prov-1"),
                    parent_id: None,
                },
                T0,
            )
            .unwrap();

        // Turn 1 — user text (the twinV2 pattern: message + commit, no deltas).
        writer
            .insert_message(
                InsertMessageInput { id: "m_1", session_id: "s_rt", role: "user", model: None },
                10_100,
            )
            .unwrap();
        let mut batch_a = WriteBatch::new();
        batch_a.push(text_commit("s_rt", "m_1", "p_1", "hello tide", 0));
        let out_a = writer.commit_batch(&mut batch_a, 10_150);
        assert!(out_a.persisted);
        assert!(out_a.persist_error.is_none());
        assert_eq!(out_a.batches.len(), 1);
        assert_eq!(out_a.batches[0].events.len(), 1);
        assert!(batch_a.is_empty(), "commit drains the buffer");

        // Turn 1 — assistant: deltas, text+tool parts, usage, turn.end.
        writer
            .insert_message(
                InsertMessageInput {
                    id: "m_2",
                    session_id: "s_rt",
                    role: "assistant",
                    model: Some("model-x"),
                },
                10_200,
            )
            .unwrap();
        let mut batch_b = WriteBatch::new();
        batch_b.push(delta("s_rt", "m_2", "p_2", "An"));
        batch_b.push(delta("s_rt", "m_2", "p_2", "swer"));
        batch_b.push(text_commit("s_rt", "m_2", "p_2", "Answer", 0));
        batch_b.push(tool_commit(
            "s_rt",
            "m_2",
            "p_3",
            1,
            json!({
                "toolName": "bash",
                "input": { "cmd": "ls" },
                "output": "x\n",
                "status": "completed",
                "durationMs": 12,
            }),
        ));
        batch_b.push(message_end(
            "s_rt",
            "m_2",
            json!({
                "inputTokens": 100,
                "outputTokens": 50,
                "reasoningTokens": 10,
                "cacheRead": 1000,
                "costUsd": 0.25,
            }),
        ));
        batch_b.push(turn_end("s_rt", "m_2"));
        let out_b = writer.commit_batch(&mut batch_b, 10_300);
        assert!(out_b.persisted);
        let batch = &out_b.batches[0];
        assert_eq!(batch.events.len(), 6);
        let seqs: Vec<i64> = batch.events.iter().map(|e| e.seq.unwrap()).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "rowids ascending: {seqs:?}");
        assert_eq!(batch.first_seq, seqs[0]);
        assert_eq!(batch.last_seq, *seqs.last().unwrap());

        // Turn 2 — user + assistant with its own usage.
        writer
            .insert_message(
                InsertMessageInput { id: "m_3", session_id: "s_rt", role: "user", model: None },
                10_400,
            )
            .unwrap();
        let mut batch_c = WriteBatch::new();
        batch_c.push(text_commit("s_rt", "m_3", "p_4", "again", 0));
        writer.commit_batch(&mut batch_c, 10_450);
        writer
            .insert_message(
                InsertMessageInput {
                    id: "m_4",
                    session_id: "s_rt",
                    role: "assistant",
                    model: Some("model-x"),
                },
                10_500,
            )
            .unwrap();
        let mut batch_d = WriteBatch::new();
        batch_d.push(text_commit("s_rt", "m_4", "p_5", "done", 0));
        batch_d.push(message_end(
            "s_rt",
            "m_4",
            json!({ "inputTokens": 200, "outputTokens": 25, "costUsd": 0.125 }),
        ));
        batch_d.push(turn_end("s_rt", "m_4"));
        writer.commit_batch(&mut batch_d, 10_600);

        // Read back with the EXISTING reader: exact wire shapes.
        let reader = reader_at(&dir);
        let page = reader
            .session_messages("s_rt", SessionWindowOptsV2::default())
            .unwrap();
        assert_eq!(
            serde_json::to_value(&page).unwrap(),
            json!({
                "messages": [
                    {
                        "id": "m_1", "role": "user", "model": null,
                        "timeCreated": 10_100, "timeCompleted": null,
                        "parts": [
                            { "id": "p_1", "seq": 0, "kind": "text",
                              "data": { "text": "hello tide" } },
                        ],
                    },
                    {
                        "id": "m_2", "role": "assistant", "model": "model-x",
                        "timeCreated": 10_200, "timeCompleted": 10_300,
                        "parts": [
                            { "id": "p_2", "seq": 0, "kind": "text",
                              "data": { "text": "Answer" } },
                            { "id": "p_3", "seq": 1, "kind": "tool",
                              "data": { "toolName": "bash", "input": { "cmd": "ls" },
                                        "output": "x\n", "status": "completed",
                                        "durationMs": 12 } },
                        ],
                    },
                    {
                        "id": "m_3", "role": "user", "model": null,
                        "timeCreated": 10_400, "timeCompleted": null,
                        "parts": [
                            { "id": "p_4", "seq": 0, "kind": "text",
                              "data": { "text": "again" } },
                        ],
                    },
                    {
                        "id": "m_4", "role": "assistant", "model": "model-x",
                        "timeCreated": 10_500, "timeCompleted": 10_600,
                        "parts": [
                            { "id": "p_5", "seq": 0, "kind": "text",
                              "data": { "text": "done" } },
                        ],
                    },
                ],
                "nextBefore": null,
            })
        );

        // Rollups accumulated across both turns; time_updated follows the last usage.
        let meta = reader
            .list_sessions("/ws/rt", SessionListOptsV2::default())
            .unwrap()
            .sessions;
        assert_eq!(
            serde_json::to_value(&meta).unwrap(),
            json!([{
                "id": "s_rt",
                "workspacePath": "/ws/rt",
                "parentId": null,
                "title": "Round trip",
                "modelId": "model-x",
                "providerId": "prov-1",
                "tokensInput": 300,
                "tokensOutput": 75,
                "tokensReasoning": 10,
                "tokensCacheRead": 1000,
                "cost": 0.375,
                "summaryAdditions": null,
                "summaryDeletions": null,
                "summaryFiles": null,
                "archivedAt": null,
                "timeCreated": T0,
                "timeUpdated": 10_600,
            }])
        );

        // No live consumer ever subscribed: both turn.ends pruned everything
        // else, and only their markers remain for replay.
        let replay = writer.replay_events("s_rt", 0, None).unwrap();
        let kinds: Vec<&str> = replay.iter().map(|e| e.r#type.as_str()).collect();
        assert_eq!(kinds, ["turn.end", "turn.end"]);
        assert!(replay[0].seq.unwrap() < replay[1].seq.unwrap());
    }

    #[test]
    fn commit_rolls_back_whole_and_degrades_push_only_on_failure() {
        let (_dir, writer) = writer_at("atomic");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_x",
                    workspace_path: "/ws/x",
                    title: "X",
                    model_id: "model-x",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        // No m_9 message row: the part insert trips the FK mid-transaction.
        let mut batch = WriteBatch::new();
        batch.push(delta("s_x", "m_9", "p_9", "text"));
        batch.push(text_commit("s_x", "m_9", "p_9", "text", 0));
        batch.push(turn_end("s_x", "m_9"));
        let out = writer.commit_batch(&mut batch, 10_100);
        assert!(!out.persisted);
        assert!(out.persist_error.as_deref().unwrap().to_lowercase().contains("foreign key"));
        assert!(batch.is_empty(), "failed commit still consumes the events");
        // Degraded delivery: unstamped events, firstSeq/lastSeq 0.
        assert_eq!(out.batches.len(), 1);
        let degraded = &out.batches[0];
        assert_eq!(degraded.first_seq, 0);
        assert_eq!(degraded.last_seq, 0);
        assert_eq!(degraded.events.len(), 3);
        assert!(degraded.events.iter().all(|e| e.seq.is_none()));
        // Nothing leaked: the transaction rolled back whole.
        assert_eq!(event_rows(&writer, "s_x").len(), 0);
        let parts: i64 = writer
            .conn
            .query_row("SELECT COUNT(*) FROM part", [], |r| r.get(0))
            .unwrap();
        assert_eq!(parts, 0);
    }

    #[test]
    fn prune_below_floor_keeps_turn_ends_and_post_floor_events() {
        let (_dir, mut writer) = writer_at("prune-floor");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_p",
                    workspace_path: "/ws/p",
                    title: "P",
                    model_id: "model-x",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        writer
            .insert_message(
                InsertMessageInput { id: "m_1", session_id: "s_p", role: "assistant", model: None },
                T0,
            )
            .unwrap();

        // Turn 1 (no live consumer yet): delta at 1, turn.end at 2 — the
        // marker prunes its own turn's delta immediately.
        let mut first = WriteBatch::new();
        first.push(delta("s_p", "m_1", "p_1", "a"));
        first.push(turn_end("s_p", "m_1"));
        let out = writer.commit_batch(&mut first, 10_100);
        assert!(out.persisted);
        assert_eq!(out.batches[0].last_seq, 2);

        // Turn 2 streams deltas (seqs 3-4) and the consumer subscribes
        // MID-turn, replaying through seq 3 → floor 4 (past the last delivered
        // row). markLive is monotonic: a stale lower value loses.
        let mut second = WriteBatch::new();
        second.push(delta("s_p", "m_1", "p_2", "b"));
        second.push(delta("s_p", "m_1", "p_2", "c"));
        writer.commit_batch(&mut second, 10_150);
        writer.mark_live("s_p", 4);
        writer.mark_live("s_p", 1);
        assert_eq!(writer.live_floor("s_p"), Some(4));

        // Turn 2 closes: delta at 5, turn.end at 6 — pruning deletes seq < 4,
        // the boundary row (4) and post-floor rows stay, and every turn.end
        // (2 and 6) survives regardless of the floor.
        let mut third = WriteBatch::new();
        third.push(delta("s_p", "m_1", "p_2", "d"));
        third.push(turn_end("s_p", "m_1"));
        writer.commit_batch(&mut third, 10_200);

        assert_eq!(
            event_rows(&writer, "s_p"),
            vec![
                (2, "turn.end".to_owned()),
                (4, "part.delta".to_owned()),
                (5, "part.delta".to_owned()),
                (6, "turn.end".to_owned()),
            ]
        );

        // Replay picks up strictly after a cursor, seq-stamped.
        let replay = writer.replay_events("s_p", 2, None).unwrap();
        let seqs: Vec<i64> = replay.iter().map(|e| e.seq.unwrap()).collect();
        assert_eq!(seqs, [4, 5, 6]);
        assert!(replay.iter().all(|e| e.session_id == "s_p"));
    }

    #[test]
    fn standalone_prune_and_replay_limit() {
        let (_dir, writer) = writer_at("prune-direct");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_d",
                    workspace_path: "/ws/d",
                    title: "D",
                    model_id: "model-x",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        let mut seqs = Vec::new();
        for i in 0..5 {
            seqs.push(
                writer
                    .insert_event(&delta("s_d", &format!("m_{i}"), "p", "x"), T0 + i)
                    .unwrap(),
            );
        }
        assert_eq!(seqs, [1, 2, 3, 4, 5], "AUTOINCREMENT rowids from 1");
        assert_eq!(writer.replay_events("s_d", 0, Some(2)).unwrap().len(), 2);
        assert_eq!(writer.replay_events("s_d", 3, None).unwrap().len(), 2);
        assert!(writer.replay_events("s_d", 5, None).unwrap().is_empty());

        // No-floor standalone prune: everything non-turn.end goes.
        writer.prune_events_below_floor("s_d", None).unwrap();
        assert_eq!(event_rows(&writer, "s_d").len(), 0);
        // Floor prune keeps the boundary row (seq < floor only).
        let again = writer.insert_event(&turn_end("s_d", "m_0"), T0).unwrap();
        writer.prune_events_below_floor("s_d", Some(again)).unwrap();
        assert_eq!(event_rows(&writer, "s_d"), vec![(again, "turn.end".to_owned())]);
    }

    #[test]
    fn message_end_without_usage_completes_but_skips_rollup() {
        let (dir, writer) = writer_at("no-usage");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_n",
                    workspace_path: "/ws/n",
                    title: "N",
                    model_id: "model-x",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        writer
            .insert_message(
                InsertMessageInput {
                    id: "m_1",
                    session_id: "s_n",
                    role: "assistant",
                    model: None,
                },
                10_100,
            )
            .unwrap();
        let mut batch = WriteBatch::new();
        batch.push(message_end("s_n", "m_1", json!({})));
        batch.push(turn_end("s_n", "m_1"));
        writer.commit_batch(&mut batch, 10_200);

        let reader = reader_at(&dir);
        let page = reader
            .session_messages("s_n", SessionWindowOptsV2::default())
            .unwrap();
        assert_eq!(page.messages[0].time_completed, Some(10_200));
        let meta = reader
            .list_sessions("/ws/n", SessionListOptsV2::default())
            .unwrap()
            .sessions;
        assert_eq!(meta[0].tokens_input, 0);
        assert_eq!(meta[0].cost, 0.0);
    }

    #[test]
    fn part_commit_is_idempotent_and_defaults_seq_to_zero() {
        let (dir, writer) = writer_at("part-idempotent");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_i",
                    workspace_path: "/ws/i",
                    title: "I",
                    model_id: "model-x",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        writer
            .insert_message(
                InsertMessageInput { id: "m_1", session_id: "s_i", role: "assistant", model: None },
                T0,
            )
            .unwrap();
        let mut batch = WriteBatch::new();
        batch.push(text_commit("s_i", "m_1", "p_1", "first", 3));
        batch.push(text_commit("s_i", "m_1", "p_1", "second", 7));
        batch.push(turn_end("s_i", "m_1"));
        writer.commit_batch(&mut batch, 10_100);

        // Re-commit of an existing part id is ignored: first body + seq win.
        let reader = reader_at(&dir);
        let page = reader
            .session_messages("s_i", SessionWindowOptsV2::default())
            .unwrap();
        assert_eq!(page.messages[0].parts.len(), 1);
        assert_eq!(page.messages[0].parts[0].id, "p_1");
        assert_eq!(page.messages[0].parts[0].seq, 3);
        assert_eq!(page.messages[0].parts[0].data, json!({ "text": "first" }));

        // A commit body without `seq` lands seq 0 (`$seq: body.seq ?? 0`).
        let mut unsequenced = WriteBatch::new();
        unsequenced.push(SinkEventWire {
            r#type: SinkEventType::PartCommit,
            session_id: "s_i".to_owned(),
            message_id: Some("m_1".to_owned()),
            part_id: Some("p_2".to_owned()),
            data: Some(json!({ "kind": "text", "data": { "text": "no seq" } })),
            seq: None,
        });
        unsequenced.push(turn_end("s_i", "m_1"));
        writer.commit_batch(&mut unsequenced, 10_200);
        let page = reader
            .session_messages("s_i", SessionWindowOptsV2::default())
            .unwrap();
        let p2 = page.messages[0].parts.iter().find(|p| p.id == "p_2").unwrap();
        assert_eq!(p2.seq, 0);
    }

    #[test]
    fn update_part_data_rewrites_and_touches() {
        let (dir, writer) = writer_at("part-update");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_u",
                    workspace_path: "/ws/u",
                    title: "U",
                    model_id: "model-x",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        writer
            .insert_message(
                InsertMessageInput { id: "m_1", session_id: "s_u", role: "assistant", model: None },
                T0,
            )
            .unwrap();
        let mut batch = WriteBatch::new();
        batch.push(tool_commit(
            "s_u",
            "m_1",
            "p_1",
            0,
            json!({ "toolName": "bash", "input": { "cmd": "ls" }, "status": "running" }),
        ));
        batch.push(turn_end("s_u", "m_1"));
        writer.commit_batch(&mut batch, 10_100);

        let updated = json!({
            "toolName": "bash",
            "input": { "cmd": "ls" },
            "output": "x\n",
            "status": "completed",
            "durationMs": 12,
        });
        assert_eq!(writer.update_part_data("p_1", &updated, 10_200).unwrap(), 1);
        assert_eq!(writer.update_part_data("ghost", &updated, 10_200).unwrap(), 0);

        let reader = reader_at(&dir);
        let page = reader
            .session_messages("s_u", SessionWindowOptsV2::default())
            .unwrap();
        assert_eq!(page.messages[0].parts[0].data, updated);
        let time_updated: i64 = writer
            .conn
            .query_row("SELECT time_updated FROM part WHERE id = 'p_1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(time_updated, 10_200);
    }

    #[test]
    fn update_archive_delete_session_lifecycle() {
        let (dir, writer) = writer_at("lifecycle");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_l",
                    workspace_path: "/ws/l",
                    title: "Old title",
                    model_id: "model-a",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        writer
            .update_session(
                "s_l",
                SessionPatch { title: Some("Renamed"), model_id: Some("model-b"), provider_id: Some("prov-9") },
                20_000,
            )
            .unwrap();
        let reader = reader_at(&dir);
        let meta = &reader
            .list_sessions("/ws/l", SessionListOptsV2::default())
            .unwrap()
            .sessions[0];
        assert_eq!(meta.title, "Renamed");
        assert_eq!(meta.model_id.as_deref(), Some("model-b"));
        assert_eq!(meta.provider_id.as_deref(), Some("prov-9"));
        assert_eq!(meta.time_updated, 20_000);

        // Archive stamps archived_at only — time_updated keeps its value.
        writer.archive_session("s_l", 30_000).unwrap();
        let reader = reader_at(&dir);
        assert!(reader
            .list_sessions("/ws/l", SessionListOptsV2::default())
            .unwrap()
            .sessions
            .is_empty());
        let archived = &reader
            .list_sessions("/ws/l", SessionListOptsV2 { archived: true, ..Default::default() })
            .unwrap()
            .sessions[0];
        assert_eq!(archived.archived_at, Some(30_000));
        assert_eq!(archived.time_updated, 20_000);

        // Delete cascades messages/parts; events carry no FK and remain.
        writer
            .insert_message(
                InsertMessageInput { id: "m_1", session_id: "s_l", role: "user", model: None },
                30_100,
            )
            .unwrap();
        writer
            .insert_part(
                InsertPartInput {
                    id: "p_1",
                    message_id: "m_1",
                    session_id: "s_l",
                    seq: 0,
                    kind: "text",
                    data: &json!({ "text": "bye" }),
                },
                30_100,
            )
            .unwrap();
        writer.insert_event(&turn_end("s_l", "m_1"), 30_100).unwrap();
        writer.delete_session("s_l").unwrap();
        let reader = reader_at(&dir);
        assert!(reader
            .list_sessions("/ws/l", SessionListOptsV2 { archived: true, ..Default::default() })
            .unwrap()
            .sessions
            .is_empty());
        let messages: i64 = writer
            .conn
            .query_row("SELECT COUNT(*) FROM message", [], |r| r.get(0))
            .unwrap();
        let parts: i64 = writer
            .conn
            .query_row("SELECT COUNT(*) FROM part", [], |r| r.get(0))
            .unwrap();
        assert_eq!((messages, parts), (0, 0), "FK cascade removed children");
        assert_eq!(event_rows(&writer, "s_l").len(), 1, "events orphaned, like the TS");
    }

    #[test]
    fn two_writers_serialize_under_wal() {
        let dir = temp_dir("two-writers");
        let a = SessionsV2Writer::open(dir.db()).unwrap();
        let b = SessionsV2Writer::open(dir.db()).unwrap();
        for (sid, mid) in [("sA", "mA"), ("sB", "mB")] {
            let (writer, other) = if sid == "sA" { (&a, &b) } else { (&b, &a) };
            let _ = other;
            writer
                .create_session(
                    CreateSessionInput {
                        id: sid,
                        workspace_path: "/ws/w",
                        title: sid,
                        model_id: "model-x",
                        provider_id: None,
                        parent_id: None,
                    },
                    T0,
                )
                .unwrap();
            writer
                .insert_message(
                    InsertMessageInput { id: mid, session_id: sid, role: "assistant", model: None },
                    10_100,
                )
                .unwrap();
        }

        let handle = std::thread::spawn(move || {
            let mut all_persisted = true;
            for i in 0..5 {
                let mut batch = WriteBatch::new();
                batch.push(text_commit("sB", "mB", &format!("pB{i}"), "b", i));
                batch.push(turn_end("sB", "mB"));
                all_persisted &= b.commit_batch(&mut batch, 20_000 + i).persisted;
            }
            all_persisted
        });
        let mut all_persisted = true;
        for i in 0..5 {
            let mut batch = WriteBatch::new();
            batch.push(text_commit("sA", "mA", &format!("pA{i}"), "a", i));
            batch.push(turn_end("sA", "mA"));
            all_persisted &= a.commit_batch(&mut batch, 20_000 + i).persisted;
        }
        assert!(handle.join().unwrap(), "writer B fully persisted");
        assert!(all_persisted, "writer A fully persisted");

        // Both writers' parts are durable; each session's turn.ends pruned
        // its own non-turn.end events (per-writer floor maps were empty).
        let reader = reader_at(&dir);
        for (sid, mid) in [("sA", "mA"), ("sB", "mB")] {
            let page = reader
                .session_messages(sid, SessionWindowOptsV2::default())
                .unwrap();
            assert_eq!(page.messages[0].id, mid);
            assert_eq!(page.messages[0].parts.len(), 5);
            let rows = event_rows(&a, sid);
            assert!(
                rows.iter().all(|(_, kind)| kind == "turn.end"),
                "only turn.end markers survive: {rows:?}"
            );
        }
    }

    #[test]
    fn flush_batch_and_sink_event_match_the_wire_shape() {
        let event = SinkEventWire {
            r#type: SinkEventType::PartDelta,
            session_id: "s_w".to_owned(),
            message_id: None,
            part_id: Some("p_w".to_owned()),
            data: Some(json!({ "text": "x" })),
            seq: None,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "type": "part.delta", "sessionId": "s_w", "partId": "p_w", "data": { "text": "x" } }),
            "`?` optionals are omitted, never null"
        );
        let stamped = SinkEventWire { seq: Some(7), ..event.clone() };
        let batch = FlushBatchWire {
            events: vec![stamped],
            first_seq: 7,
            last_seq: 7,
        };
        assert_eq!(
            serde_json::to_value(&batch).unwrap(),
            json!({
                "events": [ { "type": "part.delta", "sessionId": "s_w", "partId": "p_w",
                              "data": { "text": "x" }, "seq": 7 } ],
                "firstSeq": 7,
                "lastSeq": 7,
            })
        );
        // Round-trip: the renderer-facing contract parses back identically.
        let parsed: FlushBatchWire =
            serde_json::from_value(serde_json::to_value(&batch).unwrap()).unwrap();
        assert_eq!(parsed, batch);
        let none_seq: SinkEventWire = serde_json::from_value(json!({
            "type": "turn.end", "sessionId": "s_w", "messageId": "m_w"
        }))
        .unwrap();
        assert_eq!(none_seq.r#type, SinkEventType::TurnEnd);
        assert_eq!(none_seq.seq, None);
        assert_eq!(none_seq.data, None);
    }

    #[test]
    fn session_settings_patch_is_set_or_keep() {
        let (dir, writer) = writer_at("settings");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_1",
                    workspace_path: "/ws",
                    title: "T",
                    model_id: "m",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        assert_eq!(writer.session_settings("s_1"), None);

        writer.set_session_settings("s_1", Some("plan"), None, T0 + 1).unwrap();
        assert_eq!(
            writer.session_settings("s_1"),
            Some((Some("plan".into()), None))
        );
        writer.set_session_settings("s_1", None, Some("high"), T0 + 2).unwrap();
        assert_eq!(
            writer.session_settings("s_1"),
            Some((Some("plan".into()), Some("high".into())))
        );
        // Ghost sessions have no row to keep — the probe stays None.
        assert_eq!(writer.session_settings("s_ghost"), None);
        drop(writer);
        drop(dir);
    }

    #[test]
    fn worktree_round_trips_and_clears() {
        let (dir, writer) = writer_at("worktree");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_1",
                    workspace_path: "/ws",
                    title: "T",
                    model_id: "m",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        let wt = json!({
            "branch": "wt-1", "path": "/ws/.agent/worktrees/wt-1",
            "baseCommit": "abc1234", "baseBranch": "main", "ahead": 0, "behind": 0
        });
        writer.set_session_worktree("s_1", Some(&wt), T0 + 1).unwrap();
        assert_eq!(writer.session_worktree("s_1"), Some(wt.clone()));

        writer.set_session_worktree("s_1", None, T0 + 2).unwrap();
        assert_eq!(writer.session_worktree("s_1"), None);
        drop(writer);
        drop(dir);
    }

    #[test]
    fn archive_state_probe_unarchive_and_cascade() {
        let (dir, writer) = writer_at("archive-state");
        for (id, parent) in [("s_main", None), ("s_sub", Some("s_main"))] {
            writer
                .create_session(
                    CreateSessionInput {
                        id,
                        workspace_path: "/ws",
                        title: "T",
                        model_id: "m",
                        provider_id: None,
                        parent_id: parent,
                    },
                    T0,
                )
                .unwrap();
        }
        writer.create_session(
            CreateSessionInput {
                id: "s_other",
                workspace_path: "/other",
                title: "T",
                model_id: "m",
                provider_id: None,
                parent_id: None,
            },
            T0,
        )
        .unwrap();
        assert_eq!(writer.session_archived("s_main"), Some(false));
        assert_eq!(writer.session_archived("s_ghost"), None);

        // The TS archive cascade came from listSessions — mains only.
        assert_eq!(
            writer.archive_workspace_sessions("/ws", T0 + 5, true).unwrap(),
            1
        );
        assert_eq!(writer.session_archived("s_main"), Some(true));
        assert_eq!(writer.session_archived("s_sub"), Some(false));

        // Unarchive cascades from listArchived — everything archived.
        writer.archive_workspace_sessions("/ws", T0 + 6, false).unwrap();
        writer.unarchive_session("s_main").unwrap();
        assert_eq!(writer.session_archived("s_main"), Some(false));

        assert_eq!(
            writer.session_ids_by_workspace("/ws"),
            vec!["s_main".to_owned(), "s_sub".to_owned()]
        );

        // delete_session clears the side tables alongside the row.
        writer.set_session_todos("s_main", &json!([{ "content": "x" }]), T0 + 7).unwrap();
        writer.set_session_settings("s_main", Some("ask"), Some("low"), T0 + 8).unwrap();
        writer.delete_session("s_main").unwrap();
        assert_eq!(writer.session_archived("s_main"), None);
        assert_eq!(writer.session_todos("s_main"), None);
        assert_eq!(writer.session_settings("s_main"), None);
        drop(writer);
        drop(dir);
    }

    #[test]
    fn clear_all_wipes_every_table() {
        let (dir, writer) = writer_at("clear-all");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_1",
                    workspace_path: "/ws",
                    title: "T",
                    model_id: "m",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        writer
            .insert_message(
                InsertMessageInput { id: "m_1", session_id: "s_1", role: "user", model: None },
                T0 + 1,
            )
            .unwrap();
        let mut batch = WriteBatch::new();
        batch.push(text_commit("s_1", "m_1", "p_1", "hi", 0));
        writer.commit_batch(&mut batch, T0 + 2);
        writer.set_session_todos("s_1", &json!([]), T0 + 3).unwrap();
        writer.set_session_settings("s_1", Some("ask"), None, T0 + 4).unwrap();

        writer.clear_all().unwrap();
        let reader = reader_at(&dir);
        let page = reader
            .list_sessions("/ws", SessionListOptsV2::default())
            .unwrap();
        assert!(page.sessions.is_empty());
        let messages = reader
            .session_messages("s_1", SessionWindowOptsV2::default())
            .unwrap();
        assert!(messages.messages.is_empty());
        drop(reader);
        assert_eq!(writer.session_settings("s_1"), None);
        assert_eq!(writer.session_todos("s_1"), None);
        drop(writer);
        drop(dir);
    }

    #[test]
    fn last_text_part_targets_the_newest_text_part() {
        let (dir, writer) = writer_at("last-text-part");
        writer
            .create_session(
                CreateSessionInput {
                    id: "s_1",
                    workspace_path: "/ws",
                    title: "T",
                    model_id: "m",
                    provider_id: None,
                    parent_id: None,
                },
                T0,
            )
            .unwrap();
        writer
            .insert_message(
                InsertMessageInput { id: "m_1", session_id: "s_1", role: "assistant", model: None },
                T0 + 1,
            )
            .unwrap();
        assert_eq!(writer.last_text_part_of("m_1"), None);
        writer
            .insert_part(
                InsertPartInput { id: "p_t", message_id: "m_1", session_id: "s_1", seq: 0, kind: "thinking", data: &json!({ "text": "hm" }) },
                T0 + 2,
            )
            .unwrap();
        writer
            .insert_part(
                InsertPartInput { id: "p_x", message_id: "m_1", session_id: "s_1", seq: 1, kind: "text", data: &json!({ "text": "one" }) },
                T0 + 3,
            )
            .unwrap();
        writer
            .insert_part(
                InsertPartInput { id: "p_y", message_id: "m_1", session_id: "s_1", seq: 2, kind: "text", data: &json!({ "text": "two" }) },
                T0 + 4,
            )
            .unwrap();
        assert_eq!(writer.last_text_part_of("m_1").as_deref(), Some("p_y"));
        assert_eq!(writer.last_text_part_of("m_ghost"), None);
        drop(writer);
        drop(dir);
    }

    #[test]
    fn workspace_id_matches_the_ts_scheme() {
        let id = new_workspace_id();
        assert!(id.starts_with("ws_"), "{id}");
        assert_eq!(id.len(), 3 + 8);
        assert!(id[3..].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    }
}
