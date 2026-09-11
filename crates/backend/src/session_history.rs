//! The session-history seam's daemon-side backend — the `list_sessions` /
//! `read_session` tools' [`SessionReader`] over the app db.
//!
//! Every call opens its own read-only connection, the
//! [`persistence::StateStore::session_message_search`] pattern: the db runs
//! WAL, so a page read never blocks (or waits behind) a streaming save, and
//! no call ever holds the StateStore mutex. Reads are fenced to the
//! workspace root by joining `projects.path`, so sessions of other projects
//! never list, and a foreign id resolves `None` — the same unknown copy as
//! one that never existed.
//!
//! One limitation is inherent to the fence: a worktree session belongs to
//! its project's main checkout row, so it lists under the main root, not
//! the worktree path.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags};

use tools::{
    SessionMessage, SessionPage, SessionReader, SessionSummary, set_shared_session_reader,
};

#[derive(Debug)]
pub struct SessionHistoryBackend {
    db_path: PathBuf,
}

impl SessionHistoryBackend {
    pub fn new(db_path: impl Into<PathBuf>) -> Self {
        Self {
            db_path: db_path.into(),
        }
    }

    fn open(&self) -> Option<Connection> {
        Connection::open_with_flags(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()
    }
}

impl SessionReader for SessionHistoryBackend {
    fn list(&self, workspace_root: &Path, limit: usize) -> Vec<SessionSummary> {
        let Some(connection) = self.open() else {
            return Vec::new();
        };
        let Ok(mut statement) = connection.prepare(
            "SELECT s.id,
                    COALESCE(NULLIF(s.auto_title, ''), s.title),
                    s.updated_at,
                    s.model,
                    (SELECT COUNT(*) FROM messages m
                      WHERE m.session_id = s.id
                        AND m.streaming = 0
                        AND m.role IN ('user','assistant'))
               FROM sessions s INNER JOIN projects p ON p.id = s.project_id
              WHERE p.path = ?1
              ORDER BY s.updated_at DESC, s.id
              LIMIT ?2",
        ) else {
            return Vec::new();
        };
        let rows = statement.query_map(
            rusqlite::params![workspace_root.to_string_lossy(), limit as i64],
            |row| {
                Ok(SessionSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    updated_at: row.get::<_, i64>(2).unwrap_or(0).max(0) as u64,
                    model: row.get(3)?,
                    message_count: row.get::<_, i64>(4).unwrap_or(0).max(0) as usize,
                })
            },
        );
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn read(
        &self,
        workspace_root: &Path,
        session_id: &str,
        after_position: Option<i64>,
        limit: usize,
    ) -> Option<SessionPage> {
        let connection = self.open()?;
        let (title, total_messages): (String, i64) = connection
            .query_row(
                "SELECT COALESCE(NULLIF(s.auto_title, ''), s.title),
                        (SELECT COUNT(*) FROM messages m
                          WHERE m.session_id = s.id
                            AND m.streaming = 0
                            AND m.role IN ('user','assistant'))
                   FROM sessions s INNER JOIN projects p ON p.id = s.project_id
                  WHERE s.id = ?1 AND p.path = ?2",
                rusqlite::params![session_id, workspace_root.to_string_lossy()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()?;
        let mut statement = connection
            .prepare(
                "SELECT m.position, m.role, COALESCE(NULLIF(m.display_content, ''), m.content)
                   FROM messages m
                  WHERE m.session_id = ?1
                    AND m.streaming = 0
                    AND m.role IN ('user','assistant')
                    AND (?2 IS NULL OR m.position > ?2)
                  ORDER BY m.position ASC
                  LIMIT ?3",
            )
            .ok()?;
        let rows = statement
            .query_map(
                rusqlite::params![session_id, after_position, limit as i64],
                |row| {
                    Ok(SessionMessage {
                        position: row.get(0)?,
                        role: row.get(1)?,
                        content: row.get(2)?,
                    })
                },
            )
            .ok()?;
        let messages: Vec<SessionMessage> = rows.filter_map(Result::ok).collect();
        Some(SessionPage {
            title,
            total_messages: total_messages.max(0) as usize,
            messages,
        })
    }
}

/// Install the process-wide backend the session-history tools consult
/// (idempotent; called once at daemon boot).
pub fn install_session_reader(db_path: impl Into<PathBuf>) {
    set_shared_session_reader(Some(Arc::new(SessionHistoryBackend::new(db_path))));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Message, MessageRole, ProviderKind};
    use crate::persistence::{PersistedState, StateStore};
    use tools::{ListSessionsTool, ReadSessionTool, Tool, ToolContext};
    use uuid::Uuid;

    fn seeded() -> (
        tempfile::TempDir,
        SessionHistoryBackend,
        std::path::PathBuf,
        String,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.db");
        let store = StateStore::new(db_path.clone());
        let workspace = dir.path().join("repo");
        let mut state = PersistedState::fresh(workspace.clone());
        let project_id = state.projects[0].id;

        let current = &mut state.sessions[0];
        current.auto_title = Some("Current work".into());
        current.updated_at = 2_000;
        current.messages = vec![
            Message::new(MessageRole::User, "why does login loop?"),
            Message::new(MessageRole::Assistant, "the retry has no backoff"),
            // System traffic must never surface in a page.
            Message::new(MessageRole::System, "system noise"),
        ];
        let current_id = current.id;

        let mut past = state.new_session(project_id, ProviderKind::Tide);
        past.auto_title = Some("Past session".into());
        past.updated_at = 1_000;
        past.messages = vec![Message::new(MessageRole::User, "past question")];
        let past_id = past.id;
        state.push_session(past);

        state.mark_session_dirty(current_id);
        state.mark_session_dirty(past_id);
        store.save(&mut state).unwrap();

        (
            dir,
            SessionHistoryBackend::new(db_path),
            workspace,
            current_id.to_string(),
        )
    }

    #[test]
    fn list_is_fenced_and_newest_first() {
        let (_dir, backend, workspace, current_id) = seeded();
        let sessions = backend.list(&workspace, 100);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, current_id);
        assert_eq!(sessions[0].title, "Current work");
        assert_eq!(sessions[0].message_count, 2);
        assert_eq!(sessions[1].title, "Past session");
        assert_eq!(sessions[1].message_count, 1);

        let foreign = backend.list(&_dir.path().join("other"), 100);
        assert!(foreign.is_empty());
    }

    #[test]
    fn read_pages_visible_roles_in_order() {
        let (_dir, backend, workspace, current_id) = seeded();
        let page = backend
            .read(&workspace, &current_id, None, 100)
            .expect("the seeded session reads");
        assert_eq!(page.title, "Current work");
        assert_eq!(page.total_messages, 2);
        assert_eq!(page.messages.len(), 2);
        assert_eq!(page.messages[0].role, "user");
        assert_eq!(page.messages[0].content, "why does login loop?");
        assert_eq!(page.messages[1].role, "assistant");
        assert!(page.messages[0].position < page.messages[1].position);

        // The cursor continues after the last position.
        let tail = backend
            .read(
                &workspace,
                &current_id,
                Some(page.messages[1].position),
                100,
            )
            .expect("the seeded session reads");
        assert!(tail.messages.is_empty());

        // A foreign workspace resolves the same as an unknown id.
        assert!(
            backend
                .read(&_dir.path().join("other"), &current_id, None, 100)
                .is_none()
        );
        assert!(
            backend
                .read(
                    &workspace,
                    "00000000-0000-0000-0000-000000000000",
                    None,
                    100
                )
                .is_none()
        );
    }

    /// Projectless sessions are their own workspace: the project row and
    /// the session cwd are both the home directory, so the fence matches
    /// by construction (boot migration repoints legacy rows before the
    /// reader installs).
    #[test]
    fn projectless_sessions_share_the_home_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("app.db");
        let store = StateStore::new(db_path.clone());
        let home = dir.path().join("home");
        let mut state = PersistedState::fresh(dir.path().join("repo"));

        let mut projectless = state.projects[0].clone();
        projectless.id = Uuid::new_v4();
        projectless.path = home.clone();
        let projectless_id = projectless.id;
        state.projects.push(projectless);

        let mut session = state.new_session(projectless_id, ProviderKind::Tide);
        session.auto_title = Some("No-project chat".into());
        session.messages = vec![Message::new(MessageRole::User, "floating question")];
        let session_id = session.id;
        state.push_session(session);
        state.mark_session_dirty(session_id);
        store.save(&mut state).unwrap();

        let backend = SessionHistoryBackend::new(db_path);
        let sessions = backend.list(&home, 100);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "No-project chat");
        let page = backend
            .read(&home, &session_id.to_string(), None, 100)
            .expect("the projectless session reads");
        assert_eq!(page.messages[0].content, "floating question");

        // And the fence holds both ways: the ordinary workspace never
        // lists projectless history.
        assert!(backend.list(&dir.path().join("repo"), 100).is_empty());
    }

    /// The end-to-end contract the orchestrator exercises: the shared slot
    /// installed, the tools run against the seeded db.
    #[test]
    fn tools_read_through_the_shared_slot() {
        let (_dir, backend, workspace, current_id) = seeded();
        set_shared_session_reader(Some(Arc::new(backend)));
        let ctx = ToolContext {
            session_id: current_id.clone(),
            workspace_root: workspace.clone(),
            ..ToolContext::new(&workspace)
        };

        let listed = ListSessionsTool
            .execute(&ctx, serde_json::json!({}))
            .unwrap();
        assert_eq!(listed.status, tools::OutcomeStatus::Executed);
        assert!(listed.output.contains("\"Current work\""));
        assert!(listed.output.contains("(this session)"));
        assert!(listed.output.contains("\"Past session\""));

        let read = ReadSessionTool
            .execute(
                &ctx,
                serde_json::json!({"session_id": current_id, "limit": 1}),
            )
            .unwrap();
        assert!(read.output.contains("why does login loop?"));
        assert!(
            read.output
                .contains("More messages may remain — continue with cursor: \"0\".")
        );

        set_shared_session_reader(None);
    }
}
