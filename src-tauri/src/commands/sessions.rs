//! `sessionListV2` / `sessionMessagesV2` — thin command wrappers over the
//! tide-store sessions-v2 reader. The 91ec558 shell created the db file at
//! boot, so a missing db always read as an empty store; the command layer
//! reproduces that (empty page, not an error) while real open/schema errors
//! still surface.

use tide_store::sessions_v2::{
    SessionListOptsV2, SessionListPageV2, SessionMessagesPageV2, SessionWindowOptsV2, SessionsV2,
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
}
