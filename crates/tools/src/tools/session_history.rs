//! Session history — read-only access to this workspace's saved chat
//! sessions, so the orchestrator can recover context a past conversation
//! established (what was tried, what was decided, what a session concluded).
//!
//! The store lives behind the [`SessionReader`] seam, the
//! [`crate::tools::memory`] pattern: the daemon installs one process-wide
//! backend over the app db at boot; the tools consult it at execute time
//! and degrade to an actionable hint when none is wired (tools-only
//! binaries, tests). Reads are fenced to the session's workspace root —
//! sessions of other projects are invisible, and an id from another
//! workspace reports the same unknown copy as one that never existed.

use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

pub const LIST_SESSIONS_NAME: &str = "list_sessions";
pub const READ_SESSION_NAME: &str = "read_session";

const LIST_DESCRIPTION: &str = "List this workspace's saved chat sessions — id, title, model, message count, and last-updated age, newest first. Use it to find a past conversation whose context would help the current task; the current session is marked. Follow with read_session to page through a session's messages.";

const READ_DESCRIPTION: &str = "Read one saved session's conversation from this workspace — user and assistant messages in conversation order (oldest first), paged by cursor. Use after list_sessions to recover what a past session established. Tool and system traffic is omitted; long messages are truncated. Returns the next cursor when more messages remain.";

const SESSION_ID_DESCRIPTION: &str = "The session id from list_sessions.";
const CURSOR_DESCRIPTION: &str = "The cursor returned by a previous read_session call, to read the next page. Omit to read from the beginning of the session.";

const LIST_DEFAULT_LIMIT: usize = 20;
const LIST_MAX_LIMIT: usize = 100;
const READ_DEFAULT_LIMIT: usize = 30;
const READ_MAX_LIMIT: usize = 100;
/// Per-message truncation cap — the memory tool's BODY_CAP parity: keeps a
/// single huge paste from flooding the model's context.
const MESSAGE_CHAR_CAP: usize = 1500;
/// Whole-page cap — once rendered output reaches this, the page stops and
/// the cursor continues from the first omitted message.
const TOTAL_CHAR_CAP: usize = 24_000;

/// One session-list row.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionSummary {
    pub id: String,
    /// The display title (explicit or provider-generated).
    pub title: String,
    /// Last mutation, unix seconds.
    pub updated_at: u64,
    /// The provider model the session ran, when recorded.
    pub model: Option<String>,
    /// Saved user+assistant messages.
    pub message_count: usize,
}

/// One conversation message of a page.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionMessage {
    /// Ordinal within the session, conversation order.
    pub position: i64,
    /// `user` or `assistant`.
    pub role: String,
    pub content: String,
}

/// One page of a session's messages.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionPage {
    pub title: String,
    /// Total user+assistant messages in the session (not just this page).
    pub total_messages: usize,
    pub messages: Vec<SessionMessage>,
}

/// The session-history backend the tools consult — the seam the daemon
/// fills in over the app db. Reads are fenced to `workspace_root`: list
/// returns only that workspace's sessions, and read resolves `None` for
/// ids belonging to any other workspace (the same unknown copy as a
/// never-existing id, so foreign ids never probe).
pub trait SessionReader: std::fmt::Debug + Send + Sync {
    /// The workspace's sessions, newest first, at most `limit`.
    fn list(&self, workspace_root: &Path, limit: usize) -> Vec<SessionSummary>;
    /// One page of a session's user+assistant messages in conversation
    /// order, starting just after `after_position` (beginning when
    /// `None`), at most `limit`. `None` when the id is unknown or belongs
    /// to another workspace.
    fn read(
        &self,
        workspace_root: &Path,
        session_id: &str,
        after_position: Option<i64>,
        limit: usize,
    ) -> Option<SessionPage>;
}

static SHARED_READER: std::sync::RwLock<Option<Arc<dyn SessionReader>>> =
    std::sync::RwLock::new(None);

/// Install (or clear) the process-wide session-history backend.
pub fn set_shared_session_reader(reader: Option<Arc<dyn SessionReader>>) {
    let mut slot = SHARED_READER.write().expect("session reader slot poisoned");
    *slot = reader;
}

/// The installed backend, if any.
pub fn shared_session_reader() -> Option<Arc<dyn SessionReader>> {
    SHARED_READER
        .read()
        .expect("session reader slot poisoned")
        .clone()
}

/// Coarse relative age for the list line — dependency-free (no chrono in
/// this crate), honest to the minute/hour/day the sidebar sorts by.
fn relative_age(updated_at: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let age = now.saturating_sub(updated_at);
    match age {
        0..=59 => "just now".into(),
        60..=3_599 => format!("{}m ago", age / 60),
        3_600..=86_399 => format!("{}h ago", age / 3_600),
        86_400..=2_591_999 => format!("{}d ago", age / 86_400),
        _ => format!("{}w ago", age / 604_800),
    }
}

fn truncate_chars(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        text.to_owned()
    } else {
        let mut cut: String = text.chars().take(cap).collect();
        cut.push_str("\n…[truncated]");
        cut
    }
}

/// `list_sessions` body — testable without the trait object wrapper.
pub(crate) fn run_list_sessions(
    current_session_id: &str,
    workspace_root: &Path,
    limit: Option<u64>,
    reader: Option<&dyn SessionReader>,
) -> ToolOutcome {
    let Some(reader) = reader else {
        return ToolOutcome::executed(
            "Session history is not available here (no session store wired).",
        );
    };
    let limit = limit
        .unwrap_or(LIST_DEFAULT_LIMIT as u64)
        .clamp(1, LIST_MAX_LIMIT as u64) as usize;
    let sessions = reader.list(workspace_root, limit);
    if sessions.is_empty() {
        return ToolOutcome::executed("No saved sessions for this workspace yet.");
    }
    let mut output = String::from("Saved sessions for this workspace (newest first):");
    for session in &sessions {
        let model = session
            .model
            .as_deref()
            .map(|model| format!(" · {model}"))
            .unwrap_or_default();
        let current = if session.id == current_session_id {
            " · (this session)"
        } else {
            ""
        };
        let mut title = session.title.clone();
        if title.chars().count() > 120 {
            title = title.chars().take(120).collect();
            title.push('…');
        }
        output.push_str(&format!(
            "\n- {} · {} · {} message{} · \"{}\"{}{}",
            session.id,
            relative_age(session.updated_at),
            session.message_count,
            if session.message_count == 1 { "" } else { "s" },
            title,
            model,
            current,
        ));
    }
    ToolOutcome::executed(output).with_meta(format!("{} session(s)", sessions.len()))
}

fn unknown_session(session_id: &str) -> String {
    format!(
        "Unknown session id: {session_id}. It may not exist, or belong to another workspace. Use list_sessions to see this workspace's sessions."
    )
}

/// `read_session` body — testable without the trait object wrapper. The
/// cursor is the opaque position of the last returned message; `None`
/// reads from the beginning.
pub(crate) fn run_read_session(
    workspace_root: &Path,
    session_id: &str,
    cursor: Option<&str>,
    limit: Option<u64>,
    reader: Option<&dyn SessionReader>,
) -> ToolOutcome {
    if session_id.is_empty() {
        return ToolOutcome::failed("Missing required arg: session_id");
    }
    let after_position = match cursor {
        None | Some("") => None,
        Some(raw) => match raw.parse::<i64>() {
            Ok(position) => Some(position),
            Err(_) => {
                return ToolOutcome::failed(format!(
                    "Invalid cursor: \"{raw}\" — pass the cursor returned by a previous read_session call, or omit it."
                ));
            }
        },
    };
    let Some(reader) = reader else {
        return ToolOutcome::executed(
            "Session history is not available here (no session store wired).",
        );
    };
    let limit = limit
        .unwrap_or(READ_DEFAULT_LIMIT as u64)
        .clamp(1, READ_MAX_LIMIT as u64) as usize;
    let Some(page) = reader.read(workspace_root, session_id, after_position, limit) else {
        return ToolOutcome::failed(unknown_session(session_id));
    };
    if page.messages.is_empty() {
        return ToolOutcome::executed(if after_position.is_some() {
            "No more messages in this session.".to_owned()
        } else {
            "Session has no saved messages.".to_owned()
        });
    }

    let first = page.messages.first().map(|m| m.position).unwrap_or(0);
    let mut body = String::new();
    let mut next_cursor: Option<i64> = None;
    let mut last_position: Option<i64> = None;
    let mut included = 0usize;
    for message in &page.messages {
        let line = format!(
            "[{}] {}: {}",
            message.position,
            message.role,
            truncate_chars(&message.content, MESSAGE_CHAR_CAP)
        );
        if !body.is_empty() && body.chars().count() + line.chars().count() > TOTAL_CHAR_CAP {
            // The page budget ran out before this message — continue from
            // the last included one.
            next_cursor = last_position;
            break;
        }
        body.push_str(&line);
        body.push_str("\n\n");
        last_position = Some(message.position);
        included += 1;
    }
    // A full page (the reader honored the limit) means more may remain;
    // a follow-up on an exhausted tail reports "no more messages".
    if next_cursor.is_none() && page.messages.len() == limit {
        next_cursor = last_position;
    }

    let last = last_position.unwrap_or(first);
    let mut output = format!(
        "Session \"{}\" — messages {}–{} of {} (oldest first)\n\n{}",
        page.title,
        first,
        last,
        page.total_messages,
        body.trim_end(),
    );
    if let Some(cursor) = next_cursor {
        output.push_str(&format!(
            "\n\nMore messages may remain — continue with cursor: \"{cursor}\"."
        ));
    }
    ToolOutcome::executed(output).with_meta(format!(
        "{} of {} message(s)",
        included, page.total_messages
    ))
}

pub struct ListSessionsTool;

pub struct ReadSessionTool;

impl Tool for ListSessionsTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: LIST_SESSIONS_NAME.into(),
            description: LIST_DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "number",
                        "description": "Maximum sessions to return. Default 20, max 100."
                    }
                }
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        Ok(run_list_sessions(
            &ctx.session_id,
            &ctx.workspace_root,
            super::arg_u64(&args, "limit"),
            shared_session_reader().as_deref(),
        ))
    }
}

impl Tool for ReadSessionTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: READ_SESSION_NAME.into(),
            description: READ_DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": SESSION_ID_DESCRIPTION
                    },
                    "cursor": {
                        "type": "string",
                        "description": CURSOR_DESCRIPTION
                    },
                    "limit": {
                        "type": "number",
                        "description": "Maximum messages to return per page. Default 30, max 100."
                    }
                },
                "required": ["session_id"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        let cursor = super::arg_str(&args, "cursor");
        let cursor = if cursor.is_empty() {
            None
        } else {
            Some(cursor.as_str())
        };
        Ok(run_read_session(
            &ctx.workspace_root,
            &arg_str(&args, "session_id"),
            cursor,
            super::arg_u64(&args, "limit"),
            shared_session_reader().as_deref(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    #[derive(Debug, Default)]
    struct FakeReader {
        sessions: Vec<SessionSummary>,
        // (session_id -> messages in order)
        messages: Vec<(String, Vec<SessionMessage>)>,
        last_list_limit: std::sync::atomic::AtomicUsize,
    }

    impl FakeReader {
        fn session(&self, id: &str) -> Option<&Vec<SessionMessage>> {
            self.messages
                .iter()
                .find(|(sid, _)| sid == id)
                .map(|(_, msgs)| msgs)
        }
    }

    impl SessionReader for FakeReader {
        fn list(&self, _workspace_root: &Path, limit: usize) -> Vec<SessionSummary> {
            self.last_list_limit
                .store(limit, std::sync::atomic::Ordering::SeqCst);
            self.sessions.iter().take(limit).cloned().collect()
        }

        fn read(
            &self,
            _workspace_root: &Path,
            session_id: &str,
            after_position: Option<i64>,
            limit: usize,
        ) -> Option<SessionPage> {
            let messages = self.session(session_id)?;
            let filtered: Vec<SessionMessage> = messages
                .iter()
                .filter(|m| after_position.is_none_or(|after| m.position > after))
                .take(limit)
                .cloned()
                .collect();
            Some(SessionPage {
                title: self
                    .sessions
                    .iter()
                    .find(|s| s.id == session_id)
                    .map(|s| s.title.clone())
                    .unwrap_or_else(|| "Untitled".into()),
                total_messages: messages.len(),
                messages: filtered,
            })
        }
    }

    fn summary(id: &str, title: impl Into<String>, updated_at: u64) -> SessionSummary {
        SessionSummary {
            id: id.into(),
            title: title.into(),
            updated_at,
            model: Some("glm-5.3".into()),
            message_count: 12,
        }
    }

    fn message(position: i64, role: &str, content: &str) -> SessionMessage {
        SessionMessage {
            position,
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn specs_and_tiers() {
        let list = ListSessionsTool;
        assert_eq!(list.spec().name, "list_sessions");
        assert_eq!(list.risk_tier(), RiskTier::ReadOnly);
        let read = ReadSessionTool;
        assert_eq!(read.spec().name, "read_session");
        assert_eq!(read.risk_tier(), RiskTier::ReadOnly);
    }

    #[test]
    fn no_reader_degrades_to_hint() {
        let out = run_list_sessions("s1", Path::new("/ws"), None, None);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("Session history is not available"));
        let out = run_read_session(Path::new("/ws"), "s1", None, None, None);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("Session history is not available"));
    }

    #[test]
    fn missing_and_invalid_args_fail() {
        let reader = FakeReader::default();
        let out = run_read_session(Path::new("/ws"), "", None, None, Some(&reader));
        assert_eq!(out.output, "Missing required arg: session_id");
        let out = run_read_session(
            Path::new("/ws"),
            "s1",
            Some("not-a-cursor"),
            None,
            Some(&reader),
        );
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.starts_with("Invalid cursor:"), "{}", out.output);
    }

    #[test]
    fn unknown_session_reports_the_unknown_copy() {
        let reader = FakeReader::default();
        let out = run_read_session(Path::new("/ws"), "nope", None, None, Some(&reader));
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.starts_with("Unknown session id: nope."), "{}", out.output);
        assert!(out.output.contains("list_sessions"));
    }

    #[test]
    fn list_formats_marks_current_and_clamps_limit() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let reader = FakeReader {
            sessions: vec![
                summary("s1", "Fix the login loop", now - 300),
                summary("s2", "A very long title ".repeat(20), now - 7_000),
            ],
            ..FakeReader::default()
        };
        let out = run_list_sessions("s1", Path::new("/ws"), None, Some(&reader));
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("- s1 · 5m ago · 12 messages · \"Fix the login loop\" · glm-5.3 · (this session)"));
        assert!(out.output.contains("(this session)"));
        assert!(out.output.contains("…"));
        assert_eq!(out.meta.unwrap(), "2 session(s)");
        assert_eq!(
            reader
                .last_list_limit
                .load(std::sync::atomic::Ordering::SeqCst),
            LIST_DEFAULT_LIMIT
        );

        let out = run_list_sessions("s9", Path::new("/ws"), Some(1), Some(&reader));
        assert!(out.output.contains("- s1 ·"));
        assert!(!out.output.contains("- s2 ·"));
        assert_eq!(
            reader
                .last_list_limit
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[test]
    fn empty_list_reports_no_sessions() {
        let reader = FakeReader::default();
        let out = run_list_sessions("s1", Path::new("/ws"), None, Some(&reader));
        assert_eq!(out.output, "No saved sessions for this workspace yet.");
    }

    #[test]
    fn read_renders_page_in_order_and_mints_cursor_on_full_page() {
        let reader = FakeReader {
            sessions: vec![summary("s1", "Auth refactor", 100)],
            messages: vec![(
                "s1".into(),
                vec![
                    message(1, "user", "why does login loop?"),
                    message(2, "assistant", "the retry has no backoff"),
                    message(3, "user", "fix it"),
                ],
            )],
            ..FakeReader::default()
        };
        let out = run_read_session(Path::new("/ws"), "s1", None, Some(2), Some(&reader));
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out
            .output
            .starts_with("Session \"Auth refactor\" — messages 1–2 of 3 (oldest first)"));
        assert!(out.output.contains("[1] user: why does login loop?"));
        assert!(out.output.contains("[2] assistant: the retry has no backoff"));
        assert!(!out.output.contains("[3]"));
        assert!(out
            .output
            .contains("More messages may remain — continue with cursor: \"2\"."));

        // Following the cursor lands the tail; an exhausted page says so.
        let out = run_read_session(Path::new("/ws"), "s1", Some("2"), Some(2), Some(&reader));
        assert!(out.output.contains("[3] user: fix it"));
        assert!(!out.output.contains("More messages may remain"));
        let out = run_read_session(Path::new("/ws"), "s1", Some("3"), Some(2), Some(&reader));
        assert_eq!(out.output, "No more messages in this session.");
    }

    #[test]
    fn read_truncates_long_messages() {
        let long = "x".repeat(3_000);
        let reader = FakeReader {
            sessions: vec![summary("s1", "Big paste", 1)],
            messages: vec![("s1".into(), vec![message(1, "user", &long)])],
            ..FakeReader::default()
        };
        let out = run_read_session(Path::new("/ws"), "s1", None, None, Some(&reader));
        assert!(out.output.contains("…[truncated]"));
        let body = out.output.lines().nth(2).unwrap();
        assert!(body.chars().count() < MESSAGE_CHAR_CAP + 20);
    }

    #[test]
    fn read_total_cap_stops_mid_page_and_continues() {
        let mut messages = Vec::new();
        for i in 1..=40 {
            messages.push(message(i, "assistant", &"y".repeat(1_000)));
        }
        let reader = FakeReader {
            sessions: vec![summary("s1", "Long session", 1)],
            messages: vec![("s1".into(), messages)],
            ..FakeReader::default()
        };
        let out = run_read_session(Path::new("/ws"), "s1", None, Some(100), Some(&reader));
        assert!(out.output.contains("continue with cursor:"));
        assert!(out.output.contains("y"));
        // The continuation cursor moves the page forward.
        let cursor = out
            .output
            .split("cursor: \"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap()
            .to_owned();
        let out = run_read_session(
            Path::new("/ws"),
            "s1",
            Some(&cursor),
            Some(100),
            Some(&reader),
        );
        assert!(out.output.contains(&format!("[{}]", cursor.parse::<i64>().unwrap() + 1)));
    }

    #[test]
    fn empty_session_reports_no_messages() {
        let reader = FakeReader {
            sessions: vec![summary("s1", "Empty", 1)],
            messages: vec![("s1".into(), vec![])],
            ..FakeReader::default()
        };
        let out = run_read_session(Path::new("/ws"), "s1", None, None, Some(&reader));
        assert_eq!(out.output, "Session has no saved messages.");
    }
}
