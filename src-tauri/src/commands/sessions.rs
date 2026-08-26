//! `sessionListV2` / `sessionMessagesV2` plus the legacy sidebar pair
//! `sessionList` / `sessionListArchived` — thin command wrappers over the
//! tide-store sessions-v2 reader. The 91ec558 shell created the db file at
//! boot, so a missing db always read as an empty store; the command layer
//! reproduces that (empty page, not an error) while real open/schema errors
//! still surface.
//!
//! The legacy pair takes a config workspaceId (the v2 store keys rows by
//! workspace_path): resolve id → path via the config workspaces, then stamp
//! the requested id back onto every header. An unknown id matched nothing in
//! the 91ec558 store (headers were keyed by workspaceId directly) and still
//! returns an empty list — not a `WORKSPACE_NOT_FOUND` error.

use tide_store::sessions_v2::{
    ArchivedHeaderWire, SessionHeaderWire, SessionListOptsV2, SessionListPageV2,
    SessionMessagesPageV2, SessionWindowOptsV2, SessionsV2,
};

use crate::state::AppState;

use super::CommandError;

#[tauri::command]
pub fn session_list_v2(
    state: tauri::State<AppState>,
    workspace_path: String,
    opts: Option<SessionListOptsV2>,
) -> Result<SessionListPageV2, CommandError> {
    list(&state, &workspace_path, opts.unwrap_or_default())
}

fn list(
    state: &AppState,
    workspace_path: &str,
    opts: SessionListOptsV2,
) -> Result<SessionListPageV2, CommandError> {
    match open_store(state)? {
        Some(store) => store
            .list_sessions(workspace_path, opts)
            .map_err(CommandError::from),
        None => Ok(SessionListPageV2 {
            sessions: Vec::new(),
            next_cursor: None,
        }),
    }
}

#[tauri::command]
pub fn session_messages_v2(
    state: tauri::State<AppState>,
    session_id: String,
    opts: Option<SessionWindowOptsV2>,
) -> Result<SessionMessagesPageV2, CommandError> {
    messages(&state, &session_id, opts.unwrap_or_default())
}

fn messages(
    state: &AppState,
    session_id: &str,
    opts: SessionWindowOptsV2,
) -> Result<SessionMessagesPageV2, CommandError> {
    match open_store(state)? {
        Some(store) => store
            .session_messages(session_id, opts)
            .map_err(CommandError::from),
        None => Ok(SessionMessagesPageV2 {
            messages: Vec::new(),
            next_before: None,
        }),
    }
}

fn open_store(state: &AppState) -> Result<Option<SessionsV2>, CommandError> {
    let path = state.sessions_db_path();
    if !path.is_file() {
        return Ok(None);
    }
    SessionsV2::open(&path).map(Some).map_err(CommandError::from)
}

#[tauri::command]
pub fn session_list(
    state: tauri::State<AppState>,
    workspace_id: String,
) -> Result<Vec<SessionHeaderWire>, CommandError> {
    list_headers(&state, &workspace_id)
}

fn list_headers(state: &AppState, workspace_id: &str) -> Result<Vec<SessionHeaderWire>, CommandError> {
    let Some(workspace_path) = workspace_path_of(state, workspace_id)? else {
        return Ok(Vec::new());
    };
    match open_store(state)? {
        Some(store) => store
            .list_session_headers(&workspace_path, workspace_id)
            .map_err(CommandError::from),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn session_list_archived(
    state: tauri::State<AppState>,
    workspace_id: String,
) -> Result<Vec<ArchivedHeaderWire>, CommandError> {
    list_archived(&state, &workspace_id)
}

fn list_archived(state: &AppState, workspace_id: &str) -> Result<Vec<ArchivedHeaderWire>, CommandError> {
    let Some(workspace_path) = workspace_path_of(state, workspace_id)? else {
        return Ok(Vec::new());
    };
    match open_store(state)? {
        Some(store) => store
            .list_archived_headers(&workspace_path, workspace_id)
            .map_err(CommandError::from),
        None => Ok(Vec::new()),
    }
}

/// Port of the 91ec558 `workspacePathOf`: first config workspace whose id
/// matches. None for an unknown id — callers read that as an empty list.
fn workspace_path_of(state: &AppState, workspace_id: &str) -> Result<Option<String>, CommandError> {
    state.read_config(|cfg| {
        cfg.workspaces
            .iter()
            .find(|ws| ws.id == workspace_id)
            .map(|ws| ws.path.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// Minimal v2 schema subset the reader touches (the full DDL lives in
    /// tide-store's own tests; this replicates just enough to seed).
    const V2_SCHEMA: &str = "
        CREATE TABLE session (
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
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          role TEXT NOT NULL, model TEXT,
          time_created INTEGER NOT NULL, time_completed INTEGER
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          data TEXT NOT NULL,
          time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
        );";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-sessions-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_db(dir: &Path) {
        let conn = Connection::open(dir.join("sessions-v2.db")).unwrap();
        conn.execute_batch(V2_SCHEMA).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        for (id, ts) in [("s-two", 4_000), ("s-one", 3_000)] {
            conn.execute(
                "INSERT INTO session (id, workspace_path, title, time_created, time_updated) \
                 VALUES (?1, '/ws/alpha', ?2, 1_000, ?3)",
                rusqlite::params![id, id, ts],
            )
            .unwrap();
        }
        for i in 1..=3 {
            conn.execute(
                "INSERT INTO message (id, session_id, role, time_created) VALUES (?1, 's-one', 'user', 1_000)",
                rusqlite::params![format!("msg-{i:02}")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO part (id, message_id, session_id, seq, kind, data, time_created, time_updated) \
                 VALUES (?1, ?2, 's-one', 0, 'text', '{\"text\":\"hi\"}', 1_000, 1_000)",
                rusqlite::params![format!("msg-{i:02}-p0"), format!("msg-{i:02}")],
            )
            .unwrap();
        }
    }

    fn state_over(name: &str, seed: bool) -> (AppState, PathBuf) {
        let dir = temp_dir(name);
        if seed {
            seed_db(&dir);
        }
        (AppState::load(dir.clone()), dir)
    }

    /// Config with two workspaces plus a db seeded for the legacy pair:
    /// /ws/alpha holds two mains (one null-model), a subagent, and an
    /// archived row; /ws/beta holds one main.
    fn state_legacy(name: &str) -> (AppState, PathBuf) {
        let dir = temp_dir(name);
        fs::write(
            dir.join("config.json"),
            r#"{"workspaces":[
                { "id": "ws_1", "name": "alpha", "path": "/ws/alpha" },
                { "id": "ws_2", "name": "beta", "path": "/ws/beta" }
            ]}"#,
        )
        .unwrap();
        let conn = Connection::open(dir.join("sessions-v2.db")).unwrap();
        conn.execute_batch(V2_SCHEMA).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        let rows = [
            ("s-main-1", "/ws/alpha", "Main One", None as Option<&str>, None as Option<i64>, 4_000i64),
            ("s-main-2", "/ws/alpha", "Main Two", Some("model-x"), None, 2_000),
            ("s-sub", "/ws/alpha", "Child", None, None, 9_000),
            ("s-arch", "/ws/alpha", "Archived", None, Some(3_000), 5_000),
            ("s-beta-1", "/ws/beta", "Beta", None, None, 1_000),
        ];
        for (id, path, title, model, archived, updated) in rows {
            conn.execute(
                "INSERT INTO session (id, workspace_path, parent_id, title, model_id, archived_at, \
                 time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    id,
                    path,
                    if id == "s-sub" { Some("s-main-1") } else { None },
                    title,
                    model,
                    archived,
                    updated - 1_000,
                    updated
                ],
            )
            .unwrap();
        }
        for i in 1..=2 {
            conn.execute(
                "INSERT INTO message (id, session_id, role, time_created) VALUES (?1, 's-main-1', 'user', 1_000)",
                rusqlite::params![format!("m-{i}")],
            )
            .unwrap();
        }
        drop(conn);
        (AppState::load(dir.clone()), dir)
    }

    #[test]
    fn list_passes_through_pages_and_wire_shape() {
        let (state, dir) = state_over("list", true);
        let page = list(&state, "/ws/alpha", SessionListOptsV2::default()).unwrap();
        let ids: Vec<&str> = page.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["s-two", "s-one"]);
        assert_eq!(page.next_cursor, None);

        let page = list(
            &state,
            "/ws/alpha",
            SessionListOptsV2 { limit: Some(1), ..Default::default() },
        )
        .unwrap();
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].id, "s-two");
        assert_eq!(page.next_cursor.as_deref(), Some("s-one"));

        let wire = serde_json::to_value(
            list(&state, "/ws/alpha", SessionListOptsV2::default()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "sessions": [
                    { "id": "s-two", "workspacePath": "/ws/alpha", "parentId": null,
                      "title": "s-two", "modelId": null, "providerId": null,
                      "tokensInput": 0, "tokensOutput": 0, "tokensReasoning": 0,
                      "tokensCacheRead": 0, "cost": 0.0, "summaryAdditions": null,
                      "summaryDeletions": null, "summaryFiles": null, "archivedAt": null,
                      "timeCreated": 1_000, "timeUpdated": 4_000 },
                    { "id": "s-one", "workspacePath": "/ws/alpha", "parentId": null,
                      "title": "s-one", "modelId": null, "providerId": null,
                      "tokensInput": 0, "tokensOutput": 0, "tokensReasoning": 0,
                      "tokensCacheRead": 0, "cost": 0.0, "summaryAdditions": null,
                      "summaryDeletions": null, "summaryFiles": null, "archivedAt": null,
                      "timeCreated": 1_000, "timeUpdated": 3_000 },
                ],
                "nextCursor": null,
            })
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn messages_walk_the_before_window() {
        let (state, dir) = state_over("messages", true);
        let first = messages(
            &state,
            "s-one",
            SessionWindowOptsV2 { limit: Some(2), ..Default::default() },
        )
        .unwrap();
        let ids: Vec<&str> = first.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["msg-02", "msg-03"]);
        assert_eq!(first.next_before.as_deref(), Some("msg-02"));
        assert_eq!(first.messages[0].parts[0].kind, "text");
        assert_eq!(first.messages[0].parts[0].data, serde_json::json!({ "text": "hi" }));

        let second = messages(
            &state,
            "s-one",
            SessionWindowOptsV2 { before: first.next_before, ..Default::default() },
        )
        .unwrap();
        let ids: Vec<&str> = second.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["msg-01"]);
        assert_eq!(second.next_before, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_db_reads_as_empty_pages_not_errors() {
        let (state, dir) = state_over("missing", false);
        let page = list(&state, "/ws/alpha", SessionListOptsV2::default()).unwrap();
        assert!(page.sessions.is_empty());
        assert_eq!(page.next_cursor, None);
        let page = messages(&state, "s-one", SessionWindowOptsV2::default()).unwrap();
        assert!(page.messages.is_empty());
        assert_eq!(page.next_before, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn schema_mismatch_is_a_coded_error() {
        let (state, dir) = state_over("schema", true);
        let conn = Connection::open(dir.join("sessions-v2.db")).unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        drop(conn);

        let err = list(&state, "/ws/alpha", SessionListOptsV2::default()).unwrap_err();
        assert_eq!(err.code.as_deref(), Some("DB_SCHEMA"));
        assert!(err.message.contains("expected 2"));
        let wire = serde_json::to_value(&err).unwrap();
        assert_eq!(wire["message"], serde_json::json!(err.message));
        assert_eq!(wire["code"], serde_json::json!("DB_SCHEMA"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_list_resolves_workspace_id_and_matches_ts_shape() {
        let (state, dir) = state_legacy("legacy-list");
        let headers = list_headers(&state, "ws_1").unwrap();
        let ids: Vec<&str> = headers.iter().map(|h| h.id.as_str()).collect();
        // Subagent + archived excluded; newest first; ids map back to ws_1.
        assert_eq!(ids, ["s-main-1", "s-main-2"]);
        assert!(headers.iter().all(|h| h.workspace_id == "ws_1"));
        assert_eq!(headers[0].message_count, 2);
        assert_eq!(headers[0].model_id, "");
        assert_eq!(headers[1].model_id, "model-x");
        assert_eq!(headers[0].updated_at, "1970-01-01T00:00:04.000Z");

        let beta = list_headers(&state, "ws_2").unwrap();
        let ids: Vec<&str> = beta.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["s-beta-1"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_list_unknown_workspace_and_missing_db_read_empty() {
        let (state, dir) = state_legacy("legacy-unknown");
        // The 91ec558 store compared workspaceId against stored headers — an
        // unknown id matched nothing and returned [], never an error.
        assert!(list_headers(&state, "ws_nope").unwrap().is_empty());
        assert!(list_archived(&state, "ws_nope").unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();

        let dir = temp_dir("legacy-missing-db");
        fs::write(dir.join("config.json"), r#"{"workspaces":[{"id":"ws_1","name":"a","path":"/a"}]}"#).unwrap();
        let state = AppState::load(dir.clone());
        assert!(list_headers(&state, "ws_1").unwrap().is_empty());
        assert!(list_archived(&state, "ws_1").unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_list_archived_returns_archived_shape() {
        let (state, dir) = state_legacy("legacy-archived");
        let archived = list_archived(&state, "ws_1").unwrap();
        let ids: Vec<&str> = archived.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["s-arch"]);
        assert_eq!(archived[0].workspace_id, "ws_1");
        assert_eq!(archived[0].model_id, "");
        assert_eq!(archived[0].archived_at, "1970-01-01T00:00:03.000Z");

        assert!(list_archived(&state, "ws_2").unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_list_propagates_unreadable_config() {
        let (_seeded, dir) = state_legacy("legacy-config");
        fs::write(dir.join("config.json"), "{ broken").unwrap();
        let state = AppState::load(dir.clone());
        let err = list_headers(&state, "ws_1").unwrap_err();
        assert_eq!(err.code.as_deref(), Some("CONFIG_UNREADABLE"));
        let err = list_archived(&state, "ws_1").unwrap_err();
        assert_eq!(err.code.as_deref(), Some("CONFIG_UNREADABLE"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
