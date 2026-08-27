//! Sub-agent dispatch — port of `app/core/agent/tools/dispatch-agent.ts`
//! and `app/core/agent/agents/runtime.ts` @ 91ec558, restructured onto the
//! orchestrator's own turn loop: a dispatch spawns a CHILD TURN (own v2
//! session row with `parent_id` = the root session, own transcript) running
//! the catalog agent's system prompt with the agent's tool subset, and
//! mirrors the child's stream into the root session tagged with the
//! dispatch's tool call id (see [`crate::agent::orchestrator::MirrorTarget`]).
//!
//! Inheritance contract (TS parity):
//!
//! - **Permissions**: the child's gate = the parent's mode/rules snapshot;
//!   its asks park in the root session's id space with the CHILD's private
//!   mode cell — an approved escalation never reaches the parent's mode.
//! - **Abort**: children share the parent turn's abort watch + tool flag;
//!   aborting the parent kills every in-flight dispatch.
//! - **Recursion**: capped at [`MAX_AGENT_DEPTH`]; an agent may only spawn
//!   targets its catalog `canDispatch` grants (`dispatch_agent` is added to
//!   a child's toolset only then — `effective_child_tools`).
//! - **Plan mode**: `dispatch_agent` is read-tiered, but the TARGET agent's
//!   effective tier may not be — a plan-mode dispatch of a write/destructive
//!   agent surfaces a blocked card first (rules deny before the card, TS
//!   `withPermission` ordering).

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use tide_engine::{EngineUsage, ThinkingLevel};
use tide_store::sessions_v2_write::{new_session_id, CreateSessionInput};
use tide_tools::{
    agent_names, agent_risk_tier, can_dispatch_to, effective_child_tools, get_agent,
    AutonomyMode, OutcomeStatus, RiskTier, ToolDisplay, ToolOutcome,
};

use super::events::{format_arg_preview, AgentEvent, ToolCallWire, TurnStopReason};
use super::hub::{ChatHub, PermissionAnswer, TurnHandle};
use super::orchestrator::{
    execute_turn, IncomingUserMessage, MirrorTarget, PendingCall, TurnSpec,
};
use super::sink::unix_ms_now;

/// What a finished dispatch reports back to the step loop: the dispatch
/// tool's outcome (report + AgentDetail display) and the child's usage,
/// folded into the parent turn's rollup.
pub(crate) struct DispatchDone {
    pub outcome: ToolOutcome,
    pub usage: EngineUsage,
}

/// Spawn the dispatch as its own task so several in one step run in
/// parallel (TS parallel dispatch). Everything the child needs is owned.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_dispatch(
    hub: Arc<ChatHub>,
    parent_spec: TurnSpec,
    parent_turn: TurnHandle,
    engine: Arc<dyn super::orchestrator::StepStream>,
    tools: Vec<Arc<dyn tide_tools::Tool>>,
    call: PendingCall,
    emit_id: String,
    message_id: String,
) -> tokio::task::JoinHandle<Result<DispatchDone, String>> {
    tokio::spawn(async move {
        run_dispatch(hub, parent_spec, parent_turn, engine, tools, call, emit_id, message_id).await
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_dispatch(
    hub: Arc<ChatHub>,
    parent_spec: TurnSpec,
    parent_turn: TurnHandle,
    engine: Arc<dyn super::orchestrator::StepStream>,
    tools: Vec<Arc<dyn tide_tools::Tool>>,
    call: PendingCall,
    emit_id: String,
    message_id: String,
) -> Result<DispatchDone, String> {
    let started = Instant::now();
    let arg_str = |key: &str| {
        call.arguments
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let name = arg_str("name").unwrap_or_default();
    let task = arg_str("task").unwrap_or_default().trim().to_owned();
    let title = arg_str("title").map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    let resume_from = arg_str("resumeFrom").filter(|s| !s.is_empty());
    // background:true would detach onto the session's abort signal behind
    // the TS experimental flag; unflagged TS fell through to the foreground
    // dispatch, which is what happens here.
    let _background = call.arguments.get("background").and_then(serde_json::Value::as_bool);

    let done = |outcome: ToolOutcome| {
        DispatchDone {
            outcome: outcome.with_duration_ms(started.elapsed().as_millis() as u64),
            usage: EngineUsage::default(),
        }
    };

    let Some(agent) = get_agent(&name) else {
        return Ok(done(ToolOutcome::failed(format!(
            "Unknown agent: \"{name}\". Available: {}.",
            agent_names().join(", ")
        ))));
    };
    if task.is_empty() {
        return Ok(done(ToolOutcome::failed(format!(
            "Missing \"task\" for agent {name}. Provide a self-contained task description."
        ))));
    }
    let depth = parent_spec.mirror.as_ref().map_or(0, |m| m.depth);
    if depth >= tide_tools::MAX_AGENT_DEPTH {
        return Ok(done(ToolOutcome::failed(format!(
            "Agent {name}: max nesting depth ({}) reached. The main orchestrator should handle this directly.",
            tide_tools::MAX_AGENT_DEPTH
        ))));
    }
    // Nested dispatch: only agents whose canDispatch grants the target.
    if depth > 0 {
        let current = parent_spec
            .mirror
            .as_ref()
            .and_then(|m| get_agent(&m.agent));
        if let Some(current) = current {
            if !can_dispatch_to(current, &name) {
                return Ok(done(ToolOutcome::rejected(format!(
                    "This agent cannot dispatch \"{name}\"."
                ))));
            }
        }
    }

    // Plan-mode target gate: the tool itself is read-tiered, but spawning an
    // agent whose toolset can write/execute needs an explicit escalation.
    // Rules were checked by the step loop before spawning (deny first, TS
    // withPermission ordering). The card rides the root session; an
    // escalation answer mutates the DISPATCHING turn's mode cell.
    let mut mode = parent_turn.mode();
    if mode == AutonomyMode::Plan && agent_risk_tier(agent) != RiskTier::ReadOnly {
        let mut card_args = serde_json::json!({ "name": name, "task": task });
        if let Some(title) = &title {
            card_args["title"] = serde_json::json!(title);
        }
        hub.emit_agent(AgentEvent::PermissionRequired {
            session_id: emit_id.clone(),
            seq: hub.next_seq(&emit_id),
            tool_calls: vec![ToolCallWire {
                id: call.tool_call_id.clone(),
                message_id: message_id.clone(),
                tool_name: "dispatch_agent".to_owned(),
                arguments: card_args,
                arg_preview: format_arg_preview("dispatch_agent", &call.arguments),
                status: "pending".to_owned(),
                risk_tier: RiskTier::ReadOnly,
                gate_decision: Some("blocked"),
                allow_rule: None,
                output: None,
                display: None,
                duration_ms: None,
                meta: None,
            }],
            timeout_at: unix_ms_now()
                + parent_spec.permission_timeout.as_millis() as i64,
        });
        let rx = hub.register_ask_with_mode(
            &emit_id,
            &call.tool_call_id,
            Some(Arc::clone(&parent_turn.mode)),
        );
        let answer = tokio::time::timeout(parent_spec.permission_timeout, rx).await;
        let answer = match answer {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => PermissionAnswer {
                approve: false,
                remember: false,
                reason: Some("permission resolver dropped".to_owned()),
            },
            Err(_) => PermissionAnswer {
                approve: false,
                remember: false,
                reason: Some("Permission request timed out".to_owned()),
            },
        };
        if !answer.approve {
            return Ok(done(ToolOutcome::rejected(
                answer.reason.map(|reason| format!("User denied dispatching {name}: {reason}"))
                    .unwrap_or_else(|| format!("User denied dispatching {name} (plan mode).")),
            )));
        }
        mode = parent_turn.mode();
    }

    // ── child session ──
    // Fresh dispatch: a subagent row under the ROOT session (parent_id set
    // is what marks kind=subagent — the sidebar list filters on it).
    // resumeFrom: continue a prior dispatch of this root session instead.
    let child_id = match resume_from {
        Some(resume_id) => {
            let parent = hub
                .writer()
                .lock()
                .expect("sink writer poisoned")
                .session_parent_id(&resume_id);
            match parent {
                Some(Some(parent)) if parent == emit_id => resume_id,
                _ => {
                    return Ok(done(ToolOutcome::failed(format!(
                        "resumeFrom \"{resume_id}\" is not a dispatch of this session. Dispatch ids come from prior dispatch_agent results in this same session."
                    ))))
                }
            }
        }
        None => {
            let child_id = new_session_id();
            let title_row = format!(
                "{} (@{})",
                title.as_deref().unwrap_or(agent.name.as_str()),
                agent.name
            );
            let workspace = parent_spec.workspace_root.to_string_lossy();
            let created = hub
                .writer()
                .lock()
                .expect("sink writer poisoned")
                .create_session(
                    CreateSessionInput {
                        id: &child_id,
                        workspace_path: &workspace,
                        title: &title_row,
                        model_id: &parent_spec.model_id,
                        provider_id: None,
                        parent_id: Some(&emit_id),
                    },
                    unix_ms_now(),
                );
            if let Err(e) = created {
                return Ok(done(ToolOutcome::failed(format!(
                    "Agent {name} cannot run: child session could not be created ({e})."
                ))));
            }
            child_id
        }
    };

    // The task rides the child session as its user message — the child turn
    // reads its whole transcript (prior runs included, for resumes) back as
    // history.
    if let Err(e) = super::orchestrator::persist_user_message(
        hub.writer(),
        hub.sink(),
        &child_id,
        &IncomingUserMessage { content: task.clone() },
    ) {
        return Ok(done(ToolOutcome::failed(format!(
            "Agent {name} cannot run: {e}"
        ))));
    }

    let child_spec = TurnSpec {
        session_id: child_id.clone(),
        model_id: parent_spec.model_id.clone(),
        thinking_level: agent
            .thinking_level
            .as_deref()
            .and_then(parse_thinking)
            .unwrap_or(parent_spec.thinking_level),
        model_max_output_tokens: parent_spec.model_max_output_tokens,
        max_steps: TurnSpec::effective_max_steps(agent.max_steps.map(u64::from)),
        permission_timeout: parent_spec.permission_timeout,
        retry_delay: parent_spec.retry_delay,
        workspace_root: parent_spec.workspace_root.clone(),
        workspace_id: parent_spec.workspace_id.clone(),
        compaction: parent_spec.compaction.clone(),
        system: Some(agent.system_prompt.clone()),
        provider_id: parent_spec.provider_id.clone(),
        mirror: Some(MirrorTarget {
            parent_session_id: emit_id.clone(),
            parent_tool_call_id: call.tool_call_id.clone(),
            depth: depth + 1,
            agent: agent.name.clone(),
        }),
    };

    // The child's toolset: the registry filtered to the agent's effective
    // list (dispatch_agent included only when canDispatch grants it).
    let allowed = effective_child_tools(agent);
    let child_tools: Vec<Arc<dyn tide_tools::Tool>> = tools
        .into_iter()
        .filter(|t| allowed.iter().any(|n| *n == t.spec().name))
        .collect();

    // Abort surfaces shared with the dispatching turn; the mode cell is a
    // private snapshot (contained escalation — TS childCtx copy semantics).
    let child_turn = TurnHandle {
        abort_rx: parent_turn.abort_rx.clone(),
        tool_abort: parent_turn.tool_abort.clone(),
        mode: Arc::new(StdMutex::new(mode)),
    };

    let summary = execute_turn(&hub, &child_spec, engine, child_tools, child_turn).await?;

    let report = summary.text.trim().to_owned();
    let aborted =
        summary.stop_reason == TurnStopReason::Aborted || parent_turn.is_aborted();
    let outcome = if aborted {
        ToolOutcome {
            status: OutcomeStatus::Aborted,
            output: format!("Agent {name} aborted."),
            display: None,
            meta: None,
            duration_ms: None,
        }
    } else if report.is_empty() {
        let why = summary
            .error
            .as_deref()
            .map(|e| format!(" failed: {e}"))
            .unwrap_or_else(|| format!(" returned no content (stop reason {:?}, {} steps).", summary.stop_reason, summary.steps));
        ToolOutcome::failed(format!("Agent {name}{why}"))
    } else {
        ToolOutcome {
            status: OutcomeStatus::Executed,
            output: report.clone(),
            display: Some(ToolDisplay::Agent {
                agent_name: agent.name.clone(),
                title: title.clone(),
                task: task.clone(),
                report,
                reasoning: summary.reasoning.clone(),
                dispatch_id: Some(child_id),
            }),
            meta: Some(format!("{} · {} steps", agent.name, summary.steps)),
            duration_ms: None,
        }
    };
    Ok(DispatchDone {
        outcome: outcome.with_duration_ms(started.elapsed().as_millis() as u64),
        usage: summary.usage,
    })
}

fn parse_thinking(level: &str) -> Option<ThinkingLevel> {
    match level {
        "off" => Some(ThinkingLevel::Off),
        "minimal" => Some(ThinkingLevel::Minimal),
        "low" => Some(ThinkingLevel::Low),
        "medium" => Some(ThinkingLevel::Medium),
        "high" => Some(ThinkingLevel::High),
        "extra" => Some(ThinkingLevel::Extra),
        "max" => Some(ThinkingLevel::Max),
        _ => None,
    }
}
