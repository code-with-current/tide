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
    let headers = inner_list_headers(state, workspace_id)?;
    #[cfg(debug_assertions)]
    eprintln!("[tide] session_list workspace={workspace_id} -> {} sessions", headers.len());
    Ok(headers)
}

fn inner_list_headers(state: &AppState, workspace_id: &str) -> Result<Vec<SessionHeaderWire>, CommandError> {
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


// ── M4 T2: session management (legacy-shaped, v2-backed) ───────────────────
//
// Port of `app/rpc/sessions.ts` @ 91ec558 minus the dual-track legacy store:
// sessions-v2 is the only store, so every legacy-shaped response is DERIVED
// from v2 rows (the M1 `sessionList` pattern) and every legacy mutation maps
// onto the writer. Mapping decisions per method:
//
// - `sessionGet`/`sessionFork` — `HydratedSession` derived from the v2 row +
//   message/part walk (text parts → `content`, thinking parts → `reasoning`).
//   `lastTurnUsage`/`forkedFrom`/per-message `blocks`/`toolCalls` have no v2
//   home and are omitted (all TS-optional).
// - `sessionUpdateSettings` — the TS stored autonomy/thinking on the legacy
//   JSON row; here they land in the additive `session_settings` side table
//   (the `session_todos` precedent) and `sessionGet` reads them back.
// - `sessionAddMessage` — role `user` is a documented no-op: under the Tauri
//   shell `chat_run_turn`'s `persist_user_message` owns the user twin (one
//   writer per message — a write here would double every bubble). Assistant/
//   system roles (mock-path + utility callers) do the real twin write. The
//   TS `extra` attachments/mentions were legacy-only fields — dropped.
// - `sessionAddUsage` — no-op: the turn's `message.end` already rolls usage
//   into the session columns; a second write would double-count. (The TS
//   needed it because the legacy JSON store was written by the renderer.)
// - `sessionAddAssistantMessage`/`sessionFinalizeAssistantMessage` — real v2
//   writes (thinking+text parts; finalize upserts the text part of the
//   streamed message by id, so it is idempotent against the sink's own
//   commits).
// - Worktrees — the TS stored `worktree` on the legacy JSON row; here the
//   additive `session_worktree` side table (same precedent), driven by the
//   git2 port in `commands/worktree.rs`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tide_engine::{EngineEvent, HistoryMessage, ThinkingLevel, TurnParams, TurnRequest};
use tide_store::config::StoredProvider;
use tide_store::sessions_v2::SessionMessageV2;
use tide_store::sessions_v2_write::{
    new_part_id, new_session_id, InsertMessageInput, InsertPartInput, SessionPatch,
    SessionsV2Writer,
};

use crate::agent::hub::{ChatHub, ChatHubCell};
use crate::agent::orchestrator::{RigStepStream, StepStream};
use crate::agent::sink::{iso_ms, unix_ms_now};

use super::worktree::{self, SessionWorktreeWire};

/// `StoredSessionMessage` (the legacy message shape inside `HydratedSession`)
/// — derived: content from text parts, reasoning from thinking parts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessageWire {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

/// `HydratedSession` in shared/rpc.ts — the persisted session plus UI
/// defaults. `usage` keeps the TS field set (cacheWrite/calls have no v2
/// column and read 0).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedSessionWire {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub messages: Vec<StoredMessageWire>,
    pub created_at: String,
    pub updated_at: String,
    pub autonomy_mode: String,
    pub thinking_level: String,
    pub status: &'static str,
    pub usage: Value,
    pub cost_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

impl HydratedSessionWire {
    fn zero_usage() -> Value {
        serde_json::json!({
            "inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0,
            "reasoningTokens": 0, "calls": 0, "costUsd": 0.0,
        })
    }
}

/// `SessionSettingsPatch` params (`autonomyMode`/`thinkingLevel`, both
/// optional; absent keys keep their stored value like the TS assignment).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettingsPatchWire {
    pub autonomy_mode: Option<String>,
    pub thinking_level: Option<String>,
}

/// `SessionCreateOpts` as forked (model is NOT in it — forking is the model
/// change).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkOptsWire {
    pub autonomy_mode: Option<String>,
    pub thinking_level: Option<String>,
    pub provider_id: Option<String>,
}

/// `SessionMessageExtra` params — accepted for wire compatibility, contents
/// dropped (attachments/mentions were legacy-JSON message fields).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessageExtraWire {
    #[allow(dead_code)]
    pub attachments: Option<Vec<Value>>,
    #[allow(dead_code)]
    pub mentions: Option<Vec<Value>>,
}

/// `AssistantMessageInput` / `FinalizeAssistantMessageInput` — `content` and
/// `reasoning` map to v2 parts; blocks/toolCalls/timeline/turn/usage metadata
/// were legacy-JSON fields with no v2 home.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessageInputWire {
    pub content: String,
    pub reasoning: Option<String>,
}

/// `sessionGenerateTitle` response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitleResultWire {
    pub title: Option<String>,
}

/// `sessionClearAll` response.
#[derive(Debug, Clone, Serialize)]
pub struct SessionClearAllWire {
    pub ok: bool,
}

/// `sessionCreateWorktree` params' `opts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateOptsWire {
    pub branch_name: String,
    pub base_branch: String,
    pub config_files: Option<Vec<String>>,
}

// ── sessionGet ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn session_get(
    state: tauri::State<AppState>,
    session_id: String,
) -> Result<Option<HydratedSessionWire>, CommandError> {
    get_session(&state, &session_id)
}

fn get_session(state: &AppState, session_id: &str) -> Result<Option<HydratedSessionWire>, CommandError> {
    let Some(store) = open_store(state)? else {
        return Ok(None);
    };
    let Some(meta) = store.session_meta_by_id(session_id)? else {
        return Ok(None);
    };
    let messages = stored_messages_of(&store, session_id)?;
    let (autonomy, thinking) = store
        .session_settings_of(session_id)?
        .unwrap_or((None, None));
    let worktree = store.session_worktree_of(session_id)?;
    let workspace_id = workspace_id_of_path(state, &meta.workspace_path);
    Ok(Some(HydratedSessionWire {
        id: meta.id,
        workspace_id,
        title: meta.title,
        model_id: meta.model_id.unwrap_or_default(),
        provider_id: meta.provider_id,
        messages,
        created_at: iso_ms(meta.time_created),
        updated_at: iso_ms(meta.time_updated),
        autonomy_mode: autonomy.unwrap_or_else(|| "ask".into()),
        thinking_level: thinking.unwrap_or_else(|| "medium".into()),
        status: "idle",
        usage: serde_json::json!({
            "inputTokens": meta.tokens_input,
            "outputTokens": meta.tokens_output,
            "cacheRead": meta.tokens_cache_read,
            "cacheWrite": 0,
            "reasoningTokens": meta.tokens_reasoning,
            "calls": 0,
            "costUsd": meta.cost,
        }),
        cost_usd: meta.cost,
        worktree,
        archived_at: meta.archived_at.map(iso_ms),
        kind: meta.parent_id.as_ref().map(|_| "subagent".to_owned()),
        parent_id: meta.parent_id,
    }))
}

/// The legacy `messages` array: every message oldest-first with text parts →
/// `content` and thinking parts → `reasoning`. The 200-message window pages
/// backward until exhausted.
fn stored_messages_of(
    store: &SessionsV2,
    session_id: &str,
) -> Result<Vec<StoredMessageWire>, CommandError> {
    let mut pages: Vec<Vec<SessionMessageV2>> = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let page = store.session_messages(
            session_id,
            SessionWindowOptsV2 { limit: Some(200), before },
        )?;
        let next = page.next_before.clone();
        pages.push(page.messages);
        before = next;
        if before.is_none() || pages.len() > 500 {
            break;
        }
    }
    pages.reverse();
    Ok(pages
        .into_iter()
        .flatten()
        .map(|message| StoredMessageWire {
            created_at: iso_ms(message.time_created),
            content: concat_parts(&message, "text"),
            reasoning: some_if_non_empty(&concat_parts(&message, "thinking")),
            id: message.id,
            role: message.role,
        })
        .collect())
}

fn concat_parts(message: &SessionMessageV2, kind: &str) -> String {
    message
        .parts
        .iter()
        .filter(|part| part.kind == kind)
        .map(|part| {
            part.data
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
        })
        .collect()
}

fn some_if_non_empty(text: &str) -> Option<String> {
    (!text.trim().is_empty()).then(|| text.to_owned())
}

/// Reverse-map a v2 workspace_path onto the config workspace id. Unmatched
/// paths (workspace removed) fall back to the raw path — the TS headers
/// always carried their stored id; an empty string would read as a wrong id.
fn workspace_id_of_path(state: &AppState, workspace_path: &str) -> String {
    state
        .read_config(|cfg| {
            cfg.workspaces
                .iter()
                .find(|ws| ws.path == workspace_path)
                .map(|ws| ws.id.clone())
        })
        .ok()
        .flatten()
        .unwrap_or_else(|| workspace_path.to_owned())
}

// ── rename / archive / unarchive / delete / clearAll ────────────────────────

#[tauri::command]
pub async fn session_rename(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
    title: String,
) -> Result<(), CommandError> {
    let hub = hub(hub_cell, &state).await?;
    rename_session(&hub, &session_id, &title)
}

fn rename_session(hub: &Arc<ChatHub>, session_id: &str, title: &str) -> Result<(), CommandError> {
    with_writer(hub, |writer| {
        // Unknown ids match zero rows — the TS silent no-op.
        writer.update_session(
            session_id,
            SessionPatch { title: Some(title), ..Default::default() },
            unix_ms_now(),
        )
    })
}

#[tauri::command]
pub async fn session_archive(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
) -> Result<(), CommandError> {
    let hub = hub(hub_cell, &state).await?;
    archive_session(&hub, &session_id)
}

fn archive_session(hub: &Arc<ChatHub>, session_id: &str) -> Result<(), CommandError> {
    with_writer(hub, |writer| writer.archive_session(session_id, unix_ms_now()))
}

#[tauri::command]
pub async fn session_unarchive(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
) -> Result<(), CommandError> {
    let hub = hub(hub_cell, &state).await?;
    unarchive_session(&hub, &session_id)
}

fn unarchive_session(hub: &Arc<ChatHub>, session_id: &str) -> Result<(), CommandError> {
    with_writer(hub, |writer| writer.unarchive_session(session_id))
}

#[tauri::command]
pub async fn session_delete(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
) -> Result<(), CommandError> {
    let hub = hub(hub_cell, &state).await?;
    delete_session(&hub, &session_id)
}

fn delete_session(hub: &Arc<ChatHub>, session_id: &str) -> Result<(), CommandError> {
    let archived = {
        let writer = hub.writer().lock().expect("sink writer poisoned");
        writer.session_archived(session_id)
    };
    match archived {
        // Unknown id — silent no-op (matches the TS store).
        None => Ok(()),
        // Two-step flow: archive first, then delete.
        Some(false) => Err(CommandError::with_code(
            "Session must be archived before deletion",
            "SESSION_NOT_ARCHIVED",
        )),
        Some(true) => {
            cascade_worktree(hub, session_id);
            with_writer(hub, |writer| writer.delete_session(session_id))?;
            // Real session end: deny any pending asks (the TS also cleared
            // permission rules + aborted the session — best-effort there too).
            hub.abort_turn(session_id);
            Ok(())
        }
    }
}

/// The legacy delete hook: a session with a worktree loses the worktree dir +
/// branch before its rows go (orphaning `.agent/worktrees/<branch>`).
fn cascade_worktree(hub: &Arc<ChatHub>, session_id: &str) {
    let writer = hub.writer().lock().expect("sink writer poisoned");
    let Some(worktree) = writer.session_worktree(session_id) else {
        return;
    };
    let Some(root) = writer.session_workspace_path(session_id) else {
        return;
    };
    let Some(branch) = worktree.get("branch").and_then(Value::as_str) else {
        return;
    };
    worktree::worktree_remove(std::path::Path::new(&root), branch);
}

#[tauri::command]
pub async fn session_clear_all(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
) -> Result<SessionClearAllWire, CommandError> {
    let hub = hub(hub_cell, &state).await?;
    // TS abortAllSessions() before the wipe.
    hub.abort_all();
    with_writer(&hub, |writer| writer.clear_all())?;
    Ok(SessionClearAllWire { ok: true })
}

// ── updateSettings ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_update_settings(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
    patch: SessionSettingsPatchWire,
) -> Result<(), CommandError> {
    let hub = hub(hub_cell, &state).await?;
    update_session_settings(&hub, &session_id, &patch)
}

fn update_session_settings(
    hub: &Arc<ChatHub>,
    session_id: &str,
    patch: &SessionSettingsPatchWire,
) -> Result<(), CommandError> {
    with_writer(hub, |writer| {
        // Ghost sessions no-op like the TS (no side-table row for a missing
        // session).
        if writer.session_workspace_path(session_id).is_none() {
            return Ok(());
        }
        writer.set_session_settings(
            session_id,
            patch.autonomy_mode.as_deref(),
            patch.thinking_level.as_deref(),
            unix_ms_now(),
        )?;
        // The TS bumped the session's updatedAt (sidebar re-sort on settings
        // change) — the empty SessionPatch is exactly the touch.
        writer.update_session(session_id, SessionPatch::default(), unix_ms_now())
    })
}

// ── listDispatches ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn session_list_dispatches(
    state: tauri::State<AppState>,
    parent_id: String,
) -> Result<Vec<SessionHeaderWire>, CommandError> {
    list_dispatches(&state, &parent_id)
}

fn list_dispatches(
    state: &AppState,
    parent_id: &str,
) -> Result<Vec<SessionHeaderWire>, CommandError> {
    let Some(store) = open_store(state)? else {
        return Ok(Vec::new());
    };
    let stamp = store
        .session_meta_by_id(parent_id)?
        .map(|meta| workspace_id_of_path(state, &meta.workspace_path))
        .unwrap_or_default();
    store
        .list_dispatch_headers(parent_id, &stamp)
        .map_err(CommandError::from)
}

// ── addMessage / assistant trio ─────────────────────────────────────────────

#[tauri::command]
pub async fn session_add_message(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
    role: String,
    content: String,
    extra: Option<SessionMessageExtraWire>,
) -> Result<(), CommandError> {
    let _ = extra;
    let hub = hub(hub_cell, &state).await?;
    add_message(&hub, &session_id, &role, &content)
}

fn add_message(hub: &Arc<ChatHub>, session_id: &str, role: &str, content: &str) -> Result<(), CommandError> {
    if role == "user" {
        // The Tauri orchestrator persists the turn's user message from the
        // chat_run_turn args — a twin here would duplicate every bubble.
        return Ok(());
    }
    with_writer(hub, |writer| {
        if writer.session_workspace_path(session_id).is_none() {
            return Ok(());
        }
        insert_text_message(writer, session_id, role, content)
    })
}

/// The `twinV2TextMessage` shape: message row + committed text part.
fn insert_text_message(
    writer: &SessionsV2Writer,
    session_id: &str,
    role: &str,
    content: &str,
) -> tide_store::sessions_v2::Result<()> {
    let (message_id, message_ms) = writer.next_message_slot();
    writer.insert_message(
        InsertMessageInput { id: &message_id, session_id, role, model: None },
        message_ms,
    )?;
    writer.insert_part(
        InsertPartInput {
            id: &new_part_id(),
            message_id: &message_id,
            session_id,
            seq: 0,
            kind: "text",
            data: &serde_json::json!({ "text": content }),
        },
        message_ms,
    )
}

#[tauri::command]
pub async fn session_add_assistant_message(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
    message: AssistantMessageInputWire,
) -> Result<(), CommandError> {
    let hub = hub(hub_cell, &state).await?;
    add_assistant_message(&hub, &session_id, &message)
}

fn add_assistant_message(
    hub: &Arc<ChatHub>,
    session_id: &str,
    message: &AssistantMessageInputWire,
) -> Result<(), CommandError> {
    with_writer(hub, |writer| {
        if writer.session_workspace_path(session_id).is_none() {
            return Ok(());
        }
        let (message_id, message_ms) = writer.next_message_slot();
        writer.insert_message(
            InsertMessageInput { id: &message_id, session_id, role: "assistant", model: None },
            message_ms,
        )?;
        let mut seq = 0;
        if let Some(reasoning) = message.reasoning.as_deref().filter(|r| !r.trim().is_empty()) {
            writer.insert_part(
                InsertPartInput {
                    id: &new_part_id(),
                    message_id: &message_id,
                    session_id,
                    seq,
                    kind: "thinking",
                    data: &serde_json::json!({ "text": reasoning }),
                },
                message_ms,
            )?;
            seq += 1;
        }
        writer.insert_part(
            InsertPartInput {
                id: &new_part_id(),
                message_id: &message_id,
                session_id,
                seq,
                kind: "text",
                data: &serde_json::json!({ "text": message.content }),
            },
            message_ms,
        )?;
        writer.complete_message(&message_id, message_ms)?;
        writer.update_session(session_id, SessionPatch::default(), unix_ms_now())
    })
}

#[tauri::command]
pub async fn session_finalize_assistant_message(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
    message_id: String,
    message: AssistantMessageInputWire,
) -> Result<(), CommandError> {
    let hub = hub(hub_cell, &state).await?;
    finalize_assistant_message(&hub, &session_id, &message_id, &message)
}

fn finalize_assistant_message(
    hub: &Arc<ChatHub>,
    session_id: &str,
    message_id: &str,
    message: &AssistantMessageInputWire,
) -> Result<(), CommandError> {
    with_writer(hub, |writer| {
        if writer.session_workspace_path(session_id).is_none() {
            return Ok(());
        }
        let now = unix_ms_now();
        if let Some(part_id) = writer.last_text_part_of(message_id) {
            // The streamed message exists (the turn created it) — update its
            // text part in place, never a second copy.
            writer.update_part_data(&part_id, &serde_json::json!({ "text": message.content }), now)?;
        } else {
            // No partial exists (a short turn that never flushed) — append
            // with the caller's message id, like the TS fallback.
            writer.insert_message(
                InsertMessageInput { id: message_id, session_id, role: "assistant", model: None },
                now,
            )?;
            writer.insert_part(
                InsertPartInput {
                    id: &new_part_id(),
                    message_id,
                    session_id,
                    seq: 0,
                    kind: "text",
                    data: &serde_json::json!({ "text": message.content }),
                },
                now,
            )?;
        }
        writer.complete_message(message_id, now)?;
        writer.update_session(session_id, SessionPatch::default(), now)
    })
}

#[tauri::command]
pub async fn session_add_usage(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
    delta: Option<Value>,
    last_step_usage: Option<Value>,
) -> Result<(), CommandError> {
    let _ = (state, hub_cell, session_id, delta, last_step_usage);
    // No-op: usage persistence moved into the turn — the sink's message.end
    // rolls the same numbers into the session columns, and a second write
    // here would double every counter. (The wire params stay accepted so
    // client.ts's fire-and-forget call keeps resolving.)
    Ok(())
}

// ── fork ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_fork(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    source_id: String,
    new_model_id: String,
    opts: Option<SessionForkOptsWire>,
) -> Result<HydratedSessionWire, CommandError> {
    let hub = hub(hub_cell, &state).await?;
    fork_session(&state, &hub, &source_id, &new_model_id, opts.unwrap_or_default())
}

fn fork_session(
    state: &AppState,
    hub: &Arc<ChatHub>,
    source_id: &str,
    new_model_id: &str,
    opts: SessionForkOptsWire,
) -> Result<HydratedSessionWire, CommandError> {
    let Some(store) = open_store(state)? else {
        return Err(CommandError::with_code(
            format!("forkSession: source session {source_id} not found"),
            "SESSION_NOT_FOUND",
        ));
    };
    let Some(meta) = store.session_meta_by_id(source_id)? else {
        return Err(CommandError::with_code(
            format!("forkSession: source session {source_id} not found"),
            "SESSION_NOT_FOUND",
        ));
    };
    // The fork seed: the source's last assistant message with non-empty text,
    // copied verbatim as the fork's first message.
    let last_result = store.last_assistant_text(source_id)?;
    let (source_autonomy, source_thinking) = store
        .session_settings_of(source_id)?
        .unwrap_or((None, None));
    drop(store);

    let fork_id = new_session_id();
    let now = unix_ms_now();
    let title = format!("Fork of {}", meta.title);
    let mut seed_message = None;
    let autonomy_of = opts
        .autonomy_mode
        .clone()
        .or(source_autonomy.clone())
        .unwrap_or_else(|| "ask".into());
    let thinking_of = opts
        .thinking_level
        .clone()
        .or(source_thinking.clone())
        .unwrap_or_else(|| "medium".into());
    with_writer(hub, |writer| {
        writer.create_session(
            tide_store::sessions_v2_write::CreateSessionInput {
                id: &fork_id,
                workspace_path: &meta.workspace_path,
                title: &title,
                model_id: new_model_id,
                provider_id: opts.provider_id.as_deref(),
                parent_id: None,
            },
            now,
        )?;
        if let Some(text) = last_result.as_deref() {
            let (message_id, message_ms) = writer.next_message_slot();
            writer.insert_message(
                InsertMessageInput {
                    id: &message_id,
                    session_id: &fork_id,
                    role: "assistant",
                    model: Some(new_model_id),
                },
                message_ms,
            )?;
            writer.insert_part(
                InsertPartInput {
                    id: &new_part_id(),
                    message_id: &message_id,
                    session_id: &fork_id,
                    seq: 0,
                    kind: "text",
                    data: &serde_json::json!({ "text": text }),
                },
                message_ms,
            )?;
            writer.complete_message(&message_id, message_ms)?;
            seed_message = Some(StoredMessageWire {
                id: message_id,
                role: "assistant".into(),
                content: text.to_owned(),
                created_at: iso_ms(message_ms),
                reasoning: None,
            });
        }
        // autonomy/thinking: opts → source → defaults (the TS chain).
        writer.set_session_settings(
            &fork_id,
            Some(autonomy_of.as_str()),
            Some(thinking_of.as_str()),
            now,
        )
    })?;

    Ok(HydratedSessionWire {
        id: fork_id,
        workspace_id: workspace_id_of_path(state, &meta.workspace_path),
        title,
        model_id: new_model_id.to_owned(),
        provider_id: opts.provider_id,
        messages: seed_message.into_iter().collect(),
        created_at: iso_ms(now),
        updated_at: iso_ms(now),
        autonomy_mode: autonomy_of,
        thinking_level: thinking_of,
        status: "idle",
        usage: HydratedSessionWire::zero_usage(),
        cost_usd: 0.0,
        worktree: None,
        archived_at: None,
        parent_id: None,
        kind: None,
    })
}

// ── worktree commands ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_create_worktree(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
    opts: WorktreeCreateOptsWire,
) -> Result<SessionWorktreeWire, CommandError> {
    let hub = hub(hub_cell, &state).await?;
    create_worktree_for_session(&state, &hub, &session_id, &opts)
}

fn create_worktree_for_session(
    state: &AppState,
    hub: &Arc<ChatHub>,
    session_id: &str,
    opts: &WorktreeCreateOptsWire,
) -> Result<SessionWorktreeWire, CommandError> {
    let (workspace_path, existing_location) = {
        let writer = hub.writer().lock().expect("sink writer poisoned");
        let Some(workspace_path) = writer.session_workspace_path(session_id) else {
            return Err(CommandError::with_code(
                format!("Session not found: {session_id}"),
                "SESSION_NOT_FOUND",
            ));
        };
        (workspace_path, writer.session_worktree(session_id))
    };
    if existing_location.is_some() {
        return Err(CommandError::with_code(
            "Session already has a worktree",
            "WORKTREE_EXISTS",
        ));
    }
    let location = state
        .read_config(|cfg| {
            cfg.workspaces
                .iter()
                .find(|ws| ws.path == workspace_path)
                .and_then(|ws| {
                    ws.extra
                        .get("worktreeLocation")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
        })?
        .unwrap_or_else(|| ".agent/worktrees/".to_owned());

    let wire = worktree::create_session_worktree(
        std::path::Path::new(&workspace_path),
        &location,
        &opts.branch_name,
        &opts.base_branch,
        opts.config_files.as_deref().unwrap_or(&[]),
    )?;
    let now = unix_ms_now();
    let stored = serde_json::to_value(&wire).expect("worktree wire serializes");
    with_writer(hub, |writer| {
        writer.set_session_worktree(session_id, Some(&stored), now)?;
        // TS setWorktree bumped the session's updatedAt.
        writer.update_session(session_id, SessionPatch::default(), now)
    })?;
    Ok(wire)
}

#[tauri::command]
pub async fn session_remove_worktree(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
) -> Result<(), CommandError> {
    let hub = hub(hub_cell, &state).await?;
    remove_worktree_for_session(&hub, &session_id)
}

fn remove_worktree_for_session(hub: &Arc<ChatHub>, session_id: &str) -> Result<(), CommandError> {
    let (worktree, workspace_path) = {
        let writer = hub.writer().lock().expect("sink writer poisoned");
        (writer.session_worktree(session_id), writer.session_workspace_path(session_id))
    };
    // Not worktree-enabled — idempotent no-op (the TS early return).
    let Some(worktree) = worktree else {
        return Ok(());
    };
    if let (Some(branch), Some(root)) = (
        worktree.get("branch").and_then(Value::as_str),
        workspace_path.as_deref(),
    ) {
        worktree::worktree_remove(std::path::Path::new(root), branch);
    }
    let now = unix_ms_now();
    with_writer(hub, |writer| {
        writer.set_session_worktree(session_id, None, now)?;
        writer.update_session(session_id, SessionPatch::default(), now)
    })
}

// ── generateTitle ───────────────────────────────────────────────────────────

/// The TS title prompt, verbatim (`app/core/agent/title.ts`).
const TITLE_SYSTEM: &str = "You are a session title generator for a coding workspace. Generate a concise 3-5 word title \
naming WHAT the session is about, not what was asked. \
Lead with the primary identifier: the function, file, feature, error, or system the work centers on. \
Use sentence case — capitalize only the first word and proper nouns (APIs, class names keep their casing). \
No request verbs (fix, add, implement, update, refactor), no \"How to\", no questions, no quotes, \
no trailing punctuation, no explanation. \
Examples: \"fix auth token refresh\" → \"Auth token refresh\"; \
\"why does useChatStream re-render on every keystroke\" → \"useChatStream re-renders\"; \
\"can you add dark mode\" → \"Dark mode\". \
Reply with ONLY the title. \
If the message starts with a /command or @agent (e.g. /code-reviewer, @planner), \
that context is relevant — reflect the invocation in the title when it adds meaning.";

/// Clamp so the title model never sees a huge paste (`MAX_SUBJECT_CHARS`).
const MAX_SUBJECT_CHARS: usize = 6_000;

#[tauri::command]
pub async fn session_generate_title(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
) -> Result<SessionTitleResultWire, CommandError> {
    let hub = hub(hub_cell, &state).await?;
    // Every failure path is the TS's `{ title: null }` — never a rejection.
    Ok(SessionTitleResultWire {
        title: generate_session_title(&state, &hub, &session_id).await.ok().flatten(),
    })
}

async fn generate_session_title(
    state: &AppState,
    hub: &Arc<ChatHub>,
    session_id: &str,
) -> Result<Option<String>, CommandError> {
    let Some(store) = open_store(state)? else {
        return Ok(None);
    };
    let Some(meta) = store.session_meta_by_id(session_id)? else {
        return Ok(None);
    };
    // Attachment-only sends persisted no text in v2 — same null outcome as
    // the TS's no-text-no-attachments guard.
    let Some(first_text) = store.first_user_text(session_id)? else {
        return Ok(None);
    };
    drop(store);

    let Some((provider, model_id)) = title_model_source(state, &meta) else {
        return Ok(None);
    };
    let engine = super::chat::build_engine_for(state, &provider, &model_id)
        .map_err(|_| CommandError::with_code("title engine unavailable", "TITLE_ENGINE"))?;
    let (_, prompt) = extract_subject(&build_title_subject(&first_text));
    if prompt.trim().is_empty() {
        return Ok(None);
    }
    let stream = Arc::new(RigStepStream::new(engine)) as Arc<dyn StepStream>;
    let raw = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        drain_title_text(stream, prompt),
    )
    .await
    .map_err(|_| CommandError::with_code("title generation timed out", "TITLE_TIMEOUT"))??;
    let clean = clean_title(&raw);
    if clean.is_empty() {
        return Ok(None);
    }
    rename_session(hub, session_id, &clean)?;
    Ok(Some(clean))
}

/// `defaultTitleModelOf`: the pinned title model (when its provider is
/// enabled) wins, else the session's provider (enabled not required — the TS
/// looked it up by id alone), else any enabled provider serving the model.
fn title_model_source(
    state: &AppState,
    meta: &tide_store::sessions_v2::SessionMetaV2,
) -> Option<(StoredProvider, String)> {
    let config = state.read_config(|cfg| cfg.clone()).ok()?;
    let utility = config
        .general_settings
        .as_ref()
        .and_then(|g| g.title_model.clone());
    if let Some(utility) = utility {
        if let Some(provider) = config
            .providers
            .iter()
            .find(|p| p.id == utility.provider_id && p.enabled)
        {
            return Some((provider.clone(), utility.model_id));
        }
    }
    if let Some(provider_id) = &meta.provider_id {
        if let Some(provider) = config.providers.iter().find(|p| p.id == *provider_id) {
            return Some((provider.clone(), meta.model_id.clone().unwrap_or_default()));
        }
    }
    if let Some(model_id) = &meta.model_id {
        if let Some(provider) = config.providers.iter().find(|p| {
            p.enabled && p.models.iter().any(|m| &m.model_id == model_id)
        }) {
            return Some((provider.clone(), model_id.clone()));
        }
    }
    None
}

/// A tools-free `stream_step` drained to completion — the engine's
/// non-streaming seam (same pattern as the auto-compact summarizer).
async fn drain_title_text(stream: Arc<dyn StepStream>, prompt: String) -> Result<String, CommandError> {
    let request = TurnRequest {
        messages: vec![HistoryMessage::user_text(prompt)],
        tools: Vec::new(),
        params: TurnParams {
            system: Some(TITLE_SYSTEM.to_owned()),
            thinking_level: ThinkingLevel::Off,
            reasoning_contracts: Vec::new(),
            model_max_output_tokens: Some(1_024),
        },
    };
    let mut event_stream = stream.stream_step(request);
    let mut text = String::new();
    use futures::StreamExt;
    while let Some(event) = event_stream.next().await {
        match event.map_err(|e| CommandError::with_code(e.to_string(), "TITLE_STREAM"))? {
            EngineEvent::Delta { text: delta } => text.push_str(&delta),
            EngineEvent::StepEnd { message, .. } if text.trim().is_empty() => {
                for part in &message.parts {
                    if let tide_engine::HistoryPart::Text { text: t } = part {
                        text.push_str(t);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(text)
}

/// `buildTitleSubject` without attachments (v2 persisted none): clamp the
/// message text.
fn build_title_subject(first_message: &str) -> String {
    let text = first_message.trim();
    if text.chars().count() <= MAX_SUBJECT_CHARS {
        return text.to_owned();
    }
    let clamped: String = text.chars().take(MAX_SUBJECT_CHARS).collect();
    format!("{clamped}…")
}

/// `extractSubject`: peel a leading `/command` or `@agent` invocation,
/// building the skill/agent-aware prompt.
fn extract_subject(raw: &str) -> (String, String) {
    let trimmed = raw.trim();
    let mut skill = None;
    let mut agent = None;
    let mut rest = trimmed;
    let mut name_run = |prefix: char| -> Option<String> {
        let body = trimmed.strip_prefix(prefix)?;
        let (name, tail) = match body.find(char::is_whitespace) {
            Some(idx) => (&body[..idx], &body[idx..]),
            None => (body, ""),
        };
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return None;
        }
        rest = tail.trim_start();
        Some(name.to_owned())
    };
    if trimmed.starts_with('/') {
        skill = name_run('/');
    } else if trimmed.starts_with('@') {
        agent = name_run('@');
    }
    let stripped = rest.trim().to_owned();
    let mut parts: Vec<String> = Vec::new();
    if let Some(skill) = &skill {
        parts.push(format!("Skill invoked: {skill}"));
    }
    if let Some(agent) = &agent {
        parts.push(format!("Agent: {agent}"));
    }
    if !rest.trim().is_empty() {
        parts.push(rest.trim().to_owned());
    }
    let prompt = if parts.len() > 1 {
        parts.join("\n")
    } else {
        rest.trim().to_owned()
    };
    (stripped, prompt)
}

/// The TS cleanup: trim, strip wrapping quotes/backticks/dots, 80-char cap.
fn clean_title(raw: &str) -> String {
    let once = raw.trim();
    let once = once.trim_start_matches(['"', '\'', '`']);
    let once = once.trim_end_matches(['"', '\'', '`', '.']);
    let once = once.trim_end_matches(|c: char| c.is_whitespace() || c == '.');
    once.chars().take(80).collect()
}

// ── shared helpers ──────────────────────────────────────────────────────────

async fn hub(
    hub_cell: tauri::State<'_, ChatHubCell>,
    state: &AppState,
) -> Result<Arc<ChatHub>, CommandError> {
    hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))
}

fn with_writer<T>(
    hub: &Arc<ChatHub>,
    run: impl FnOnce(&SessionsV2Writer) -> tide_store::sessions_v2::Result<T>,
) -> Result<T, CommandError> {
    run(&hub.writer().lock().expect("sink writer poisoned")).map_err(CommandError::from)
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

#[cfg(test)]
mod management_tests {
    use super::*;
    use git2::Repository;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tide-cmd-sessions-mgmt-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// State + hub over one tempdir, config seeded with a workspace whose
    /// path points at `ws_dir`.
    fn setup(name: &str, ws_dir: &Path) -> (AppState, Arc<ChatHub>, PathBuf) {
        let dir = temp_dir(name);
        fs::write(
            dir.join("config.json"),
            format!(
                r#"{{"workspaces":[{{"id": "ws_1", "name": "alpha", "path": {:?}}}]}}"#,
                ws_dir.to_string_lossy()
            ),
        )
        .unwrap();
        let state = AppState::load(dir.clone());
        let hub = ChatHub::open(&dir).unwrap();
        (state, hub, dir)
    }

    fn seed_session(
        hub: &Arc<ChatHub>,
        id: &str,
        workspace_path: &str,
        title: &str,
    ) {
        hub.writer()
            .lock()
            .expect("sink writer poisoned")
            .create_session(
                tide_store::sessions_v2_write::CreateSessionInput {
                    id,
                    workspace_path,
                    title,
                    model_id: "model-x",
                    provider_id: None,
                    parent_id: None,
                },
                10_000,
            )
            .unwrap();
    }

    fn add_message_with_text(
        hub: &Arc<ChatHub>,
        session_id: &str,
        role: &str,
        text: &str,
    ) -> String {
        let writer = hub.writer().lock().expect("sink writer poisoned");
        let (message_id, ms) = writer.next_message_slot();
        writer
            .insert_message(
                InsertMessageInput { id: &message_id, session_id, role, model: None },
                ms,
            )
            .unwrap();
        writer
            .insert_part(
                InsertPartInput {
                    id: &new_part_id(),
                    message_id: &message_id,
                    session_id,
                    seq: 0,
                    kind: "text",
                    data: &serde_json::json!({ "text": text }),
                },
                ms,
            )
            .unwrap();
        drop(writer);
        message_id
    }

    #[tokio::test]
    async fn get_derives_the_legacy_shape_from_v2() {
        let ws = temp_dir("get-ws");
        let (state, hub, dir) = setup("get", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");
        let m1 = add_message_with_text(&hub, "s_1", "user", "hello there");
        add_message_with_text(&hub, "s_1", "assistant", "hi back");
        {
            let writer = hub.writer().lock().expect("sink writer poisoned");
            writer.set_session_settings("s_1", Some("plan"), Some("high"), 11_000).unwrap();
            writer
                .set_session_worktree(
                    "s_1",
                    Some(&serde_json::json!({
                        "branch": "wt", "path": "/wt", "baseCommit": "abc",
                        "baseBranch": "main", "ahead": 1, "behind": 2
                    })),
                    11_500,
                )
                .unwrap();
            writer.add_usage(
                "s_1",
                tide_store::sessions_v2_write::UsageDeltaV2 {
                    input_tokens: 10,
                    output_tokens: 20,
                    tokens_reasoning: Some(1),
                    tokens_cache_read: Some(2),
                    cost_usd: 0.5,
                },
                12_000,
            )
            .unwrap();
        }

        let hydrated = get_session(&state, "s_1").unwrap().unwrap();
        assert_eq!(hydrated.id, "s_1");
        assert_eq!(hydrated.workspace_id, "ws_1");
        assert_eq!(hydrated.title, "One");
        assert_eq!(hydrated.model_id, "model-x");
        assert_eq!(hydrated.autonomy_mode, "plan");
        assert_eq!(hydrated.thinking_level, "high");
        assert_eq!(hydrated.status, "idle");
        assert_eq!(hydrated.messages.len(), 2);
        assert_eq!(hydrated.messages[0].content, "hello there");
        assert_eq!(hydrated.messages[0].id, m1);
        assert_eq!(hydrated.messages[1].role, "assistant");
        assert_eq!(
            hydrated.worktree.as_ref().unwrap()["branch"],
            serde_json::json!("wt")
        );
        assert_eq!(hydrated.usage["inputTokens"], serde_json::json!(10));
        assert_eq!(hydrated.usage["cacheWrite"], serde_json::json!(0));
        assert_eq!(hydrated.cost_usd, 0.5);
        assert!(hydrated.archived_at.is_none());

        // Wire shape: camelCase, optional fields absent.
        let wire = serde_json::to_value(&hydrated).unwrap();
        assert!(wire.get("archivedAt").is_none());
        assert!(wire.get("parentId").is_none());
        assert_eq!(wire["createdAt"], serde_json::json!("1970-01-01T00:00:10.000Z"));

        assert!(get_session(&state, "s_ghost").unwrap().is_none());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn rename_archive_delete_lifecycle_matches_ts_semantics() {
        let ws = temp_dir("lifecycle-ws");
        let (state, hub, dir) = setup("lifecycle", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");
        seed_session(&hub, "s_2", &ws.to_string_lossy(), "Two");

        rename_session(&hub, "s_1", "Renamed").unwrap();
        assert_eq!(get_session(&state, "s_1").unwrap().unwrap().title, "Renamed");
        rename_session(&hub, "s_ghost", "x").unwrap();

        // Two-step delete: an active session refuses.
        let err = delete_session(&hub, "s_1").unwrap_err();
        assert_eq!(err.code.as_deref(), Some("SESSION_NOT_ARCHIVED"));
        assert!(err.message.contains("archived before deletion"));

        archive_session(&hub, "s_1").unwrap();
        let one = get_session(&state, "s_1").unwrap().unwrap();
        assert!(one.archived_at.is_some());
        // Unknown ids stay silent no-ops.
        archive_session(&hub, "s_ghost").unwrap();
        unarchive_session(&hub, "s_ghost").unwrap();
        delete_session(&hub, "s_ghost").unwrap();

        unarchive_session(&hub, "s_1").unwrap();
        assert!(get_session(&state, "s_1").unwrap().unwrap().archived_at.is_none());

        archive_session(&hub, "s_1").unwrap();
        delete_session(&hub, "s_1").unwrap();
        assert!(get_session(&state, "s_1").unwrap().is_none());
        // The sibling survives.
        assert!(get_session(&state, "s_2").unwrap().is_some());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn update_settings_patches_and_touches_but_ghosts_noop() {
        let ws = temp_dir("settings-ws");
        let (state, hub, dir) = setup("settings", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");

        update_session_settings(
            &hub,
            "s_1",
            &SessionSettingsPatchWire { autonomy_mode: Some("edit".into()), thinking_level: None },
        )
        .unwrap();
        let one = get_session(&state, "s_1").unwrap().unwrap();
        assert_eq!(one.autonomy_mode, "edit");
        assert_eq!(one.thinking_level, "medium");
        // The settings write bumps the session's list position.
        assert!(one.updated_at > one.created_at);

        update_session_settings(
            &hub,
            "s_ghost",
            &SessionSettingsPatchWire { autonomy_mode: Some("full".into()), thinking_level: None },
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn dispatches_list_children_with_the_workspace_stamp() {
        let ws = temp_dir("dispatch-ws");
        let (state, hub, dir) = setup("dispatch", &ws);
        seed_session(&hub, "s_parent", &ws.to_string_lossy(), "Parent");
        {
            let writer = hub.writer().lock().expect("sink writer poisoned");
            writer
                .create_session(
                    tide_store::sessions_v2_write::CreateSessionInput {
                        id: "s_kid",
                        workspace_path: &ws.to_string_lossy(),
                        title: "Kid",
                        model_id: "model-x",
                        provider_id: None,
                        parent_id: Some("s_parent"),
                    },
                    11_000,
                )
                .unwrap();
        }
        add_message_with_text(&hub, "s_kid", "assistant", "done");

        let headers = list_dispatches(&state, "s_parent").unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].id, "s_kid");
        assert_eq!(headers[0].kind, "subagent");
        assert_eq!(headers[0].parent_id.as_deref(), Some("s_parent"));
        assert_eq!(headers[0].workspace_id, "ws_1");
        assert_eq!(headers[0].message_count, 1);

        assert!(list_dispatches(&state, "s_none").unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn user_add_message_noops_and_assistant_writes_parts() {
        let ws = temp_dir("addmsg-ws");
        let (state, hub, dir) = setup("addmsg", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");

        // User: the turn owns persistence — no row may appear.
        add_message(&hub, "s_1", "user", "hello").unwrap();
        assert!(get_session(&state, "s_1").unwrap().unwrap().messages.is_empty());

        add_assistant_message(
            &hub,
            "s_1",
            &AssistantMessageInputWire {
                content: "answer".into(),
                reasoning: Some("thinking…".into()),
            },
        )
        .unwrap();
        let one = get_session(&state, "s_1").unwrap().unwrap();
        assert_eq!(one.messages.len(), 1);
        assert_eq!(one.messages[0].role, "assistant");
        assert_eq!(one.messages[0].content, "answer");
        assert_eq!(one.messages[0].reasoning.as_deref(), Some("thinking…"));

        // Ghosts no-op like the TS.
        add_message(&hub, "s_ghost", "assistant", "x").unwrap();
        add_assistant_message(&hub, "s_ghost", &AssistantMessageInputWire::default()).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn finalize_upserts_streamed_messages_and_appends_missing_ones() {
        let ws = temp_dir("finalize-ws");
        let (state, hub, dir) = setup("finalize", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");
        let streamed = add_message_with_text(&hub, "s_1", "assistant", "partial");

        finalize_assistant_message(
            &hub,
            "s_1",
            &streamed,
            &AssistantMessageInputWire { content: "final text".into(), reasoning: None },
        )
        .unwrap();
        let one = get_session(&state, "s_1").unwrap().unwrap();
        assert_eq!(one.messages.len(), 1, "update in place, never a second copy");
        assert_eq!(one.messages[0].content, "final text");

        // A finalize for a message that never streamed appends with that id.
        finalize_assistant_message(
            &hub,
            "s_1",
            "m_shortturn",
            &AssistantMessageInputWire { content: "appended".into(), reasoning: None },
        )
        .unwrap();
        let one = get_session(&state, "s_1").unwrap().unwrap();
        assert_eq!(one.messages.len(), 2);
        assert_eq!(one.messages[1].id, "m_shortturn");
        assert_eq!(one.messages[1].content, "appended");
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn fork_copies_the_last_assistant_result_and_settings() {
        let ws = temp_dir("fork-ws");
        let (state, hub, dir) = setup("fork", &ws);
        seed_session(&hub, "s_src", &ws.to_string_lossy(), "Source");
        add_message_with_text(&hub, "s_src", "user", "please do the thing");
        add_message_with_text(&hub, "s_src", "assistant", "older answer");
        add_message_with_text(&hub, "s_src", "assistant", "final answer");
        {
            let writer = hub.writer().lock().expect("sink writer poisoned");
            writer.set_session_settings("s_src", Some("edit"), Some("low"), 11_000).unwrap();
        }

        let fork = fork_session(
            &state,
            &hub,
            "s_src",
            "model-y",
            SessionForkOptsWire::default(),
        )
        .unwrap();
        assert_ne!(fork.id, "s_src");
        assert_eq!(fork.title, "Fork of Source");
        assert_eq!(fork.model_id, "model-y");
        assert_eq!(fork.workspace_id, "ws_1");
        assert_eq!(fork.autonomy_mode, "edit");
        assert_eq!(fork.thinking_level, "low");
        assert_eq!(fork.messages.len(), 1);
        assert_eq!(fork.messages[0].content, "final answer");
        assert_eq!(fork.messages[0].role, "assistant");

        // Source unchanged, both readable back.
        let source = get_session(&state, "s_src").unwrap().unwrap();
        assert_eq!(source.messages.len(), 3);
        assert!(get_session(&state, &fork.id).unwrap().is_some());

        let err = fork_session(
            &state,
            &hub,
            "s_missing",
            "model-y",
            SessionForkOptsWire::default(),
        )
        .unwrap_err();
        assert!(err.message.contains("s_missing"));
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn clear_all_wipes_and_aborts() {
        let ws = temp_dir("clear-ws");
        let (state, hub, dir) = setup("clear", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");
        seed_session(&hub, "s_2", &ws.to_string_lossy(), "Two");
        hub.abort_all();
        {
            let writer = hub.writer().lock().expect("sink writer poisoned");
            writer.clear_all().unwrap();
        }
        assert!(get_session(&state, "s_1").unwrap().is_none());
        assert!(get_session(&state, "s_2").unwrap().is_none());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn worktree_commands_link_and_unlink_sessions() {
        // A real git repo as the workspace.
        let ws = temp_dir("wt-ws");
        let repo = Repository::init(&ws).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Tide Test").unwrap();
            config.set_str("user.email", "tide@test.local").unwrap();
        }
        fs::write(ws.join("f.txt"), "x\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("f.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = repo.signature().unwrap();
            let commit_id = repo
                .commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
            let commit = repo.find_commit(commit_id).unwrap();
            repo.branch("main", &commit, true).unwrap();
        }
        drop(repo);

        let (state, hub, dir) = setup("wt", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");

        let wire = create_worktree_for_session(
            &state,
            &hub,
            "s_1",
            &WorktreeCreateOptsWire {
                branch_name: "wt-session".into(),
                base_branch: "main".into(),
                config_files: None,
            },
        )
        .unwrap();
        assert!(wire.path.ends_with(".agent/worktrees/wt-session"));
        assert!(Path::new(&wire.path).join("f.txt").is_file());
        let stored = get_session(&state, "s_1").unwrap().unwrap().worktree.unwrap();
        assert_eq!(stored["branch"], serde_json::json!("wt-session"));

        // A second worktree on the same session refuses.
        let err = create_worktree_for_session(
            &state,
            &hub,
            "s_1",
            &WorktreeCreateOptsWire {
                branch_name: "wt-other".into(),
                base_branch: "main".into(),
                config_files: None,
            },
        )
        .unwrap_err();
        assert_eq!(err.code.as_deref(), Some("WORKTREE_EXISTS"));

        remove_worktree_for_session(&hub, "s_1").unwrap();
        assert!(get_session(&state, "s_1").unwrap().unwrap().worktree.is_none());
        assert!(!Path::new(&wire.path).exists());
        // Idempotent on a session without one.
        remove_worktree_for_session(&hub, "s_1").unwrap();
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn deleting_a_worktree_session_cascades_the_worktree() {
        let ws = temp_dir("wtdel-ws");
        let repo = Repository::init(&ws).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Tide Test").unwrap();
            config.set_str("user.email", "tide@test.local").unwrap();
        }
        fs::write(ws.join("f.txt"), "x\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("f.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = repo.signature().unwrap();
            let commit_id = repo
                .commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
            let commit = repo.find_commit(commit_id).unwrap();
            repo.branch("main", &commit, true).unwrap();
        }
        drop(repo);

        let (state, hub, dir) = setup("wtdel", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");
        let wire = create_worktree_for_session(
            &state,
            &hub,
            "s_1",
            &WorktreeCreateOptsWire {
                branch_name: "wt-del".into(),
                base_branch: "main".into(),
                config_files: None,
            },
        )
        .unwrap();
        archive_session(&hub, "s_1").unwrap();
        delete_session(&hub, "s_1").unwrap();
        assert!(!Path::new(&wire.path).exists(), "worktree dir removed with the session");
        let repo = Repository::open(&ws).unwrap();
        assert!(repo.find_branch("wt-del", git2::BranchType::Local).is_err());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    // ── title generation (unit level — the engine call stays untested) ─────

    #[test]
    fn title_subject_extraction_peels_commands_and_agents() {
        let (stripped, prompt) = extract_subject("fix the login bug");
        assert_eq!(stripped, "fix the login bug");
        assert_eq!(prompt, "fix the login bug");

        let (stripped, prompt) = extract_subject("/code-reviewer check this diff please");
        assert_eq!(stripped, "check this diff please");
        assert_eq!(prompt, "Skill invoked: code-reviewer\ncheck this diff please");

        let (stripped, prompt) = extract_subject("@planner design the API");
        assert_eq!(stripped, "design the API");
        assert_eq!(prompt, "Agent: planner\ndesign the API");

        // The TS regex matched any leading /word — punctuation inside the
        // rest stays part of it (skill "not", rest "a command/").
        let (_, prompt) = extract_subject("/not a command/");
        assert_eq!(prompt, "Skill invoked: not\na command/");
        // A name with punctuation breaks the [A-Za-z0-9_-]+ run + end anchor.
        let (_, prompt) = extract_subject("//double");
        assert_eq!(prompt, "//double");

        // Clamped subjects keep the ellipsis marker.
        let long = "x".repeat(6_500);
        let subject = build_title_subject(&long);
        assert!(subject.ends_with('…'));
        assert!(subject.chars().count() <= MAX_SUBJECT_CHARS + 1);
    }

    #[test]
    fn title_cleaning_strips_wrapping_noise_and_caps() {
        assert_eq!(clean_title("  \"Dark mode\"  "), "Dark mode");
        assert_eq!(clean_title("`Auth token refresh`."), "Auth token refresh");
        assert_eq!(clean_title("Title..."), "Title");
        assert_eq!(clean_title(""), "");
        let long = clean_title(&"y".repeat(200));
        assert_eq!(long.chars().count(), 80);
    }

    #[tokio::test]
    async fn title_model_resolution_prefers_the_pinned_model() {
        let ws = temp_dir("title-ws");
        let (_initial_state, hub, dir) = setup("title", &ws);
        seed_session(&hub, "s_1", &ws.to_string_lossy(), "One");
        fs::write(
            dir.join("config.json"),
            format!(
                r#"{{
                    "workspaces": [{{"id": "ws_1", "name": "a", "path": {:?}}}],
                    "providers": [
                        {{ "id": "p_a", "name": "A", "apiStyle": "openai", "baseUrl": "https://a", "enabled": true, "models": [{{ "id": "m1", "alias": "x", "modelId": "model-x", "contextWindow": 8, "providerId": "p_a" }}] }},
                        {{ "id": "p_b", "name": "B", "apiStyle": "anthropic", "baseUrl": "https://b", "enabled": true, "models": [] }}
                    ],
                    "generalSettings": {{ "titleModel": {{ "providerId": "p_b", "modelId": "title-model" }} }}
                }}"#,
                ws.to_string_lossy()
            ),
        )
        .unwrap();
        let state = AppState::load(dir.clone());

        let meta = tide_store::sessions_v2::SessionsV2::open(state.sessions_db_path())
            .unwrap()
            .session_meta_by_id("s_1")
            .unwrap()
            .unwrap();
        let (provider, model) = title_model_source(&state, &meta).unwrap();
        assert_eq!(provider.id, "p_b");
        assert_eq!(model, "title-model");

        // No pinned provider: the session's model is served by any enabled one.
        fs::write(
            dir.join("config.json"),
            format!(
                r#"{{"workspaces":[{{"id":"ws_1","name":"a","path":{:?}}}], "providers":[{{ "id": "p_a", "name": "A", "apiStyle": "openai", "baseUrl": "https://a", "enabled": true, "models": [{{ "id": "m1", "alias": "x", "modelId": "model-x", "contextWindow": 8, "providerId": "p_a" }}] }}]}}"#,
                ws.to_string_lossy()
            ),
        )
        .unwrap();
        let state = AppState::load(dir.clone());
        let (_, model) = title_model_source(&state, &meta).unwrap();
        assert_eq!(model, "model-x");

        // No providers at all → None → `{ title: null }`.
        fs::write(
            dir.join("config.json"),
            format!(r#"{{"workspaces":[{{"id":"ws_1","name":"a","path":{:?}}}]}}"#, ws.to_string_lossy()),
        )
        .unwrap();
        let state = AppState::load(dir.clone());
        assert!(title_model_source(&state, &meta).is_none());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }

    #[tokio::test]
    async fn generate_title_returns_null_without_subject_or_provider() {
        let ws = temp_dir("title2-ws");
        let (state, hub, dir) = setup("title2", &ws);
        seed_session(&hub, "s_empty", &ws.to_string_lossy(), "Empty");
        // No user message → null.
        assert_eq!(
            generate_session_title(&state, &hub, "s_empty").await.unwrap(),
            None
        );
        // No provider configured → null even with a user message.
        add_message_with_text(&hub, "s_empty", "user", "fix the widget");
        assert_eq!(
            generate_session_title(&state, &hub, "s_empty").await.unwrap(),
            None
        );
        // Unknown session → null.
        assert_eq!(
            generate_session_title(&state, &hub, "s_ghost").await.unwrap(),
            None
        );
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&ws).unwrap();
    }
}
