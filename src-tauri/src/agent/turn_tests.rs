//! End-to-end turn tests — fake engine + fake tool over a tempdir store,
//! through the same `start_turn` core production uses. Each test asserts a
//! turn's three outputs: the AgentEvent sequence (Channel), the FlushBatch
//! pushes (live sink), and the persisted rows (reader round-trip).
//!
//! Fake errors ride `EngineError::Config(msg)` — rig's `CompletionError`
//! has no constructible variants outside tide-engine, and the loop's
//! transient/auth classification reads the message text either way.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures::stream::{self, Stream, StreamExt};
use tide_engine::{
    EngineError, EngineEvent, EngineStopReason, EngineUsage, HistoryMessage, HistoryPart,
    HistoryRole, TurnRequest,
};
use tide_tools::permission::RiskTier;
use tide_tools::{AutonomyMode, OutcomeStatus, Tool, ToolContext, ToolOutcome};
use tokio::sync::broadcast;

use super::events::{AgentEvent, ChatPush, TurnStopReason};
use super::hub::ChatHub;
use super::orchestrator::{self, StepStream, TurnSpec};
use crate::commands::chat::{
    create_session, respond_permission, start_turn, ChatRunTurnArgs, ChatSendResultWire,
    ChatTurnMessageWire, PermissionRespondArgs, SessionCreateOptsWire,
};
use crate::state::AppState;

const WAIT: Duration = Duration::from_secs(5);
const RETRIES: usize = 10;

// ── fakes ───────────────────────────────────────────────────────────────────

type StepScript = Vec<Result<EngineEvent, EngineError>>;

/// Scripted engine: each call pops the next step's script (front to back);
/// calls past the script fail loudly so test scripts stay exact.
struct ScriptedEngine {
    steps: StdMutex<Vec<StepScript>>,
    requests: StdMutex<Vec<TurnRequest>>,
}

impl ScriptedEngine {
    fn new(steps: Vec<StepScript>) -> Arc<Self> {
        Arc::new(Self {
            steps: StdMutex::new(steps),
            requests: StdMutex::new(Vec::new()),
        })
    }

    fn requests(&self) -> Vec<TurnRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl StepStream for ScriptedEngine {
    fn stream_step(&self, request: TurnRequest) -> StepStreamBox {
        self.requests.lock().unwrap().push(request);
        let next = {
            let mut steps = self.steps.lock().unwrap();
            (!steps.is_empty()).then(|| steps.remove(0))
        };
        match next {
            Some(events) => Box::pin(stream::iter(events)),
            None => Box::pin(stream::iter(vec![Err(EngineError::Config(
                "script exhausted".to_owned(),
            ))])),
        }
    }
}

type StepStreamBox = std::pin::Pin<Box<dyn Stream<Item = Result<EngineEvent, EngineError>> + Send>>;

/// Streams one text delta, then pends forever — the abort-mid-stream setup.
struct PausingEngine;

impl StepStream for PausingEngine {
    fn stream_step(&self, _request: TurnRequest) -> StepStreamBox {
        let head = stream::iter(vec![Ok::<EngineEvent, EngineError>(EngineEvent::Delta {
            text: "partial ".to_owned(),
        })]);
        let tail: StepStreamBox = Box::pin(stream::pending());
        Box::pin(head.chain(tail))
    }
}

/// A write-tier echo tool — auto-runs in edit/full, asks in ask mode.
struct EchoTool;

impl Tool for EchoTool {
    fn spec(&self) -> tide_tools::ToolSpec {
        tide_tools::ToolSpec {
            name: "echo".to_owned(),
            description: "Echoes text back.".to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"],
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, tide_tools::ToolError> {
        let text = args
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_owned();
        Ok(ToolOutcome::executed(format!("echo: {text}")))
    }
}

// ── script builders ─────────────────────────────────────────────────────────

fn delta(text: &str) -> Result<EngineEvent, EngineError> {
    Ok(EngineEvent::Delta {
        text: text.to_owned(),
    })
}

fn assembled_tool_call(id: &str, args: serde_json::Value) -> Result<EngineEvent, EngineError> {
    Ok(EngineEvent::ToolCall {
        tool_call_id: id.to_owned(),
        tool_name: "echo".to_owned(),
        arguments: args,
    })
}

fn usage(tokens: u64) -> Result<EngineEvent, EngineError> {
    Ok(EngineEvent::Usage {
        tokens: EngineUsage {
            input_tokens: tokens,
            output_tokens: tokens / 2,
            ..EngineUsage::step()
        },
    })
}

fn step_end(stop: EngineStopReason, parts: Vec<HistoryPart>) -> Result<EngineEvent, EngineError> {
    Ok(EngineEvent::StepEnd {
        stop_reason: stop,
        message: HistoryMessage {
            role: HistoryRole::Assistant,
            parts,
        },
    })
}

fn call_part(id: &str, args: serde_json::Value) -> HistoryPart {
    HistoryPart::ToolCall {
        id: id.to_owned(),
        tool_name: "echo".to_owned(),
        arguments: args,
    }
}

fn text_part(text: &str) -> HistoryPart {
    HistoryPart::Text {
        text: text.to_owned(),
    }
}

fn transient_failure() -> EngineError {
    EngineError::Config("upstream connection reset (HTTP 502)".to_owned())
}

fn auth_failure() -> EngineError {
    EngineError::Config("401 Unauthorized: invalid API key".to_owned())
}

/// Persist one fully-committed history message (role + text part) straight
/// through the writer + sink — pre-turn context for compaction tests.
fn seed_history_message(fx: &Fixture, role: &str, text: &str) {
    use tide_store::sessions_v2_write::{
        InsertMessageInput, SinkEventType, SinkEventWire,
    };
    let (message_id, message_ms) = {
        let writer = fx.hub.writer().lock().unwrap();
        let slot = writer.next_message_slot();
        writer
            .insert_message(
                InsertMessageInput {
                    id: &slot.0,
                    session_id: &fx.session_id,
                    role,
                    model: None,
                },
                slot.1,
            )
            .unwrap();
        slot
    };
    fx.hub.sink().emit(SinkEventWire {
        r#type: SinkEventType::PartCommit,
        session_id: fx.session_id.clone(),
        message_id: Some(message_id),
        part_id: Some(tide_store::sessions_v2_write::new_part_id()),
        data: Some(serde_json::json!({
            "kind": "text",
            "data": { "text": text, "seq": 0 },
        })),
        seq: None,
    });
    let _ = message_ms;
}

/// A ~4K-token text body (bigger than the clamped 2K-token tail budget).
fn bulky_text(seed: &str) -> String {
    format!("{seed}{}", "b".repeat(14_000))
}

// ── fixture ─────────────────────────────────────────────────────────────────

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
    hub: Arc<ChatHub>,
    push_rx: broadcast::Receiver<ChatPush>,
    session_id: String,
}

impl Fixture {
    fn new(name: &str) -> Self {
        Self::with_workspace_files(name, &[])
    }

    fn with_workspace_files(_name: &str, files: &[(&str, &str)]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            serde_json::json!({
                "workspaces": [{ "id": "ws_1", "name": "ws", "path": dir.path().to_str().unwrap() }],
                "providers": [{
                    "id": "p1", "name": "Fake", "apiStyle": "openai",
                    "baseUrl": "https://fake.invalid/v1", "enabled": true,
                    "models": [{ "id": "m", "alias": "m", "modelId": "m", "contextWindow": 128000, "providerId": "p1" }]
                }]
            })
            .to_string(),
        )
        .unwrap();
        for (rel, body) in files {
            let path = dir.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let state = AppState::load(dir.path().to_path_buf());
        let hub = ChatHub::open(dir.path()).unwrap();
        let session = create_session(
            &state,
            &hub,
            "ws_1".to_owned(),
            String::new(),
            "m".to_owned(),
            SessionCreateOptsWire::default(),
        )
        .unwrap();
        let push_rx = hub.subscribe_push();
        // Mark live so FlushBatches flow to this receiver — the same gating
        // the webview Channel subscription gets.
        hub.sink().subscribe_session(&session.id, None);
        Self {
            _dir: dir,
            state,
            hub,
            push_rx,
            session_id: session.id,
        }
    }

    fn args(&self, autonomy: &str) -> ChatRunTurnArgs {
        ChatRunTurnArgs {
            session_id: self.session_id.clone(),
            messages: vec![ChatTurnMessageWire {
                role: "user".to_owned(),
                content: "please".to_owned(),
            }],
            model_id: "m".to_owned(),
            provider_id: "p1".to_owned(),
            autonomy_mode: Some(autonomy.to_owned()),
            thinking_level: Some("medium".to_owned()),
        }
    }

    /// The command core with the fake engine + echo tool injected.
    async fn send(
        &self,
        autonomy: &str,
        engine: Arc<dyn StepStream>,
    ) -> Result<ChatSendResultWire, crate::commands::CommandError> {
        self.send_with_args(self.args(autonomy), engine).await
    }

    async fn send_with_args(
        &self,
        args: ChatRunTurnArgs,
        engine: Arc<dyn StepStream>,
    ) -> Result<ChatSendResultWire, crate::commands::CommandError> {
        start_turn(
            &self.state,
            &self.hub,
            args,
            engine,
            vec![Arc::new(EchoTool)],
        )
        .await
    }

    /// Drive `execute_turn` directly with a custom spec — the retry-delay
    /// seam (10s in production) is only reachable this way.
    async fn send_with_spec(&self, mut spec: TurnSpec, engine: Arc<dyn StepStream>) {
        spec.session_id = self.session_id.clone();
        orchestrator::persist_user_message(
            self.hub.writer(),
            self.hub.sink(),
            &self.session_id,
            &orchestrator::IncomingUserMessage {
                content: "please".to_owned(),
            },
        )
        .unwrap();
        let handle = self.hub.begin_turn(&self.session_id, AutonomyMode::Edit).unwrap();
        orchestrator::execute_turn(&self.hub, &spec, engine, Vec::new(), handle)
            .await
            .unwrap();
        self.hub.end_turn(&self.session_id);
    }

    /// Same as [`Fixture::send`], with the turn's tool registry overridden.
    async fn send_with_tools(
        &self,
        autonomy: &str,
        engine: Arc<dyn StepStream>,
        tools: Vec<Arc<dyn Tool>>,
    ) -> Result<ChatSendResultWire, crate::commands::CommandError> {
        start_turn(&self.state, &self.hub, self.args(autonomy), engine, tools).await
    }

    async fn next_agent_event(&mut self) -> AgentEvent {
        loop {
            match tokio::time::timeout(WAIT, self.push_rx.recv()).await {
                Ok(Ok(ChatPush::Agent { event })) => return event,
                Ok(Ok(ChatPush::Orchestrator { .. })) => continue,
                Ok(Ok(ChatPush::TodosUpdated { .. })) => continue,
                Ok(Err(e)) => panic!("broadcast ended: {e}"),
                Err(_) => panic!("timed out waiting for an agent event"),
            }
        }
    }

    /// Collect events through (and including) the turn_end.
    async fn events_until_turn_end(&mut self) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        loop {
            let event = self.next_agent_event().await;
            let end = matches!(event, AgentEvent::TurnEnd { .. });
            events.push(event);
            if end {
                return events;
            }
        }
    }

    async fn flush_batches(&mut self) -> Vec<tide_store::sessions_v2_write::FlushBatchWire> {
        let mut batches = Vec::new();
        while let Ok(push) = self.push_rx.try_recv() {
            if let ChatPush::Orchestrator { batch } = push {
                batches.push(batch);
            }
        }
        batches
    }

    fn read_window(&self) -> tide_store::sessions_v2::SessionMessagesPageV2 {
        let reader = tide_store::sessions_v2::SessionsV2::open(self.hub.db_path()).unwrap();
        reader
            .session_messages(&self.session_id, Default::default())
            .unwrap()
    }

    fn session_meta(&self) -> tide_store::sessions_v2::SessionMetaV2 {
        let workspace_path = self
            .hub
            .writer()
            .lock()
            .unwrap()
            .session_workspace_path(&self.session_id)
            .unwrap();
        tide_store::sessions_v2::SessionsV2::open(self.hub.db_path())
            .unwrap()
            .list_sessions(&workspace_path, Default::default())
            .unwrap()
            .sessions
            .into_iter()
            .find(|m| m.id == self.session_id)
            .unwrap()
    }

    fn kind(event: &AgentEvent) -> &'static str {
        match event {
            AgentEvent::Delta { .. } => "delta",
            AgentEvent::Reasoning { .. } => "reasoning",
            AgentEvent::ToolCallStart { .. } => "tool_call_start",
            AgentEvent::ToolCallDelta { .. } => "tool_call_delta",
            AgentEvent::ToolCall { .. } => "tool_call",
            AgentEvent::ToolExecuting { .. } => "tool_executing",
            AgentEvent::ToolResult { .. } => "tool_result",
            AgentEvent::Usage { .. } => "usage",
            AgentEvent::PermissionRequired { .. } => "permission_required",
            AgentEvent::FollowupRequired { .. } => "followup_required",
            AgentEvent::Compacting { .. } => "compacting",
            AgentEvent::Retry { .. } => "retry",
            AgentEvent::Error { .. } => "error",
            AgentEvent::TurnEnd { .. } => "turn_end",
        }
    }

    fn kinds(events: &[AgentEvent]) -> Vec<&'static str> {
        events.iter().map(Self::kind).collect()
    }

    /// Wait until the spawned turn task released the session lock.
    async fn wait_idle(&self) {
        for _ in 0..300 {
            if !self.hub.turn_active(&self.session_id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("turn never drained");
    }
}

// ── tests ───────────────────────────────────────────────────────────────────

/// Full happy turn: user → text → tool call (auto-approved in edit mode) →
/// result → final text → turn end. Asserts the event sequence, the FlushBatch
/// pushes, and the persisted rows read back through the v2 reader.
#[tokio::test]
async fn happy_turn_persists_and_streams() {
    let mut fx = Fixture::new("happy");
    let engine = ScriptedEngine::new(vec![
        vec![
            delta("Let me check."),
            Ok(EngineEvent::ToolCallStart {
                tool_call_id: "call_1".to_owned(),
                tool_name: "echo".to_owned(),
            }),
            Ok(EngineEvent::ToolCallDelta {
                tool_call_id: "call_1".to_owned(),
                delta: "{\"text\":\"hi\"".to_owned(),
            }),
            assembled_tool_call("call_1", serde_json::json!({ "text": "hi" })),
            usage(100),
            step_end(
                EngineStopReason::ToolUse,
                vec![call_part("call_1", serde_json::json!({ "text": "hi" }))],
            ),
        ],
        vec![
            delta("Done."),
            step_end(EngineStopReason::EndTurn, vec![text_part("Done.")]),
        ],
    ]);

    let result = fx.send("full", engine.clone()).await.unwrap();
    assert!(result.accepted, "{:?}", result.error);

    let events = fx.events_until_turn_end().await;
    assert_eq!(
        Fixture::kinds(&events),
        vec![
            "delta",
            "tool_call_start",
            "tool_call_delta",
            "tool_call",
            "usage",
            "tool_executing",
            "tool_result",
            "delta",
            "turn_end"
        ]
    );
    let AgentEvent::ToolResult { status, output, duration_ms, .. } = &events[6] else {
        panic!("tool_result at index 6");
    };
    assert_eq!(*status, OutcomeStatus::Executed);
    assert_eq!(output.as_deref(), Some("echo: hi"));
    assert!(duration_ms.is_some());

    let AgentEvent::TurnEnd {
        stop_reason,
        content,
        usage,
        tool_calls,
        timeline,
        ..
    } = &events[8]
    else {
        panic!("turn_end");
    };
    assert_eq!(*stop_reason, TurnStopReason::EndTurn);
    assert_eq!(content, "Let me check.Done.");
    assert_eq!(usage.as_ref().unwrap().input_tokens, 100);
    assert_eq!(usage.as_ref().unwrap().output_tokens, 50);
    assert_eq!(tool_calls.as_ref().unwrap().len(), 1);
    assert_eq!(timeline.as_ref().unwrap().len(), 3, "text + tool + trailing text");

    fx.wait_idle().await;
    fx.hub.sink().flush().await;

    // FlushBatch pushes flowed (live session): deltas, commits, message.end,
    // turn.end — all seq-stamped.
    let batches = fx.flush_batches().await;
    let all: Vec<_> = batches.iter().flat_map(|b| b.events.clone()).collect();
    for kind in ["part.delta", "part.commit", "message.end", "turn.end"] {
        assert!(
            all.iter().any(|e| e.r#type.as_str() == kind),
            "missing {kind} in pushes"
        );
    }
    assert!(all.iter().all(|e| e.seq.is_some()));

    // Persisted rows round-trip through the reader.
    let page = fx.read_window();
    assert_eq!(page.messages.len(), 2, "user + assistant");
    assert_eq!(page.messages[0].role, "user");
    assert_eq!(
        page.messages[0].parts[0].data,
        serde_json::json!({ "text": "please" })
    );
    let assistant = &page.messages[1];
    assert_eq!(assistant.role, "assistant");
    assert!(assistant.time_completed.is_some(), "message.end completed it");
    let part_kinds: Vec<&str> = assistant.parts.iter().map(|p| p.kind.as_str()).collect();
    assert_eq!(part_kinds, ["text", "tool", "text"]);
    assert_eq!(
        assistant.parts[0].data,
        serde_json::json!({ "text": "Let me check." })
    );
    assert_eq!(assistant.parts[1].data["toolName"], serde_json::json!("echo"));
    assert_eq!(assistant.parts[1].data["input"], serde_json::json!({ "text": "hi" }));
    assert_eq!(assistant.parts[1].data["output"], serde_json::json!("echo: hi"));
    assert_eq!(assistant.parts[1].data["status"], serde_json::json!("executed"));
    assert_eq!(
        assistant.parts[2].data,
        serde_json::json!({ "text": "Done." })
    );

    // Session usage rolled up from message.end.
    let meta = fx.session_meta();
    assert_eq!(meta.tokens_input, 100);
    assert_eq!(meta.tokens_output, 50);

    // Pruning: every DELIVERED batch below the floor is gone; the final
    // flush's events (committed in the same transaction as the turn.end
    // prune, seqs above the floor) survive until the NEXT turn.end — the TS
    // semantics. The marker itself always survives.
    let replay = fx
        .hub
        .writer()
        .lock()
        .unwrap()
        .replay_events(&fx.session_id, 0, None)
        .unwrap();
    let kinds: Vec<&str> = replay.iter().map(|e| e.r#type.as_str()).collect();
    assert!(
        kinds.last() == Some(&"turn.end"),
        "turn.end marker survives: {kinds:?}"
    );

    // Exactly two engine calls; the second carried history + the failed-
    // step's assistant message + the user-side tool result; the system
    // prompt and tool specs were offered.
    let requests = engine.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].params.system.as_deref().unwrap().contains("You are Tide"));
    assert_eq!(
        requests[0].tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        vec!["echo"]
    );
    assert_eq!(
        requests[1].messages.len(),
        3,
        "user + step-1 assistant + user-side tool result"
    );
    let last = requests[1].messages.last().unwrap();
    assert_eq!(last.role, HistoryRole::User);
    assert!(matches!(
        last.parts[0],
        HistoryPart::ToolResult { ref tool_name, .. } if tool_name == "echo"
    ));
}

/// Deny by project rule: the tool never executes; the model sees a rejected
/// result and the loop continues to the final step.
#[tokio::test]
async fn deny_by_rule_rejects_and_continues() {
    let mut fx = Fixture::with_workspace_files(
        "deny",
        &[(".agents/settings.json", r#"{"permissions":{"deny":["echo"]}}"#)],
    );
    let engine = ScriptedEngine::new(vec![
        vec![
            assembled_tool_call("call_1", serde_json::json!({ "text": "nope" })),
            step_end(
                EngineStopReason::ToolUse,
                vec![call_part("call_1", serde_json::json!({ "text": "nope" }))],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("full", engine).await.unwrap();
    assert!(result.accepted, "{:?}", result.error);

    let events = fx.events_until_turn_end().await;
    assert_eq!(
        Fixture::kinds(&events),
        vec!["tool_call", "tool_result", "turn_end"]
    );
    let AgentEvent::ToolResult { status, output, .. } = &events[1] else {
        panic!("tool_result");
    };
    assert_eq!(*status, OutcomeStatus::Rejected);
    assert!(output.as_deref().unwrap().contains("Denied by permission rule"));

    fx.wait_idle().await;
    fx.hub.sink().flush().await;
    let page = fx.read_window();
    let assistant = page
        .messages
        .iter()
        .find(|m| m.role == "assistant")
        .expect("assistant message");
    let tool_part = &assistant.parts[0];
    assert_eq!(tool_part.kind, "tool");
    assert_eq!(tool_part.data["status"], serde_json::json!("rejected"));
}

/// Ask path — approve + remember: the card carries the pending status and
/// rule spec; the answer executes the tool; the remembered rule un-gates the
/// second identical call (no second card).
#[tokio::test]
async fn ask_path_approve_remember_and_escalate() {
    let mut fx = Fixture::new("ask-approve");
    let engine = ScriptedEngine::new(vec![
        vec![
            assembled_tool_call("call_1", serde_json::json!({ "text": "a" })),
            step_end(
                EngineStopReason::ToolUse,
                vec![call_part("call_1", serde_json::json!({ "text": "a" }))],
            ),
        ],
        vec![
            assembled_tool_call("call_2", serde_json::json!({ "text": "b" })),
            step_end(
                EngineStopReason::ToolUse,
                vec![call_part("call_2", serde_json::json!({ "text": "b" }))],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("ask", engine).await.unwrap();
    assert!(result.accepted, "{:?}", result.error);

    // First gated call: the assembled tool_call lands, THEN the card.
    let card = loop {
        match fx.next_agent_event().await {
            card @ AgentEvent::PermissionRequired { .. } => break card,
            AgentEvent::ToolCall { .. } => continue,
            other => panic!("expected permission_required, got {}", Fixture::kind(&other)),
        }
    };
    let AgentEvent::PermissionRequired { tool_calls, timeout_at, .. } = card else {
        unreachable!()
    };
    assert_eq!(tool_calls[0].id, "call_1");
    assert_eq!(tool_calls[0].status, "pending");
    assert_eq!(tool_calls[0].gate_decision, Some("ask"));
    assert_eq!(tool_calls[0].allow_rule.as_deref(), Some("echo"));
    assert!(timeout_at > 0);

    // Approve with remember → the rule sticks; the second call must NOT ask.
    respond_permission(
        &fx.hub,
        PermissionRespondArgs {
            session_id: fx.session_id.clone(),
            tool_call_ids: vec!["call_1".to_owned()],
            approve: true,
            remember: Some(true),
            new_mode: None,
            reason: None,
        },
    );

    let events = fx.events_until_turn_end().await;
    assert_eq!(
        Fixture::kinds(&events),
        vec![
            "tool_executing",
            "tool_result",
            "tool_call",
            "tool_executing",
            "tool_result",
            "turn_end"
        ],
        "no second permission_required"
    );
    let AgentEvent::ToolResult { status, output, .. } = &events[4] else {
        panic!("second result");
    };
    assert_eq!(*status, OutcomeStatus::Executed);
    assert_eq!(output.as_deref(), Some("echo: b"));
}

/// Ask path — reject: the answer's reason rides the rejected tool result.
#[tokio::test]
async fn ask_path_reject_denies_with_reason() {
    let mut fx = Fixture::new("ask-reject");
    let engine = ScriptedEngine::new(vec![
        vec![
            assembled_tool_call("call_1", serde_json::json!({ "text": "x" })),
            step_end(
                EngineStopReason::ToolUse,
                vec![call_part("call_1", serde_json::json!({ "text": "x" }))],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("ask", engine).await.unwrap();
    assert!(result.accepted, "{:?}", result.error);

    loop {
        match fx.next_agent_event().await {
            AgentEvent::PermissionRequired { .. } => break,
            AgentEvent::ToolCall { .. } => continue,
            other => panic!("expected permission_required, got {}", Fixture::kind(&other)),
        }
    }
    respond_permission(
        &fx.hub,
        PermissionRespondArgs {
            session_id: fx.session_id.clone(),
            tool_call_ids: vec!["call_1".to_owned()],
            approve: false,
            remember: None,
            new_mode: None,
            reason: Some("not today".to_owned()),
        },
    );

    let events = fx.events_until_turn_end().await;
    let AgentEvent::ToolResult { status, output, .. } = &events[0] else {
        panic!("tool_result after card + reject: {:?}", Fixture::kinds(&events));
    };
    assert_eq!(*status, OutcomeStatus::Rejected);
    assert_eq!(output.as_deref(), Some("not today"));
    let AgentEvent::TurnEnd { stop_reason, tool_calls, .. } = events.last().unwrap() else {
        unreachable!()
    };
    assert_eq!(*stop_reason, TurnStopReason::EndTurn);
    assert_eq!(tool_calls.as_ref().unwrap()[0].status, "rejected");
}

/// Abort mid-stream: the pending stream is dropped, the partial text part
/// stays persisted, and turn_end(aborted) closes the turn.
#[tokio::test]
async fn abort_mid_stream_closes_with_partial_persistence() {
    let mut fx = Fixture::new("abort");
    let engine: Arc<dyn StepStream> = Arc::new(PausingEngine);
    let result = fx.send("edit", engine).await.unwrap();
    assert!(result.accepted, "{:?}", result.error);

    let first = fx.next_agent_event().await;
    assert!(matches!(first, AgentEvent::Delta { ref text, .. } if text == "partial "));
    fx.hub.abort_turn(&fx.session_id);

    let events = fx.events_until_turn_end().await;
    assert_eq!(Fixture::kinds(&events), vec!["turn_end"]);
    let AgentEvent::TurnEnd { stop_reason, content, .. } = events.last().unwrap() else {
        panic!("turn_end");
    };
    assert_eq!(*stop_reason, TurnStopReason::Aborted);
    assert_eq!(content, "partial ");

    fx.wait_idle().await;
    fx.hub.sink().flush().await;
    let page = fx.read_window();
    let assistant = &page.messages[1];
    assert!(assistant.time_completed.is_some(), "message.end landed");
    assert_eq!(
        assistant.parts[0].data,
        serde_json::json!({ "text": "partial " }),
        "the partial part committed at turn close"
    );
}

/// Retry semantics — transient failures: `retry` events between attempts, NO
/// error events mid-way, one `error` exactly at exhaustion, then
/// turn_end(refusal). 11 attempts total (initial + 10 retries), and the
/// failed attempt's partial message is rolled back before the retry.
#[tokio::test]
async fn retry_exhaustion_emits_error_only_at_the_end() {
    let mut fx = Fixture::new("retry");
    // Initial call + 10 retries, each: one streamed delta (partial), then
    // the failure — the engine's held-error shape.
    let steps: Vec<StepScript> = (0..=RETRIES)
        .map(|_| {
            vec![
                delta("partial "),
                Err(transient_failure()),
                step_end(EngineStopReason::ToolUse, vec![text_part("partial ")]),
            ]
        })
        .collect();
    let engine = ScriptedEngine::new(steps);
    let spec = TurnSpec {
        retry_delay: Duration::from_millis(5),
        ..Default::default()
    };
    fx.send_with_spec(spec, engine.clone()).await;

    let events = fx.events_until_turn_end().await;
    // Partial deltas stream before each failure; the CONTROL subsequence is
    // exactly retry x10, one error, turn_end — never an error mid-retries.
    let kinds: Vec<&str> = Fixture::kinds(&events)
        .into_iter()
        .filter(|k| *k != "delta")
        .collect();
    assert_eq!(kinds.len(), 12, "10 retries + error + turn_end: {kinds:?}");
    assert_eq!(kinds[10], "error");
    assert_eq!(kinds[11], "turn_end");
    let retries = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Retry { .. }));
    for (i, event) in retries.enumerate() {
        let AgentEvent::Retry { attempt, max_attempts, reason, .. } = event else {
            unreachable!();
        };
        assert_eq!(*attempt as usize, i + 1);
        assert_eq!(*max_attempts as usize, RETRIES);
        assert!(reason.contains("connection reset"));
    }
    let AgentEvent::TurnEnd { stop_reason, .. } = events.last().unwrap() else {
        panic!("turn_end");
    };
    assert_eq!(*stop_reason, TurnStopReason::Refusal);

    // Every retried attempt sent the SAME history (partial step rolled
    // back), and the count is exactly 11.
    let requests = engine.requests();
    assert_eq!(requests.len(), RETRIES + 1);
    let first_len = requests[0].messages.len();
    assert!(
        requests.iter().all(|r| r.messages.len() == first_len),
        "failed attempts never grow the history"
    );
}

/// Non-transient failures (auth) never retry: error + turn_end immediately.
#[tokio::test]
async fn non_transient_error_skips_retries() {
    let mut fx = Fixture::new("no-retry");
    let engine = ScriptedEngine::new(vec![vec![
        delta("never "),
        Err(auth_failure()),
        step_end(EngineStopReason::ToolUse, vec![text_part("never ")]),
    ]]);
    let spec = TurnSpec {
        retry_delay: Duration::from_millis(5),
        ..Default::default()
    };
    fx.send_with_spec(spec, engine).await;

    let events = fx.events_until_turn_end().await;
    assert_eq!(Fixture::kinds(&events), vec!["delta", "error", "turn_end"]);
    let AgentEvent::Error { message, .. } = &events[1] else {
        panic!("error");
    };
    assert!(message.contains("401"));
}

/// Two sessions stream concurrently through one hub; a second turn on the
/// SAME session is refused while the first is active, and accepted again
/// after it drains.
#[tokio::test]
async fn two_sessions_run_concurrently_same_session_refused() {
    let mut fx = Fixture::new("concurrent");
    let engine = ScriptedEngine::new(vec![
        vec![
            delta("one "),
            step_end(EngineStopReason::EndTurn, vec![text_part("one ")]),
        ],
        vec![
            delta("two "),
            step_end(EngineStopReason::EndTurn, vec![text_part("two ")]),
        ],
    ]);

    // First turn accepted and holds the session.
    let first = fx.send("edit", engine.clone()).await.unwrap();
    assert!(first.accepted);

    // Same session while active → pre-flight rejection, nothing spawned.
    let second = fx.send("edit", engine.clone()).await.unwrap();
    assert!(!second.accepted);
    assert!(second.error.unwrap().contains("already active"));

    // A different session streams concurrently to completion.
    let other = create_session(
        &fx.state,
        &fx.hub,
        "ws_1".to_owned(),
        String::new(),
        "m".to_owned(),
        SessionCreateOptsWire::default(),
    )
    .unwrap();
    fx.hub.sink().subscribe_session(&other.id, None);
    let mut other_args = fx.args("edit");
    other_args.session_id = other.id.clone();
    let other_result = start_turn(
        &fx.state,
        &fx.hub,
        other_args,
        engine,
        vec![Arc::new(EchoTool)],
    )
    .await
    .unwrap();
    assert!(other_result.accepted);

    // Drain both: the shared receiver interleaves both sessions' events.
    let mut seen_first = false;
    let mut seen_other = false;
    let mut guard = 0;
    while !(seen_first || seen_other) {
        guard += 1;
        assert!(guard < 200, "never saw a turn_end");
        let event = fx.next_agent_event().await;
        if let AgentEvent::TurnEnd { session_id, .. } = &event {
            if *session_id == fx.session_id {
                seen_first = true;
            }
            if *session_id == other.id {
                seen_other = true;
            }
        }
    }
    fx.wait_idle().await;

    // After the drain, the session accepts a new turn again.
    assert!(!fx.hub.turn_active(&fx.session_id));
}

/// Command pre-flight: unknown provider, unknown session, and missing
/// session row all reject with `{accepted: false}` — nothing spawns.
#[tokio::test]
async fn pre_flight_rejections() {
    let fx = Fixture::new("preflight");
    let engine = ScriptedEngine::new(vec![]);

    // The TS resolution order: pinned providerId first, then any enabled
    // provider serving the modelId — "ghost" + known model still resolves.
    let mut args = fx.args("edit");
    args.model_id = "nope".to_owned();
    args.provider_id = "ghost".to_owned();
    let result = fx.send_with_args(args, engine.clone()).await.unwrap();
    assert!(!result.accepted);
    assert!(result.error.unwrap().contains("Provider ghost not found"));

    let mut args = fx.args("edit");
    args.session_id = "s_ghost".to_owned();
    let result = fx.send_with_args(args, engine).await.unwrap();
    assert!(!result.accepted);
    assert!(result.error.unwrap().contains("Session s_ghost not found"));
    assert!(!fx.hub.turn_active(&fx.session_id));
}



// ── todo_write side-channel ─────────────────────────────────────────────────

/// A todo_write tool call mid-turn must (a) execute through the shared
/// TodoState, (b) push a ChatPush::TodosUpdated the bridge can route to the
/// renderer's `todosUpdated` consumers, wire-shaped like the TS
/// TodosUpdatedEvent.
#[tokio::test]
async fn todo_write_turn_pushes_todos_updated() {
    let mut fx = Fixture::new("todo-push");
    let todo_args = serde_json::json!({
        "todos": [
            { "content": "Port the tool", "status": "completed" },
            { "content": "Wire the push", "status": "in_progress" }
        ]
    });
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_todo".to_owned(),
                tool_name: "todo_write".to_owned(),
                arguments: todo_args.clone(),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_todo".to_owned(),
                    tool_name: "todo_write".to_owned(),
                    arguments: todo_args,
                }],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);

    let result = fx
        .send_with_tools("edit", engine, vec![Arc::new(tide_tools::TodoWriteTool)])
        .await
        .unwrap();
    assert!(result.accepted, "{:?}", result.error);

    // The push side: fish the TodosUpdated push out of the channel.
    let push = loop {
        match tokio::time::timeout(WAIT, fx.push_rx.recv()).await {
            Ok(Ok(push @ ChatPush::TodosUpdated { .. })) => break push,
            Ok(Ok(_)) => continue,
            Ok(Err(e)) => panic!("broadcast ended: {e}"),
            Err(_) => panic!("timed out waiting for the todosUpdated push"),
        }
    };
    let ChatPush::TodosUpdated { event } = push else {
        unreachable!();
    };
    assert_eq!(event.session_id, fx.session_id);
    assert_eq!(event.todos.len(), 2);
    assert_eq!(event.todos[1].status, tide_tools::TodoStatus::InProgress);

    // Wire shape matches the TS TodosUpdatedEvent (channel tag + camelCase).
    let wire = serde_json::to_value(&ChatPush::TodosUpdated { event }).unwrap();
    assert_eq!(wire["channel"], serde_json::json!("todosUpdated"));
    assert_eq!(wire["event"]["sessionId"], serde_json::json!(fx.session_id));
    assert_eq!(wire["event"]["todos"][1]["status"], serde_json::json!("in_progress"));

    // The store side (post-push, so the tool call has landed): the
    // session's list is the full replacement.
    assert_eq!(fx.hub.todo_state().todos(&fx.session_id).len(), 2);

    // Drain to turn_end so the sink settles before the fixture drops.
    let _ = fx.events_until_turn_end().await;
}

// ── T7: turn-flow tools ─────────────────────────────────────────────────────

/// The followup popup path end-to-end: model calls ask_followup_question →
/// `followup_required` event (wire-shaped) → the turn parks →
/// chat_submit_followup resolves the pick → the tool result carries the
/// answer → the turn continues to turn_end.
#[tokio::test]
async fn followup_happy_path_parks_and_resumes_on_answer() {
    let mut fx = Fixture::new("followup");
    let args = serde_json::json!({
        "question": "Which approach?",
        "options": [
            { "label": "SQLite", "description": "local" },
            { "label": "Postgres" }
        ]
    });
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_f".to_owned(),
                tool_name: "ask_followup_question".to_owned(),
                arguments: args.clone(),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_f".to_owned(),
                    tool_name: "ask_followup_question".to_owned(),
                    arguments: args,
                }],
            ),
        ],
        vec![delta("Proceeding."), step_end(EngineStopReason::EndTurn, vec![text_part("Proceeding.")])],
    ]);
    let result = fx
        .send_with_tools("edit", engine, vec![Arc::new(tide_tools::AskFollowupTool)])
        .await
        .unwrap();
    assert!(result.accepted, "{:?}", result.error);

    // tool_executing, then the picker event with the TS wire shape.
    let followup = loop {
        match fx.next_agent_event().await {
            event @ AgentEvent::FollowupRequired { .. } => break event,
            AgentEvent::ToolCall { .. } | AgentEvent::ToolExecuting { .. } => continue,
            other => panic!("unexpected {}", Fixture::kind(&other)),
        }
    };
    let AgentEvent::FollowupRequired {
        tool_call_id,
        question,
        options,
        option_descriptions,
        multiple,
        ..
    } = followup
    else {
        panic!("followup_required, got {}", Fixture::kind(&followup));
    };
    assert_eq!(tool_call_id, "call_f");
    assert_eq!(question, "Which approach?");
    assert_eq!(options, vec!["SQLite".to_owned(), "Postgres".to_owned()]);
    assert_eq!(
        option_descriptions,
        vec![Some("local".to_owned()), None]
    );
    assert!(!multiple);
    let wire = serde_json::to_value(&AgentEvent::FollowupRequired {
        session_id: fx.session_id.clone(),
        seq: 0,
        tool_call_id,
        question,
        options,
        option_descriptions,
        multiple,
    })
    .unwrap();
    assert_eq!(wire["type"], serde_json::json!("followup_required"));
    assert_eq!(wire["optionDescriptions"][0], serde_json::json!("local"));
    assert_eq!(wire["optionDescriptions"][1], serde_json::json!(null));

    // The turn is parked: nothing flows until the answer arrives.
    assert!(fx.push_rx.is_empty());

    // The renderer's popup resolves via the command core.
    let answered = crate::commands::chat::resolve_followup_core(
        &fx.hub,
        &crate::commands::chat::ChatSubmitFollowupArgs {
            session_id: fx.session_id.clone(),
            tool_call_id: "call_f".to_owned(),
            answer: "SQLite".to_owned(),
        },
    );
    assert!(answered.resolved);

    let events = fx.events_until_turn_end().await;
    let tool_result = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { .. }))
        .expect("tool_result");
    let AgentEvent::ToolResult { status, output, display, .. } = tool_result else {
        unreachable!();
    };
    assert_eq!(*status, OutcomeStatus::Executed);
    assert_eq!(output.as_deref(), Some("User picked: SQLite"));
    let Some(tide_tools::ToolDisplay::Text { text }) = display else {
        panic!("text display");
    };
    assert_eq!(text, "**SQLite**");

    // A duplicate submit for the same (now resolved) ask reports stale.
    let stale = crate::commands::chat::resolve_followup_core(
        &fx.hub,
        &crate::commands::chat::ChatSubmitFollowupArgs {
            session_id: fx.session_id.clone(),
            tool_call_id: "call_f".to_owned(),
            answer: "SQLite".to_owned(),
        },
    );
    assert!(!stale.resolved);
}

/// Aborting a parked followup resolves it unanswered: the tool result is
/// the rejected "did not answer" fallback and the turn closes aborted.
#[tokio::test]
async fn followup_abort_resolves_unanswered() {
    let mut fx = Fixture::new("followup-abort");
    let engine = ScriptedEngine::new(vec![vec![
        Ok(EngineEvent::ToolCall {
            tool_call_id: "call_f".to_owned(),
            tool_name: "ask_followup_question".to_owned(),
            arguments: serde_json::json!({ "question": "Q?" }),
        }),
        step_end(
            EngineStopReason::ToolUse,
            vec![HistoryPart::ToolCall {
                id: "call_f".to_owned(),
                tool_name: "ask_followup_question".to_owned(),
                arguments: serde_json::json!({ "question": "Q?" }),
            }],
        ),
    ]]);
    let result = fx
        .send_with_tools("edit", engine, vec![Arc::new(tide_tools::AskFollowupTool)])
        .await
        .unwrap();
    assert!(result.accepted, "{:?}", result.error);

    loop {
        match fx.next_agent_event().await {
            AgentEvent::FollowupRequired { .. } => break,
            AgentEvent::ToolCall { .. } | AgentEvent::ToolExecuting { .. } => continue,
            other => panic!("unexpected {}", Fixture::kind(&other)),
        }
    }
    fx.hub.abort_turn(&fx.session_id);

    let events = fx.events_until_turn_end().await;
    let tool_result = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { .. }))
        .expect("tool_result");
    let AgentEvent::ToolResult { status, output, .. } = tool_result else {
        unreachable!();
    };
    assert_eq!(*status, OutcomeStatus::Rejected);
    assert_eq!(output.as_deref(), Some("User did not answer the question."));
}

/// exit_plan_mode in plan mode: a permission card carries the plan for
/// approval; approving with `new_mode` escalates the turn out of plan mode
/// (the next write-tier call runs un-gated) and the tool result uses the
/// TS presentation.
#[tokio::test]
async fn exit_plan_mode_approval_escalates_the_turn() {
    let mut fx = Fixture::new("plan-exit");
    let plan_args = serde_json::json!({ "plan": "1. Do the thing\n2. Verify" });
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_p".to_owned(),
                tool_name: "exit_plan_mode".to_owned(),
                arguments: plan_args.clone(),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_p".to_owned(),
                    tool_name: "exit_plan_mode".to_owned(),
                    arguments: plan_args,
                }],
            ),
        ],
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_w".to_owned(),
                tool_name: "write_file".to_owned(),
                arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_w".to_owned(),
                    tool_name: "write_file".to_owned(),
                    arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
                }],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx
        .send_with_tools(
            "plan",
            engine,
            vec![Arc::new(tide_tools::ExitPlanModeTool), Arc::new(FakeWriteTool)],
        )
        .await
        .unwrap();
    assert!(result.accepted, "{:?}", result.error);

    // The plan-approval card.
    let card = loop {
        match fx.next_agent_event().await {
            card @ AgentEvent::PermissionRequired { .. } => break card,
            AgentEvent::ToolCall { .. } | AgentEvent::ToolExecuting { .. } => continue,
            other => panic!("unexpected {}", Fixture::kind(&other)),
        }
    };
    let AgentEvent::PermissionRequired { tool_calls, timeout_at, .. } = card else {
        unreachable!();
    };
    assert_eq!(tool_calls[0].id, "call_p");
    assert_eq!(tool_calls[0].tool_name, "exit_plan_mode");
    assert_eq!(tool_calls[0].status, "pending");
    assert_eq!(tool_calls[0].gate_decision, Some("ask"));
    assert!(timeout_at > 0);

    // Approve WITH the mode escalation — the plan-mode write gate opens.
    respond_permission(
        &fx.hub,
        PermissionRespondArgs {
            session_id: fx.session_id.clone(),
            tool_call_ids: vec!["call_p".to_owned()],
            approve: true,
            remember: None,
            new_mode: Some("edit".to_owned()),
            reason: None,
        },
    );

    let events = fx.events_until_turn_end().await;
    let plan_result = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_p"))
        .expect("plan tool_result");
    let AgentEvent::ToolResult { status, output, display, meta, .. } = plan_result else {
        unreachable!();
    };
    assert_eq!(*status, OutcomeStatus::Executed);
    assert_eq!(
        output.as_deref(),
        Some("Plan submitted. Waiting for user approval — if approved, switch to a write-enabled mode and proceed.")
    );
    assert_eq!(meta.as_deref(), Some("plan ready"));
    let Some(tide_tools::ToolDisplay::Text { text }) = display else {
        panic!("text display");
    };
    assert_eq!(text, "1. Do the thing\n2. Verify");

    // The escalated write-tier call ran WITHOUT a second permission card
    // (plan mode would have blocked it outright).
    let write_result = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_w"))
        .expect("write tool_result");
    let AgentEvent::ToolResult { status, output, .. } = write_result else {
        unreachable!();
    };
    assert_eq!(*status, OutcomeStatus::Executed);
    assert_eq!(output.as_deref(), Some("fake write done"));
    assert!(!events
        .iter()
        .any(|e| matches!(e, AgentEvent::PermissionRequired { .. })), "no second card");
}

/// Denying the plan card rejects the tool result with the user's reason.
#[tokio::test]
async fn exit_plan_mode_denial_rejects_with_reason() {
    let mut fx = Fixture::new("plan-deny");
    let plan_args = serde_json::json!({ "plan": "Risky plan" });
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_p".to_owned(),
                tool_name: "exit_plan_mode".to_owned(),
                arguments: plan_args.clone(),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_p".to_owned(),
                    tool_name: "exit_plan_mode".to_owned(),
                    arguments: plan_args,
                }],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx
        .send_with_tools("plan", engine, vec![Arc::new(tide_tools::ExitPlanModeTool)])
        .await
        .unwrap();
    assert!(result.accepted, "{:?}", result.error);

    loop {
        match fx.next_agent_event().await {
            AgentEvent::PermissionRequired { .. } => break,
            AgentEvent::ToolCall { .. } | AgentEvent::ToolExecuting { .. } => continue,
            other => panic!("unexpected {}", Fixture::kind(&other)),
        }
    }
    respond_permission(
        &fx.hub,
        PermissionRespondArgs {
            session_id: fx.session_id.clone(),
            tool_call_ids: vec!["call_p".to_owned()],
            approve: false,
            remember: None,
            new_mode: None,
            reason: Some("plan is too risky".to_owned()),
        },
    );

    let events = fx.events_until_turn_end().await;
    let AgentEvent::ToolResult { status, output, .. } = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { .. }))
        .expect("tool_result")
    else {
        unreachable!();
    };
    assert_eq!(*status, OutcomeStatus::Rejected);
    assert_eq!(output.as_deref(), Some("plan is too risky"));
}

/// Outside plan mode the call is the TS no-op: direct presentation, no card.
#[tokio::test]
async fn exit_plan_mode_outside_plan_mode_is_a_no_op() {
    let mut fx = Fixture::new("plan-noop");
    let plan_args = serde_json::json!({ "plan": "Already editing" });
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_p".to_owned(),
                tool_name: "exit_plan_mode".to_owned(),
                arguments: plan_args.clone(),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_p".to_owned(),
                    tool_name: "exit_plan_mode".to_owned(),
                    arguments: plan_args,
                }],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx
        .send_with_tools("edit", engine, vec![Arc::new(tide_tools::ExitPlanModeTool)])
        .await
        .unwrap();
    assert!(result.accepted, "{:?}", result.error);

    let events = fx.events_until_turn_end().await;
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::PermissionRequired { .. })));
    let AgentEvent::ToolResult { status, .. } = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { .. }))
        .expect("tool_result")
    else {
        unreachable!();
    };
    assert_eq!(*status, OutcomeStatus::Executed);
}

// ── T7: compact / auto-compact ──────────────────────────────────────────────

fn tiny_compaction() -> crate::agent::auto_compact::AutoCompactConfig {
    use crate::agent::auto_compact::AutoCompactConfig;
    AutoCompactConfig {
        context_window: 900,
        max_input_tokens: 0,
        max_output_tokens: 100,
        threshold: 0.1,
        keep_recent_turns: 3,
        on_failure_truncate: true,
    }
}

/// One scripted summary step (what StepStreamSummarizer drives).
fn summary_step(text: &str) -> StepScript {
    vec![
        delta(text),
        step_end(EngineStopReason::EndTurn, vec![text_part(text)]),
    ]
}

/// The manual `compact` tool: the orchestrator intercepts the call, runs
/// the shared compaction path (Compacting start+finish events, the
/// engine's follow-up request carrying the summary message), and returns
/// the TS stub result.
#[tokio::test]
async fn compact_tool_runs_the_shared_compaction_path() {
    let mut fx = Fixture::new("compact-tool");
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_c".to_owned(),
                tool_name: "compact".to_owned(),
                arguments: serde_json::json!({ "keep_last": 2 }),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_c".to_owned(),
                    tool_name: "compact".to_owned(),
                    arguments: serde_json::json!({ "keep_last": 2 }),
                }],
            ),
        ],
        summary_step("## Goal\n- done"),
        vec![delta("ok"), step_end(EngineStopReason::EndTurn, vec![text_part("ok")])],
    ]);
    // High threshold so the loop-top estimate check stays quiet — the TOOL
    // call drives the compaction, not the auto path.
    let spec = TurnSpec {
        compaction: Some(crate::agent::auto_compact::AutoCompactConfig {
            context_window: 500_000,
            max_input_tokens: 0,
            max_output_tokens: 8_192,
            threshold: 0.99,
            ..tiny_compaction()
        }),
        ..Default::default()
    };
    seed_history_message(&fx, "user", &bulky_text("first "));
    seed_history_message(&fx, "assistant", &bulky_text("old "));
    fx.send_with_spec(spec, engine.clone()).await;

    let events = fx.events_until_turn_end().await;
    // Two compacting events: start (no tokensAfter) then completion.
    let compacting: Vec<&AgentEvent> = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Compacting { .. }))
        .collect();
    assert_eq!(compacting.len(), 2, "{:?}", Fixture::kinds(&events));
    let AgentEvent::Compacting { tokens_after, forced, .. } = compacting[0] else {
        unreachable!();
    };
    assert!(tokens_after.is_none());
    assert!(!forced);
    let AgentEvent::Compacting { tokens_after, forced, .. } = compacting[1] else {
        unreachable!();
    };
    assert!(tokens_after.is_some());
    assert!(!forced);

    // The stub result the TS tool returned.
    let AgentEvent::ToolResult { status, output, meta, .. } = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { .. }))
        .expect("tool_result")
    else {
        unreachable!();
    };
    assert_eq!(*status, OutcomeStatus::Executed);
    assert_eq!(output.as_deref(), Some("Done. Continue with your current task."));
    assert_eq!(meta.as_deref(), Some("keep last 2"));

    // Engine calls: model step, summarizer (tools-free), final model step
    // whose history now leads with the summary marker message.
    let requests = engine.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].tools.is_empty(), "summarizer offers no tools");
    let Some(system) = requests[1].params.system.as_deref() else {
        panic!("summarizer system prompt");
    };
    assert!(system.contains("conversation summarizer"));
    let last_messages = &requests[2].messages;
    let HistoryPart::Text { text } = &last_messages[0].parts[0] else {
        panic!("text part");
    };
    assert!(text.starts_with("[Compacted context — structured summary of"));
    assert!(text.contains("## Goal\n- done"));
    assert_eq!(last_messages[0].role, HistoryRole::User);
}

/// Loop-top auto-compact: once the last step's reported input tokens cross
/// the threshold, the next engine request carries the compacted history.
#[tokio::test]
async fn auto_compact_fires_between_steps_on_usage_tokens() {
    let mut fx = Fixture::new("auto-compact");
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_1".to_owned(),
                tool_name: "write_file".to_owned(),
                arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
            }),
            usage(90_000),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_1".to_owned(),
                    tool_name: "write_file".to_owned(),
                    arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
                }],
            ),
        ],
        summary_step("## Goal\n- smaller"),
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let spec = TurnSpec {
        compaction: Some(crate::agent::auto_compact::AutoCompactConfig {
            context_window: 100_000,
            max_input_tokens: 0,
            max_output_tokens: 8_192,
            threshold: 0.75,
            ..tiny_compaction()
        }),
        ..Default::default()
    };
    seed_history_message(&fx, "user", &bulky_text("early "));
    seed_history_message(&fx, "assistant", &bulky_text("older "));
    fx.send_with_spec(spec, engine.clone()).await;

    let events = fx.events_until_turn_end().await;
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Compacting { forced: false, .. })));

    let requests = engine.requests();
    assert_eq!(requests.len(), 3);
    // The post-compaction model request leads with the summary message.
    let HistoryPart::Text { text } = &requests[2].messages[0].parts[0] else {
        panic!("text part");
    };
    assert!(text.starts_with("[Compacted context"));
}

/// The /compact path: the renderer's `[[FORCE_COMPACT]]` marker is stripped
/// and compaction runs (forced) before the model ever responds.
#[tokio::test]
async fn force_compact_marker_compacts_before_the_first_step() {
    let mut fx = Fixture::new("force-compact");
    let mut args = fx.args("edit");
    args.messages = vec![ChatTurnMessageWire {
        role: "user".to_owned(),
        content: "[[FORCE_COMPACT]]Summarize our conversation so far.".to_owned(),
    }];
    let engine = ScriptedEngine::new(vec![
        summary_step("## Goal\n- forced"),
        vec![delta("done"), step_end(EngineStopReason::EndTurn, vec![text_part("done")])],
    ]);
    seed_history_message(&fx, "user", &bulky_text("early "));
    seed_history_message(&fx, "assistant", &bulky_text("older "));
    let result = fx.send_with_args(args, engine.clone()).await.unwrap();
    assert!(result.accepted, "{:?}", result.error);

    let events = fx.events_until_turn_end().await;
    let compacting: Vec<&AgentEvent> = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Compacting { .. }))
        .collect();
    assert_eq!(compacting.len(), 2);
    assert!(matches!(compacting[0], AgentEvent::Compacting { forced: true, .. }));

    // The model's first request: marker stripped from the user message,
    // summary message leading.
    let requests = engine.requests();
    assert_eq!(requests.len(), 2);
    let model_request = &requests[1];
    let HistoryPart::Text { text } = &model_request.messages[0].parts[0] else {
        panic!("text part");
    };
    assert!(text.starts_with("[Compacted context"));
    let HistoryPart::Text { text } = model_request.messages.last().unwrap().parts.last().unwrap()
    else {
        panic!("text part");
    };
    assert_eq!(text, "Summarize our conversation so far.");
    assert!(!text.contains("FORCE_COMPACT"));
}

/// A context-overflow error forces compaction (max 3 per turn), replays the
/// user's request, and retries instead of failing the turn.
#[tokio::test]
async fn overflow_error_forces_compaction_and_replays_the_request() {
    let mut fx = Fixture::new("overflow");
    // Step 1 succeeds with a bulky tool result; step 2 overflows.
    let bulky = "x".repeat(120_000);
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_b".to_owned(),
                tool_name: "write_file".to_owned(),
                arguments: serde_json::json!({ "path": "a.txt", "content": &bulky[..20] }),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_b".to_owned(),
                    tool_name: "write_file".to_owned(),
                    arguments: serde_json::json!({ "path": "a.txt", "content": &bulky[..20] }),
                }],
            ),
        ],
        vec![Err(EngineError::Config(
            "prompt too long: 200000 tokens > 128000 limit".to_owned(),
        ))],
        summary_step("## Goal\n- shrunk"),
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    // Tool output big enough to prune; threshold high enough that the
    // loop-top estimate check stays quiet (the overflow drives this).
    let spec = TurnSpec {
        session_id: fx.session_id.clone(),
        compaction: Some(crate::agent::auto_compact::AutoCompactConfig {
            context_window: 500_000,
            max_input_tokens: 0,
            max_output_tokens: 8_192,
            threshold: 0.99,
            ..tiny_compaction()
        }),
        ..Default::default()
    };
    let echo_bulk = Arc::new(BulkyEchoTool);
    orchestrator::persist_user_message(
        fx.hub.writer(),
        fx.hub.sink(),
        &fx.session_id,
        &orchestrator::IncomingUserMessage { content: "please".to_owned() },
    )
    .unwrap();
    let handle = fx.hub.begin_turn(&fx.session_id, AutonomyMode::Edit).unwrap();
    orchestrator::execute_turn(&fx.hub, &spec, engine.clone(), vec![echo_bulk], handle)
        .await
        .unwrap();
    fx.hub.end_turn(&fx.session_id);

    let events = fx.events_until_turn_end().await;
    // Forced compaction events, then a clean turn end — no error/turn_end
    // refusal pair.
    assert!(events.iter().any(|e| matches!(
        e, AgentEvent::Compacting { forced: true, .. }
    )));
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })));
    let AgentEvent::TurnEnd { stop_reason, .. } = events.last().unwrap() else {
        panic!("turn_end");
    };
    assert_eq!(*stop_reason, TurnStopReason::EndTurn);

    // Requests: step 1, overflowed step 2 (rolled back), summarizer, retry.
    let requests = engine.requests();
    assert_eq!(requests.len(), 4);
    let retry = requests.last().unwrap();
    let HistoryPart::Text { text } = &retry.messages[0].parts[0] else {
        panic!("text part");
    };
    assert!(text.starts_with("[Compacted context"), "summary leads the retry");
    // The replayed user request closes the history (the bulky tool result
    // was pruned to a marker).
    let HistoryPart::Text { text } = retry.messages.last().unwrap().parts.last().unwrap() else {
        panic!("text part");
    };
    assert_eq!(text, "please");
}

/// A write_file-named no-op fake — the static tier table keys by NAME, so
/// this exercises the Edit-mode write gate without touching the disk.
struct FakeWriteTool;

impl Tool for FakeWriteTool {
    fn spec(&self) -> tide_tools::ToolSpec {
        tide_tools::ToolSpec {
            name: "write_file".to_owned(),
            description: "Fake write.".to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"],
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        _args: serde_json::Value,
    ) -> Result<ToolOutcome, tide_tools::ToolError> {
        Ok(ToolOutcome::executed("fake write done"))
    }
}

/// A write_file-named tool whose output is bulky (drives Layer-1 pruning);
/// named for the static tier table so edit mode auto-runs it.
struct BulkyEchoTool;

impl Tool for BulkyEchoTool {
    fn spec(&self) -> tide_tools::ToolSpec {
        tide_tools::ToolSpec {
            name: "write_file".to_owned(),
            description: "Echoes bulkily.".to_owned(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"],
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, tide_tools::ToolError> {
        let mut text = args
            .get("content")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_owned();
        text.push_str(&"x".repeat(120_000));
        Ok(ToolOutcome::executed(format!("echo: {text}")))
    }
}

// ── T7: T3 wiring ───────────────────────────────────────────────────────────

/// Todo persistence: the hub's TodoBus subscription mirrors every
/// todo_write replacement into the sessions store's side table.
#[tokio::test]
async fn todo_write_persists_to_the_sessions_store() {
    let mut fx = Fixture::new("todo-persist");
    let todo_args = serde_json::json!({
        "todos": [{ "content": "Persist me", "status": "in_progress", "priority": "high" }]
    });
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_todo".to_owned(),
                tool_name: "todo_write".to_owned(),
                arguments: todo_args.clone(),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_todo".to_owned(),
                    tool_name: "todo_write".to_owned(),
                    arguments: todo_args,
                }],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx
        .send_with_tools("edit", engine, vec![Arc::new(tide_tools::TodoWriteTool)])
        .await
        .unwrap();
    assert!(result.accepted, "{:?}", result.error);

    fx.wait_idle().await;
    let persisted = fx
        .hub
        .writer()
        .lock()
        .unwrap()
        .session_todos(&fx.session_id)
        .expect("todos row");
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0]["content"], serde_json::json!("Persist me"));
    assert_eq!(persisted[0]["status"], serde_json::json!("in_progress"));
    assert_eq!(persisted[0]["priority"], serde_json::json!("high"));

    let _ = fx.events_until_turn_end().await;
}

/// TurnSpec.workspace_id resolution: the start_turn path matches the
/// session's workspace path back to the configured workspace, and the
/// ToolContext carries it (the memory tool's store key).
#[tokio::test]
async fn tool_context_carries_the_resolved_workspace_id() {
    let mut fx = Fixture::new("workspace-id");
    // write_file-named so the static tier table auto-runs it in edit mode.
    struct ProbeTool;
    impl Tool for ProbeTool {
        fn spec(&self) -> tide_tools::ToolSpec {
            tide_tools::ToolSpec {
                name: "write_file".to_owned(),
                description: "Probes the ctx.".to_owned(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string" }
                    },
                    "required": ["path", "content"],
                }),
            }
        }
        fn risk_tier(&self) -> RiskTier {
            RiskTier::Write
        }
        fn execute(
            &self,
            ctx: &ToolContext,
            _args: serde_json::Value,
        ) -> Result<ToolOutcome, tide_tools::ToolError> {
            Ok(ToolOutcome::executed(format!("ws={}", ctx.workspace_id)))
        }
    }
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_1".to_owned(),
                tool_name: "write_file".to_owned(),
                arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_1".to_owned(),
                    tool_name: "write_file".to_owned(),
                    arguments: serde_json::json!({ "path": "a.txt", "content": "x" }),
                }],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send_with_tools("edit", engine, vec![Arc::new(ProbeTool)]).await.unwrap();
    assert!(result.accepted, "{:?}", result.error);

    let events = fx.events_until_turn_end().await;
    let AgentEvent::ToolResult { output, .. } = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { .. }))
        .expect("tool_result")
    else {
        unreachable!();
    };
    assert_eq!(output.as_deref(), Some("ws=ws_1"));
}
