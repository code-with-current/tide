//! M2 chat commands — `session_create`, `chat_run_turn` (job pattern:
//! returns `{accepted}` immediately, the turn runs detached and streams via
//! the Channel), `chat_abort`, `permission_respond`, `chat_attach_channel`
//! (the webview Channel push transport), and the `events_subscribe` /
//! `events_unsubscribe` replay path.
//!
//! Rust command names stay the snake_case of the TideRPC methods the bridge
//! maps onto them, same convention as the M1 domains.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tide_engine::{
    EngineModel, EngineModelConfig, EngineUsage, ProviderApiStyle, ThinkingLevel,
};
use tide_store::config::StoredProvider;
use tide_tools::{AutonomyMode, Tool};

use crate::agent::events::{AgentEvent, ChatPush, TurnStopReason};
use crate::agent::hub::{ChatHub, ChatHubCell, PermissionAnswer, TurnHandle};
use crate::agent::mcp::McpPoolCell;
use crate::agent::orchestrator::{
    core_tools_shared, execute_turn, persist_user_message, IncomingUserMessage, RigStepStream,
    StepStream, TurnSpec,
};
use crate::agent::sink::{iso_ms, unix_ms_now};
use crate::state::AppState;

use super::CommandError;

// ── wire shapes ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnMessageWire {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRunTurnArgs {
    pub session_id: String,
    pub messages: Vec<ChatTurnMessageWire>,
    pub model_id: String,
    pub provider_id: String,
    pub autonomy_mode: Option<String>,
    pub thinking_level: Option<String>,
}

/// `ChatSendResult` — `{ accepted: true } | { accepted: false, error }`.
#[derive(Debug, Clone, Serialize)]
pub struct ChatSendResultWire {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ChatSendResultWire {
    fn rejected(error: impl Into<String>) -> Self {
        Self {
            accepted: false,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateOptsWire {
    pub autonomy_mode: Option<String>,
    pub thinking_level: Option<String>,
    pub provider_id: Option<String>,
}

/// The `HydratedSession` create response (`shared/rpc.ts`): a fresh session
/// with UI defaults — empty messages, idle status, zero usage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedSessionWire {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    pub messages: Vec<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
    pub autonomy_mode: String,
    pub thinking_level: String,
    pub status: &'static str,
    pub usage: serde_json::Value,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRespondArgs {
    pub session_id: String,
    pub tool_call_ids: Vec<String>,
    pub approve: bool,
    pub new_mode: Option<String>,
    pub remember: Option<bool>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsSubscribeResult {
    pub batches: Vec<tide_store::sessions_v2_write::FlushBatchWire>,
}

// ── lenient enum parsing (wire stays strings, unknown falls to default) ─────

fn parse_autonomy(value: &Option<String>) -> AutonomyMode {
    match value.as_deref() {
        Some("plan") => AutonomyMode::Plan,
        Some("edit") => AutonomyMode::Edit,
        Some("full") => AutonomyMode::FullAccess,
        _ => AutonomyMode::Ask,
    }
}

fn parse_thinking(value: &Option<String>) -> ThinkingLevel {
    match value.as_deref() {
        Some("off") => ThinkingLevel::Off,
        Some("minimal") => ThinkingLevel::Minimal,
        Some("low") => ThinkingLevel::Low,
        Some("high") => ThinkingLevel::High,
        Some("extra") => ThinkingLevel::Extra,
        Some("max") => ThinkingLevel::Max,
        _ => ThinkingLevel::Medium,
    }
}

// ── session_create ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_create(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    workspace_id: String,
    title: String,
    model_id: String,
    opts: Option<SessionCreateOptsWire>,
) -> Result<HydratedSessionWire, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    create_session(&state, &hub, workspace_id, title, model_id, opts.unwrap_or_default())
}

pub(crate) fn create_session(
    state: &AppState,
    hub: &ChatHub,
    workspace_id: String,
    title: String,
    model_id: String,
    opts: SessionCreateOptsWire,
) -> Result<HydratedSessionWire, CommandError> {
    let workspace_path = state.read_config(|cfg| {
        cfg.workspaces
            .iter()
            .find(|ws| ws.id == workspace_id)
            .map(|ws| ws.path.clone())
    })?;
    let Some(workspace_path) = workspace_path else {
        return Err(CommandError::with_code(
            format!("Workspace {workspace_id} not found"),
            "WORKSPACE_NOT_FOUND",
        ));
    };
    // TS created sessions titled from opts/first message; an empty title
    // falls back to the generic card title.
    let title = if title.trim().is_empty() {
        "New session".to_owned()
    } else {
        title
    };
    let id = tide_store::sessions_v2_write::new_session_id();
    let now = unix_ms_now();
    hub.writer()
        .lock()
        .expect("sink writer poisoned")
        .create_session(
            tide_store::sessions_v2_write::CreateSessionInput {
                id: &id,
                workspace_path: &workspace_path,
                title: &title,
                model_id: &model_id,
                provider_id: opts.provider_id.as_deref(),
                parent_id: None,
            },
            now,
        )
        .map_err(CommandError::from)?;
    Ok(HydratedSessionWire {
        id,
        workspace_id,
        title,
        model_id,
        provider_id: opts.provider_id,
        messages: Vec::new(),
        created_at: iso_ms(now),
        updated_at: iso_ms(now),
        autonomy_mode: opts.autonomy_mode.unwrap_or_else(|| "ask".into()),
        thinking_level: opts.thinking_level.unwrap_or_else(|| "medium".into()),
        status: "idle",
        usage: serde_json::json!({
            "inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0,
            "reasoningTokens": 0, "calls": 0, "costUsd": 0.0,
        }),
        cost_usd: 0.0,
    })
}

// ── chat_run_turn ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn chat_run_turn(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    mcp_cell: tauri::State<'_, McpPoolCell>,
    args: ChatRunTurnArgs,
) -> Result<ChatSendResultWire, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    // Production engine: the resolved provider's rig model.
    let engine = match build_engine(&state, &args.provider_id, &args.model_id) {
        Ok(model) => Arc::new(RigStepStream::new(model)) as Arc<dyn StepStream>,
        Err(error) => return Ok(ChatSendResultWire::rejected(error)),
    };
    // MCP servers join the turn dynamically: keep the pool warm for this
    // session's workspace and append its connected tools to the core list.
    let workspace_root = hub
        .writer()
        .lock()
        .expect("sink writer poisoned")
        .session_workspace_path(&args.session_id);
    mcp_cell
        .ensure_started(
            state.data_dir().to_path_buf(),
            state.read_config(|cfg| cfg.clone())?,
            workspace_root.clone(),
        )
        .await;
    let mut tools = core_tools_shared();
    tools.extend(mcp_cell.turn_tools().await);
    start_turn(&state, &hub, args, engine, tools).await
}

/// The turn pre-flight + spawn, injectable-engine so tests drive a scripted
/// [`StepStream`].
pub(crate) async fn start_turn(
    state: &AppState,
    hub: &Arc<ChatHub>,
    args: ChatRunTurnArgs,
    engine: Arc<dyn StepStream>,
    tools: Vec<Arc<dyn Tool>>,
) -> Result<ChatSendResultWire, CommandError> {
    // Provider + key pre-flight (mirrors the TS chatSend checks — an
    // immediate typed rejection, not an async error+turn_end pair).
    let config = state.read_config(|cfg| cfg.clone())?;
    let provider = match resolve_provider(&config, &args.provider_id, &args.model_id) {
        Some(provider) => provider,
        None => return Ok(ChatSendResultWire::rejected(format!(
            "Provider {} not found",
            args.provider_id
        ))),
    };

    let Some(workspace_path) = hub
        .writer()
        .lock()
        .expect("sink writer poisoned")
        .session_workspace_path(&args.session_id)
    else {
        return Ok(ChatSendResultWire::rejected(format!(
            "Session {} not found",
            args.session_id
        )));
    };

    // One turn per session; the payload's autonomy mode is the handle's
    // initial mode (escalations mutate it for the rest of the turn).
    let initial_mode = parse_autonomy(&args.autonomy_mode);
    let turn_handle = match hub.begin_turn(&args.session_id, initial_mode) {
        Ok(handle) => handle,
        Err(error) => return Ok(ChatSendResultWire::rejected(error)),
    };

    // Persist the just-added user message (the twinV2 pattern: message row +
    // committed text part; the turn task flush-barriers before reading).
    if let Some(incoming) = last_user_message(&args) {
        if let Err(error) =
            persist_user_message(hub.writer(), hub.sink(), &args.session_id, &incoming)
        {
            hub.end_turn(&args.session_id);
            return Ok(ChatSendResultWire::rejected(error));
        }
    }

    let settings = state
        .read_config(|cfg| cfg.agent_settings.clone())?
        .map(|s| s.effective())
        .unwrap_or_default();
    let model_entry = config
        .provider(&provider.id)
        .and_then(|p| {
            p.models
                .iter()
                .find(|m| m.model_id == args.model_id)
                .cloned()
        });
    let model_max_output_tokens = model_entry
        .as_ref()
        .and_then(|m| m.extra.get("maxOutputTokens"))
        .and_then(|v| v.as_u64());
    // Auto-compact config (TS orchestrator pre-flight): a known context
    // window enables it — with the user's clamped settings when enabled, a
    // 0.99 last-resort threshold when disabled.
    let compaction = model_entry
        .as_ref()
        .map(|m| m.context_window)
        .filter(|w| *w > 0)
        .map(|context_window| {
            crate::agent::auto_compact::AutoCompactConfig::from_settings(
                context_window,
                model_entry
                    .as_ref()
                    .and_then(|m| m.extra.get("maxInputTokens"))
                    .and_then(|v| v.as_u64()),
                model_max_output_tokens,
                settings.compaction_enabled,
                settings.compaction_threshold,
                settings.compaction_keep_turns,
            )
        });
    // The memory tool's workspace key: the session's workspace path matched
    // back against the configured workspaces (empty when unmatched).
    let workspace_id = state
        .read_config(|cfg| {
            cfg.workspaces
                .iter()
                .find(|ws| ws.path == workspace_path)
                .map(|ws| ws.id.clone())
        })
        .ok()
        .flatten()
        .unwrap_or_default();

    let spec = TurnSpec {
        session_id: args.session_id.clone(),
        model_id: args.model_id.clone(),
        thinking_level: parse_thinking(&args.thinking_level),
        model_max_output_tokens,
        max_steps: TurnSpec::effective_max_steps(Some(settings.max_steps)),
        permission_timeout: TurnSpec::effective_permission_timeout(Some(
            settings.permission_timeout_min,
        )),
        retry_delay: crate::agent::orchestrator::RETRY_DELAY,
        workspace_root: std::path::PathBuf::from(workspace_path),
        workspace_id,
        compaction,
        system: None,
        mirror: None,
    };

    let task_hub = Arc::clone(hub);
    let task_spec = spec.clone();
    tokio::spawn(turn_task(task_hub, task_spec, engine, tools, turn_handle));
    Ok(ChatSendResultWire {
        accepted: true,
        error: None,
    })
}

/// The detached turn: any setup failure inside `execute_turn` surfaces as an
/// error + turn_end pair (the renderer's isStreaming must always clear),
/// then the per-session lock releases.
async fn turn_task(
    hub: Arc<ChatHub>,
    spec: TurnSpec,
    engine: Arc<dyn StepStream>,
    tools: Vec<Arc<dyn Tool>>,
    turn_handle: TurnHandle,
) {
    let session_id = spec.session_id.clone();
    if let Err(message) = execute_turn(&hub, &spec, engine, tools, turn_handle).await {
        hub.emit_agent(AgentEvent::Error {
            session_id: session_id.clone(),
            seq: hub.next_seq(&session_id),
            message,
        });
        hub.emit_agent(AgentEvent::TurnEnd {
            session_id: session_id.clone(),
            seq: hub.next_seq(&session_id),
            message_id: tide_store::sessions_v2_write::new_message_id(),
            stop_reason: TurnStopReason::Refusal,
            content: String::new(),
            timeline: Some(Vec::new()),
            reasoning: None,
            reasoning_tokens: None,
            total_ms: Some(0),
            tool_calls: None,
            usage: Some(EngineUsage::default()),
            last_step_usage: None,
        });
    }
    hub.end_turn(&session_id);
}

/// Pinned providerId first, then any enabled provider serving the modelId —
/// the TS resolution order (orphaned sessions whose provider was deleted).
fn resolve_provider(config: &tide_store::config::Config, provider_id: &str, model_id: &str) -> Option<StoredProvider> {
    if let Some(p) = config.provider(provider_id) {
        return Some(p.clone());
    }
    config
        .providers
        .iter()
        .find(|p| p.enabled && p.models.iter().any(|m| m.model_id == model_id))
        .cloned()
}

fn build_engine(
    state: &AppState,
    provider_id: &str,
    model_id: &str,
) -> Result<EngineModel, String> {
    let config = state
        .read_config(|cfg| cfg.clone())
        .map_err(|e| e.message)?;
    let provider = resolve_provider(&config, provider_id, model_id)
        .ok_or_else(|| format!("Provider {provider_id} not found"))?;
    let api_key = tide_store::secrets::get_api_key(&config, &provider.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("No API key for {}", provider.name))?;
    let api_style = match provider.api_style.as_str() {
        "anthropic" => ProviderApiStyle::Anthropic,
        _ => ProviderApiStyle::OpenAi,
    };
    let engine_config = EngineModelConfig {
        api_style,
        base_url: provider.base_url.clone(),
        api_key,
        model_id: model_id.to_owned(),
    };
    EngineModel::from_config(&engine_config).map_err(|e| e.to_string())
}

/// Shared with the sessions domain (title generation resolves its own
/// provider + model, then builds the engine exactly this way).
pub(crate) fn build_engine_for(
    state: &AppState,
    provider: &tide_store::config::StoredProvider,
    model_id: &str,
) -> Result<EngineModel, String> {
    let config = state
        .read_config(|cfg| cfg.clone())
        .map_err(|e| e.message)?;
    let api_key = tide_store::secrets::get_api_key(&config, &provider.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("No API key for {}", provider.name))?;
    let api_style = match provider.api_style.as_str() {
        "anthropic" => ProviderApiStyle::Anthropic,
        _ => ProviderApiStyle::OpenAi,
    };
    EngineModel::from_config(&EngineModelConfig {
        api_style,
        base_url: provider.base_url.clone(),
        api_key,
        model_id: model_id.to_owned(),
    })
    .map_err(|e| e.to_string())
}

fn last_user_message(args: &ChatRunTurnArgs) -> Option<IncomingUserMessage> {
    args.messages
        .iter()
        .next_back()
        .filter(|m| m.role == "user" && !m.content.trim().is_empty())
        .map(|m| IncomingUserMessage {
            content: m.content.clone(),
        })
}

// ── chat_abort / permission_respond / chat_submit_followup ─────────────────

#[tauri::command]
pub async fn chat_abort(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
) -> Result<(), CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    hub.abort_turn(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn permission_respond(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    args: PermissionRespondArgs,
) -> Result<(), CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    respond_permission(&hub, args);
    Ok(())
}

pub(crate) fn respond_permission(hub: &ChatHub, args: PermissionRespondArgs) {
    // Escalation rides the ask: the owning turn's mode cell (a child's
    // private cell for sub-agent cards, the active turn for root cards) —
    // only a card that no longer matches a pending ask falls back to the
    // session-level escalation.
    let new_mode = args.new_mode.as_deref().and_then(parse_mode);
    let mut resolved_any = false;
    for tool_call_id in &args.tool_call_ids {
        resolved_any |= hub.resolve_ask(
            &args.session_id,
            tool_call_id,
            PermissionAnswer {
                approve: args.approve,
                remember: args.remember.unwrap_or(false),
                reason: args.reason.clone(),
            },
            new_mode,
        );
    }
    if !resolved_any {
        if let Some(mode) = new_mode {
            hub.set_turn_mode(&args.session_id, mode);
        }
    }
}

fn parse_mode(value: &str) -> Option<AutonomyMode> {
    match value {
        "plan" => Some(AutonomyMode::Plan),
        "ask" => Some(AutonomyMode::Ask),
        "edit" => Some(AutonomyMode::Edit),
        "full" => Some(AutonomyMode::FullAccess),
        _ => None,
    }
}

/// `chatSubmitFollowup` — the renderer's followup popup answer. Resolves
/// the parked ask_followup_question call (TS `submitFollowup` IPC →
/// `resolveFollowup`); `{ resolved: false }` for a stale/duplicate card.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSubmitFollowupArgs {
    pub session_id: String,
    pub tool_call_id: String,
    pub answer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSubmitFollowupResult {
    pub resolved: bool,
}

#[tauri::command]
pub async fn chat_submit_followup(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    args: ChatSubmitFollowupArgs,
) -> Result<ChatSubmitFollowupResult, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    Ok(resolve_followup_core(&hub, &args))
}

/// The injectable core tests drive (same shape as [`respond_permission`]).
pub(crate) fn resolve_followup_core(
    hub: &ChatHub,
    args: &ChatSubmitFollowupArgs,
) -> ChatSubmitFollowupResult {
    ChatSubmitFollowupResult {
        resolved: hub.resolve_followup(&args.session_id, &args.tool_call_id, &args.answer),
    }
}

// ── Channel transport + replay subscribe ────────────────────────────────────

/// Attach the webview's push Channel. The renderer bridge calls this ONCE
/// after the handshake; a re-attach replaces the previous forwarder (the
/// generation counter retires the old task). Every AgentEvent and every
/// live-session FlushBatch rides this single Channel, tagged by `kind`.
#[tauri::command]
pub async fn chat_attach_channel(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    channel: tauri::ipc::Channel<ChatPush>,
) -> Result<(), CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    let generation = hub.next_channel_generation();
    let mut push_rx = hub.subscribe_push();
    let forward_hub = Arc::clone(&hub);
    tokio::spawn(async move {
        while let Ok(push) = push_rx.recv().await {
            if forward_hub.channel_generation() != generation {
                break;
            }
            if channel.send(push).is_err() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn events_subscribe(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
    last_seq: Option<i64>,
) -> Result<EventsSubscribeResult, CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    Ok(EventsSubscribeResult {
        batches: hub.sink().subscribe_session(&session_id, last_seq),
    })
}

#[tauri::command]
pub async fn events_unsubscribe(
    state: tauri::State<'_, AppState>,
    hub_cell: tauri::State<'_, ChatHubCell>,
    session_id: String,
) -> Result<(), CommandError> {
    let hub = hub_cell
        .get(state.data_dir())
        .await
        .map_err(|e| CommandError::with_code(e, "DB_OPEN"))?;
    hub.sink().unsubscribe_session(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_shapes_parse_and_serialize() {
        let args: ChatRunTurnArgs = serde_json::from_value(serde_json::json!({
            "sessionId": "s_1",
            "messages": [{ "role": "user", "content": "hi" }],
            "modelId": "glm-4.7",
            "providerId": "p_1",
            "autonomyMode": "edit",
            "thinkingLevel": "high",
        }))
        .unwrap();
        assert_eq!(args.session_id, "s_1");
        assert_eq!(args.messages.len(), 1);
        assert_eq!(parse_autonomy(&args.autonomy_mode), AutonomyMode::Edit);
        assert_eq!(parse_thinking(&args.thinking_level), ThinkingLevel::High);
        assert_eq!(parse_thinking(&Some("bogus".into())), ThinkingLevel::Medium);

        let result = ChatSendResultWire::rejected("Provider p not found");
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["accepted"], serde_json::json!(false));
        assert_eq!(wire["error"], serde_json::json!("Provider p not found"));
        let ok = ChatSendResultWire {
            accepted: true,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({ "accepted": true })
        );
    }

    #[test]
    fn hydrated_session_wire_matches_the_rpc_shape() {
        let wire = HydratedSessionWire {
            id: "s_x".into(),
            workspace_id: "ws_1".into(),
            title: "T".into(),
            model_id: "m".into(),
            provider_id: Some("p".into()),
            messages: Vec::new(),
            created_at: iso_ms(4_000),
            updated_at: iso_ms(4_000),
            autonomy_mode: "ask".into(),
            thinking_level: "medium".into(),
            status: "idle",
            usage: serde_json::json!({
                "inputTokens": 0, "outputTokens": 0, "cacheRead": 0, "cacheWrite": 0,
                "reasoningTokens": 0, "calls": 0, "costUsd": 0.0,
            }),
            cost_usd: 0.0,
        };
        let v = serde_json::to_value(&wire).unwrap();
        assert_eq!(v["id"], serde_json::json!("s_x"));
        assert_eq!(v["createdAt"], serde_json::json!("1970-01-01T00:00:04.000Z"));
        assert_eq!(v["status"], serde_json::json!("idle"));
        assert_eq!(v["usage"]["inputTokens"], serde_json::json!(0));
        assert!(v.get("parent_id").is_none());
    }
}
