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
