//! Sub-agent dispatch tests — dispatch_agent through the real turn loop
//! with a scripted engine shared by parent and child turns (scripts pop in
//! call order). Covers: the mirrored child stream (parentToolCallId tags),
//! the AgentDetail tool result, child session rows (parent_id, transcript),
//! permission inheritance (child asks ride the root session, escalations
//! never reach the parent mode), the plan-mode target gate, abort
//! propagation, parallel dispatch, nesting (canDispatch + depth), and
//! resumeFrom.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures::stream::{self, Stream, StreamExt};
use tide_engine::{
    EngineEvent, EngineStopReason, HistoryMessage, HistoryPart, HistoryRole, TurnRequest,
};
use tide_tools::{OutcomeStatus, Tool, ToolContext, ToolOutcome};
use tokio::sync::broadcast;

use super::events::{AgentEvent, ChatPush, TurnStopReason};
use super::hub::ChatHub;
use super::orchestrator::StepStream;
use crate::commands::chat::{
    create_session, respond_permission, start_turn, ChatRunTurnArgs, ChatSendResultWire,
    ChatTurnMessageWire, PermissionRespondArgs, SessionCreateOptsWire,
};
use crate::state::AppState;

const WAIT: Duration = Duration::from_secs(5);

type StepScript = Vec<Result<EngineEvent, tide_engine::EngineError>>;
type StepStreamBox = std::pin::Pin<Box<dyn Stream<Item = Result<EngineEvent, tide_engine::EngineError>> + Send>>;

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

    fn systems(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|r| r.params.system.clone().unwrap_or_default())
            .collect()
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
            None => Box::pin(stream::iter(vec![Err(tide_engine::EngineError::Config(
                "script exhausted".to_owned(),
            ))])),
        }
    }
}

/// A write-tier tool outside every catalog subset — the PARENT can call it,
/// children never see it (proves the parent's own gate state).
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

    fn risk_tier(&self) -> tide_tools::RiskTier {
        tide_tools::RiskTier::Write
    }

    fn execute(
        &self,
        _ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, tide_tools::ToolError> {
        let text = args.get("text").and_then(|t| t.as_str()).unwrap_or_default();
        Ok(ToolOutcome::executed(format!("echo: {text}")))
    }
}

// ── script builders ─────────────────────────────────────────────────────────

fn delta(text: &str) -> Result<EngineEvent, tide_engine::EngineError> {
    Ok(EngineEvent::Delta { text: text.to_owned() })
}

fn dispatch_call(id: &str, name: &str, task: &str, title: Option<&str>) -> EngineEvent {
    let mut arguments = serde_json::json!({ "name": name, "task": task });
    if let Some(title) = title {
        arguments["title"] = serde_json::json!(title);
    }
    EngineEvent::ToolCall {
        tool_call_id: id.to_owned(),
        tool_name: "dispatch_agent".to_owned(),
        arguments,
    }
}

fn dispatch_part(id: &str, name: &str, task: &str, title: Option<&str>) -> HistoryPart {
    let mut arguments = serde_json::json!({ "name": name, "task": task });
    if let Some(title) = title {
        arguments["title"] = serde_json::json!(title);
    }
    HistoryPart::ToolCall {
        id: id.to_owned(),
        tool_name: "dispatch_agent".to_owned(),
        arguments,
    }
}

fn tool_call(id: &str, name: &str, arguments: serde_json::Value) -> EngineEvent {
    EngineEvent::ToolCall {
        tool_call_id: id.to_owned(),
        tool_name: name.to_owned(),
        arguments,
    }
}

fn step_end(stop: EngineStopReason, parts: Vec<HistoryPart>) -> Result<EngineEvent, tide_engine::EngineError> {
    Ok(EngineEvent::StepEnd {
        stop_reason: stop,
        message: HistoryMessage {
            role: HistoryRole::Assistant,
            parts,
        },
    })
}

fn text_part(text: &str) -> HistoryPart {
    HistoryPart::Text { text: text.to_owned() }
}

fn call_part(id: &str, name: &str, arguments: serde_json::Value) -> HistoryPart {
    HistoryPart::ToolCall {
        id: id.to_owned(),
        tool_name: name.to_owned(),
        arguments,
    }
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
    fn new(_name: &str, files: &[(&str, &str)]) -> Self {
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

    async fn send(
        &self,
        autonomy: &str,
        engine: Arc<dyn StepStream>,
        tools: Vec<Arc<dyn Tool>>,
    ) -> ChatSendResultWire {
        start_turn(&self.state, &self.hub, self.args(autonomy), engine, tools)
            .await
            .unwrap()
    }

    async fn next_agent_event(&mut self) -> AgentEvent {
        loop {
            match tokio::time::timeout(WAIT, self.push_rx.recv()).await {
                Ok(Ok(ChatPush::Agent { event })) => return event,
                Ok(Ok(_)) => continue,
                Ok(Err(e)) => panic!("broadcast ended: {e}"),
                Err(_) => panic!("timed out waiting for an agent event"),
            }
        }
    }

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

    /// The next permission card (skipping stream events).
    async fn next_permission_card(&mut self) -> AgentEvent {
        loop {
            match self.next_agent_event().await {
                card @ AgentEvent::PermissionRequired { .. } => return card,
                AgentEvent::TurnEnd { .. } => panic!("turn ended waiting for a card"),
                _ => continue,
            }
        }
    }

    fn respond(&self, tool_call_ids: &[&str], approve: bool, new_mode: Option<&str>) {
        respond_permission(
            &self.hub,
            PermissionRespondArgs {
                session_id: self.session_id.clone(),
                tool_call_ids: tool_call_ids.iter().map(|s| s.to_string()).collect(),
                approve,
                remember: None,
                new_mode: new_mode.map(str::to_owned),
                reason: (!approve).then(|| "not today".to_owned()),
            },
        );
    }

    fn reader(&self) -> tide_store::sessions_v2::SessionsV2 {
        tide_store::sessions_v2::SessionsV2::open(self.hub.db_path()).unwrap()
    }

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

/// Fish the AgentDetail payload out of a dispatch tool_result event (only
/// dispatches produce the Agent display kind).
fn agent_detail(event: &AgentEvent) -> Option<&tide_tools::ToolDisplay> {
    let AgentEvent::ToolResult { display, .. } = event else {
        return None;
    };
    display.as_ref()
}

// ── tests ───────────────────────────────────────────────────────────────────

/// Happy path: a dispatched explore agent runs its own child turn (with the
/// agent's system prompt + tool subset), its stream mirrors into the root
/// session tagged with the dispatch tool call id, and the dispatch tool
/// result carries the AgentDetail payload with the child session id. The
/// child session row (parent_id set) holds the full transcript.
#[tokio::test]
async fn dispatch_runs_child_turn_mirrors_events_and_persists() {
    let mut fx = Fixture::new("happy", &[("notes.txt", "the answer is 42\n")]);
    let engine = ScriptedEngine::new(vec![
        // parent step 1: dispatch explore
        vec![
            Ok(dispatch_call("call_d1", "explore", "Find the notes file.", Some("Docs sweep"))),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_d1", "explore", "Find the notes file.", Some("Docs sweep"))],
            ),
        ],
        // child step 1: read the file (explore's subset includes read_file)
        vec![
            delta("Working "),
            Ok(tool_call("call_c1", "read_file", serde_json::json!({ "path": "notes.txt" }))),
            step_end(
                EngineStopReason::ToolUse,
                vec![call_part("call_c1", "read_file", serde_json::json!({ "path": "notes.txt" }))],
            ),
        ],
        // child step 2: report
        vec![delta("found it"), step_end(EngineStopReason::EndTurn, vec![text_part("found it")])],
        // parent step 2: wrap up
        vec![delta("Done."), step_end(EngineStopReason::EndTurn, vec![text_part("Done.")])],
    ]);

    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(tide_tools::ReadFileTool),
        Arc::new(tide_tools::GrepTool),
        Arc::new(tide_tools::GlobTool),
    ];
    let result = fx.send("edit", engine.clone(), tools).await;
    assert!(result.accepted, "{:?}", result.error);

    let events = fx.events_until_turn_end().await;
    let tagged = |event: &AgentEvent| {
        event_parent_tc(event).as_deref() == Some("call_d1")
    };

    // The dispatch itself is an ordinary top-level call; the child's stream
    // rides the root session tagged with the dispatch id.
    let kinds: Vec<&str> = events.iter().map(kind).collect();
    assert_eq!(
        kinds,
        vec![
            "tool_call",           // dispatch_agent assembled
            "tool_executing",      // dispatch started
            "delta",               // child text (tagged)
            "tool_call",           // child read_file (tagged)
            "tool_executing",      // child read_file executing (tagged)
            "tool_result",         // child read_file result (tagged)
            "delta",               // child report tail (tagged)
            "tool_result",         // dispatch result (AgentDetail)
            "delta",               // parent wrap-up
            "turn_end",
        ],
        "{kinds:?}"
    );
    assert!(events.iter().all(|e| event_session(e) == fx.session_id), "all events ride the root session");
    for event in &events[2..7] {
        assert!(tagged(event), "child event not tagged: {:?}", kind(event));
    }
    assert!(!tagged(&events[0]) && !tagged(&events[7]), "dispatch rows untagged");
    // No child turn_end/usage/error leaked into the root stream.
    assert_eq!(events.iter().filter(|e| kind(e) == "turn_end").count(), 1);

    // The dispatch result: AgentDetail with the report + dispatch id.
    let AgentEvent::ToolResult { status, output, display, meta, .. } = &events[7] else {
        unreachable!()
    };
    assert_eq!(*status, OutcomeStatus::Executed);
    assert_eq!(output.as_deref(), Some("Working found it"));
    assert_eq!(meta.as_deref(), Some("explore · 2 steps"));
    let Some(tide_tools::ToolDisplay::Agent {
        agent_name, title, task, report, dispatch_id, ..
    }) = display
    else {
        panic!("AgentDetail display, got {display:?}");
    };
    assert_eq!(agent_name, "explore");
    assert_eq!(title.as_deref(), Some("Docs sweep"));
    assert_eq!(task, "Find the notes file.");
    assert_eq!(report, "Working found it");
    let child_id = dispatch_id.clone().expect("dispatchId = child session id");

    // Child session row: parent_id marks it a subagent; the transcript has
    // the task and the assistant parts.
    fx.wait_idle().await;
    fx.hub.sink().flush().await;
    assert_eq!(child_parent_id(&fx, &child_id), Some(Some(fx.session_id.clone())));
    let page = fx.reader().session_messages(&child_id, Default::default()).unwrap();
    assert_eq!(page.messages.len(), 2, "user task + assistant report");
    assert_eq!(page.messages[0].role, "user");
    assert_eq!(page.messages[0].parts[0].data, serde_json::json!({ "text": "Find the notes file." }));
    let assistant = &page.messages[1];
    let part_kinds: Vec<&str> = assistant.parts.iter().map(|p| p.kind.as_str()).collect();
    assert_eq!(part_kinds, ["text", "tool", "text"]);
    assert_eq!(assistant.parts[1].data["toolName"], serde_json::json!("read_file"));

    // Engine calls: parent(1) + child(2) + parent(1); the child ran the
    // explore system prompt with ONLY the explore tool subset.
    let requests = engine.requests();
    assert_eq!(requests.len(), 4);
    let systems = engine.systems();
    assert!(systems[0].contains("You are Tide"), "parent keeps the Tide prompt");
    assert!(systems[1].contains("file search specialist"), "child runs the agent prompt: {}", &systems[1][..60.min(systems[1].len())]);
    assert_eq!(
        requests[1].tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        vec!["read_file", "grep", "glob"],
        "child toolset = registry ∩ explore's allowedTools"
    );

    fx.wait_idle().await;
}

/// Permission inheritance: the child's ask surfaces a card on the ROOT
/// session; approving it WITH an escalation un-gates the child only — the
/// parent turn's mode stays ask (its own gated call still asks).
#[tokio::test]
async fn child_ask_escalation_never_reaches_the_parent_mode() {
    let mut fx = Fixture::new("inherit", &[]);
    let engine = ScriptedEngine::new(vec![
        // parent step 1: dispatch general-purpose
        vec![
            Ok(dispatch_call("call_d1", "general-purpose", "Investigate the build.", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_d1", "general-purpose", "Investigate the build.", None)],
            ),
        ],
        // child step 1: bash (destructive → ask in the inherited ask mode)
        vec![
            Ok(tool_call("call_c1", "bash", serde_json::json!({ "command": "echo child-ran" }))),
            step_end(
                EngineStopReason::ToolUse,
                vec![call_part("call_c1", "bash", serde_json::json!({ "command": "echo child-ran" }))],
            ),
        ],
        // child step 2: report
        vec![delta("child done"), step_end(EngineStopReason::EndTurn, vec![text_part("child done")])],
        // parent step 2: a write-tier call of its own — must still ASK
        vec![
            Ok(tool_call("call_p1", "echo", serde_json::json!({ "text": "parent" }))),
            step_end(
                EngineStopReason::ToolUse,
                vec![call_part("call_p1", "echo", serde_json::json!({ "text": "parent" }))],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);

    let result = fx
        .send("ask", engine, vec![Arc::new(EchoTool), Arc::new(tide_tools::BashTool)])
        .await;
    assert!(result.accepted, "{:?}", result.error);

    // The child's bash ask arrives as a card on the root session.
    let card = fx.next_permission_card().await;
    let AgentEvent::PermissionRequired { session_id, tool_calls, .. } = card else {
        unreachable!()
    };
    assert_eq!(session_id, fx.session_id, "child cards ride the root session");
    assert_eq!(tool_calls[0].id, "call_c1");
    assert_eq!(tool_calls[0].tool_name, "bash");
    assert_eq!(tool_calls[0].gate_decision, Some("ask"));

    // Approve WITH escalation to full — the child un-gates, the parent
    // must not.
    fx.respond(&["call_c1"], true, Some("full"));

    // Watch for the child's bash result and the parent's own echo card.
    let mut saw_child_bash_ok = false;
    let parent_card = loop {
        let event = fx.next_agent_event().await;
        if let AgentEvent::ToolResult { tool_call_id, status, output, .. } = &event {
            if tool_call_id == "call_c1" {
                assert_eq!(*status, OutcomeStatus::Executed, "child bash ran after approval");
                assert!(output.as_deref().unwrap().contains("child-ran"));
                saw_child_bash_ok = true;
            }
        }
        if let AgentEvent::PermissionRequired { tool_calls, .. } = &event {
            if tool_calls[0].tool_name == "echo" {
                break event;
            }
        }
        if matches!(event, AgentEvent::TurnEnd { .. }) {
            panic!("turn ended before the parent's echo card — parent mode escalated");
        }
    };
    assert!(saw_child_bash_ok, "child executed the escalated bash call");

    let AgentEvent::PermissionRequired { tool_calls, .. } = &parent_card else {
        unreachable!()
    };
    assert_eq!(tool_calls[0].id, "call_p1");
    assert_eq!(tool_calls[0].gate_decision, Some("ask"), "parent still in ask mode");

    // Deny it; the turn closes with the rejected result.
    fx.respond(&["call_p1"], false, None);
    let events = fx.events_until_turn_end().await;
    let parent_result = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_p1"))
        .unwrap();
    let AgentEvent::ToolResult { status, .. } = parent_result else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Rejected);
    fx.wait_idle().await;
}

/// Plan mode: a read-only agent dispatches without a card; a write/destructive
/// agent is blocked behind one, and denying rejects the dispatch.
#[tokio::test]
async fn plan_mode_gates_dispatch_by_target_tier() {
    let mut fx = Fixture::new("plan", &[]);
    let read_only = ScriptedEngine::new(vec![
        vec![
            Ok(dispatch_call("call_d1", "explore", "Map the tree.", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_d1", "explore", "Map the tree.", None)],
            ),
        ],
        vec![delta("mapped"), step_end(EngineStopReason::EndTurn, vec![text_part("mapped")])],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("plan", read_only, Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);
    let events = fx.events_until_turn_end().await;
    assert!(
        !events.iter().any(|e| kind(e) == "permission_required"),
        "read-only agent needs no card in plan mode"
    );
    let dispatch_result = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_d1"))
        .unwrap();
    let AgentEvent::ToolResult { status, .. } = dispatch_result else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Executed);
    fx.wait_idle().await;

    // general-purpose carries bash → destructive tier → blocked card first.
    let gated = ScriptedEngine::new(vec![
        vec![
            Ok(dispatch_call("call_d2", "general-purpose", "Fix the build.", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_d2", "general-purpose", "Fix the build.", None)],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("plan", gated, Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);

    let card = fx.next_permission_card().await;
    let AgentEvent::PermissionRequired { tool_calls, .. } = card else { unreachable!() };
    assert_eq!(tool_calls[0].id, "call_d2");
    assert_eq!(tool_calls[0].tool_name, "dispatch_agent");
    assert_eq!(tool_calls[0].gate_decision, Some("blocked"));

    fx.respond(&["call_d2"], false, None);
    let events = fx.events_until_turn_end().await;
    let dispatch_result = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_d2"))
        .unwrap();
    let AgentEvent::ToolResult { status, output, .. } = dispatch_result else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Rejected);
    assert!(output.as_deref().unwrap().contains("User denied dispatching general-purpose"));
    fx.wait_idle().await;
}

/// Abort: aborting the root turn kills the in-flight child; the dispatch
/// result reports aborted and the parent closes turn_end(aborted).
#[tokio::test]
async fn aborting_the_parent_aborts_children() {
    let mut fx = Fixture::new("abort", &[]);

    /// Parent script fixed; child streams one delta then pends.
    struct AbortEngine;
    impl StepStream for AbortEngine {
        fn stream_step(&self, request: TurnRequest) -> StepStreamBox {
            let is_child = request
                .params
                .system
                .as_deref()
                .is_some_and(|s| !s.contains("You are Tide"));
            if is_child {
                let head = stream::iter(vec![Ok::<_, tide_engine::EngineError>(EngineEvent::Delta {
                    text: "child partial ".to_owned(),
                })]);
                let tail: StepStreamBox = Box::pin(stream::pending());
                Box::pin(head.chain(tail))
            } else {
                Box::pin(stream::iter(vec![
                    Ok(dispatch_call("call_d1", "explore", "Never finishes.", None)),
                    Ok(EngineEvent::StepEnd {
                        stop_reason: EngineStopReason::ToolUse,
                        message: HistoryMessage {
                            role: HistoryRole::Assistant,
                            parts: vec![dispatch_part("call_d1", "explore", "Never finishes.", None)],
                        },
                    }),
                ]))
            }
        }
    }

    let result = fx.send("edit", Arc::new(AbortEngine), Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);

    // Wait for the child's tagged delta, then abort the root.
    loop {
        let event = fx.next_agent_event().await;
        if let AgentEvent::Delta { parent_tool_call_id: Some(id), text, .. } = &event {
            assert_eq!(id, "call_d1");
            assert_eq!(text, "child partial ");
            break;
        }
    }
    fx.hub.abort_turn(&fx.session_id);

    let events = fx.events_until_turn_end().await;
    let dispatch_result = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_d1"))
        .expect("aborted dispatch still reports a result");
    let AgentEvent::ToolResult { status, output, .. } = dispatch_result else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Aborted);
    assert_eq!(output.as_deref(), Some("Agent explore aborted."));
    let AgentEvent::TurnEnd { stop_reason, .. } = events.last().unwrap() else { unreachable!() };
    assert_eq!(*stop_reason, TurnStopReason::Aborted);
    fx.wait_idle().await;
}

/// Parallel dispatch: two dispatch_agent calls in one step run as two child
/// turns; both rows report distinct dispatchIds and both children persist.
#[tokio::test]
async fn parallel_dispatches_run_concurrently_and_report_separately() {
    let mut fx = Fixture::new("parallel", &[]);
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(dispatch_call("call_d1", "explore", "Find auth.", Some("Auth map"))),
            Ok(dispatch_call("call_d2", "web-research", "Check the docs.", Some("Docs check"))),
            step_end(
                EngineStopReason::ToolUse,
                vec![
                    dispatch_part("call_d1", "explore", "Find auth.", Some("Auth map")),
                    dispatch_part("call_d2", "web-research", "Check the docs.", Some("Docs check")),
                ],
            ),
        ],
        // child 1 and child 2 (spawn order), identical single-step scripts
        vec![delta("child report"), step_end(EngineStopReason::EndTurn, vec![text_part("child report")])],
        vec![delta("child report"), step_end(EngineStopReason::EndTurn, vec![text_part("child report")])],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("edit", engine, Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);

    let events = fx.events_until_turn_end().await;
    let details: Vec<(String, String)> = events
        .iter()
        .filter_map(|e| {
            let tide_tools::ToolDisplay::Agent { agent_name, dispatch_id, .. } = agent_detail(e)? else { return None };
            Some((agent_name.clone(), dispatch_id.clone()?))
        })
        .collect();
    assert_eq!(details.len(), 2, "two dispatch results");
    assert_eq!(details[0].0, "explore");
    assert_eq!(details[1].0, "web-research");
    assert_ne!(details[0].1, details[1].1, "distinct child sessions");
    for (_, child_id) in &details {
        let writer = fx.hub.writer().lock().unwrap();
        assert_eq!(writer.session_parent_id(child_id), Some(Some(fx.session_id.clone())));
    }
    // Both children's tagged deltas arrived.
    let tagged: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Delta { parent_tool_call_id: Some(id), .. } => Some(id.clone()),
            _ => None,
        })
        .collect();
    assert!(tagged.contains(&"call_d1".to_owned()) && tagged.contains(&"call_d2".to_owned()));

    let AgentEvent::TurnEnd { tool_calls, .. } = events.last().unwrap() else { unreachable!() };
    let dispatch_rows = tool_calls
        .as_ref()
        .unwrap()
        .iter()
        .filter(|c| c.tool_name == "dispatch_agent")
        .collect::<Vec<_>>();
    assert_eq!(dispatch_rows.len(), 2);
    assert!(dispatch_rows.iter().all(|c| c.status == "executed"));
    fx.wait_idle().await;
}

/// Nesting: general-purpose (canDispatch: explore) spawns explore — the
/// grandchild's events still ride the ROOT session, tagged with the CHILD's
/// dispatch tool call id; both child rows hang off the root session. A
/// target outside canDispatch is rejected outright.
#[tokio::test]
async fn nested_dispatch_rides_the_root_stream_and_can_dispatch_is_enforced() {
    let mut fx = Fixture::new("nested", &[]);
    let engine = ScriptedEngine::new(vec![
        // parent → general-purpose
        vec![
            Ok(dispatch_call("call_d1", "general-purpose", "Root task.", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_d1", "general-purpose", "Root task.", None)],
            ),
        ],
        // gp child → simplifier (NOT in general-purpose's canDispatch list)
        vec![
            Ok(dispatch_call("call_g1", "simplifier", "Clean up.", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_g1", "simplifier", "Clean up.", None)],
            ),
        ],
        // gp child → explore (granted)
        vec![
            Ok(dispatch_call("call_g2", "explore", "Sub-search.", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_g2", "explore", "Sub-search.", None)],
            ),
        ],
        // grandchild (explore) single step
        vec![delta("grand report"), step_end(EngineStopReason::EndTurn, vec![text_part("grand report")])],
        // gp child wraps up
        vec![delta("gp done"), step_end(EngineStopReason::EndTurn, vec![text_part("gp done")])],
        // parent wraps up
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("edit", engine, Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);

    let events = fx.events_until_turn_end().await;
    let result_of = |id: &str| {
        events
            .iter()
            .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == id))
            .unwrap()
    };
    // The ungranted target is rejected with the TS message.
    let AgentEvent::ToolResult { status, output, .. } = result_of("call_g1") else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Rejected);
    assert_eq!(output.as_deref(), Some("This agent cannot dispatch \"simplifier\"."));

    // The granted grandchild ran and its delta is tagged with the CHILD's
    // dispatch call, on the ROOT session.
    let AgentEvent::ToolResult { status, .. } = result_of("call_g2") else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Executed);
    let grand = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::Delta { parent_tool_call_id: Some(id), text, .. } if id == "call_g2" => {
                Some(text.clone())
            }
            _ => None,
        })
        .expect("grandchild delta tagged with the child's dispatch id");
    assert_eq!(grand, "grand report");
    assert!(events.iter().all(|e| event_session(e) == fx.session_id), "depth-2 events still ride the root");

    // Both child sessions (gp + explore) hang off the ROOT.
    let details: Vec<String> = events
        .iter()
        .filter_map(|e| {
            let tide_tools::ToolDisplay::Agent { dispatch_id, .. } = agent_detail(e)? else { return None };
            dispatch_id.clone()
        })
        .collect();
    assert_eq!(details.len(), 2);
    for child_id in &details {
        assert_eq!(child_parent_id(&fx, child_id), Some(Some(fx.session_id.clone())));
    }
    fx.wait_idle().await;
}

/// resumeFrom: a second dispatch continuing the first's child session adds
/// no new row and seeds the child's history with the prior exchange; a
/// foreign id is rejected.
#[tokio::test]
async fn resume_from_continues_the_child_session() {
    let mut fx = Fixture::new("resume", &[]);

    // Turn 1: dispatch + report.
    let first = ScriptedEngine::new(vec![
        vec![
            Ok(dispatch_call("call_d1", "explore", "First task.", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_d1", "explore", "First task.", None)],
            ),
        ],
        vec![delta("first report"), step_end(EngineStopReason::EndTurn, vec![text_part("first report")])],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("edit", first, Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);
    let events = fx.events_until_turn_end().await;
    let child_id = events
        .iter()
        .find_map(|e| {
            let tide_tools::ToolDisplay::Agent { dispatch_id, .. } = agent_detail(e)? else { return None };
            dispatch_id.clone()
        })
        .expect("first dispatch id");
    fx.wait_idle().await;

    // Turn 2: resume with a foreign id → failed result.
    let foreign = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_d2".to_owned(),
                tool_name: "dispatch_agent".to_owned(),
                arguments: serde_json::json!({ "name": "explore", "task": "Follow-up.", "resumeFrom": "s_somebodyelse" }),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_d2".to_owned(),
                    tool_name: "dispatch_agent".to_owned(),
                    arguments: serde_json::json!({ "name": "explore", "task": "Follow-up.", "resumeFrom": "s_somebodyelse" }),
                }],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("edit", foreign, Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);
    let events = fx.events_until_turn_end().await;
    let AgentEvent::ToolResult { status, output, .. } = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_d2"))
        .unwrap()
    else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Failed);
    assert!(output.as_deref().unwrap().contains("not a dispatch of this session"));
    fx.wait_idle().await;

    // Turn 3: legit resume — same child session, seeded history.
    let resume = ScriptedEngine::new(vec![
        vec![
            Ok(EngineEvent::ToolCall {
                tool_call_id: "call_d3".to_owned(),
                tool_name: "dispatch_agent".to_owned(),
                arguments: serde_json::json!({ "name": "explore", "task": "Follow-up.", "resumeFrom": child_id }),
            }),
            step_end(
                EngineStopReason::ToolUse,
                vec![HistoryPart::ToolCall {
                    id: "call_d3".to_owned(),
                    tool_name: "dispatch_agent".to_owned(),
                    arguments: serde_json::json!({ "name": "explore", "task": "Follow-up.", "resumeFrom": child_id }),
                }],
            ),
        ],
        vec![delta("second report"), step_end(EngineStopReason::EndTurn, vec![text_part("second report")])],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let engine = resume.clone();
    let result = fx.send("edit", engine, Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);
    let events = fx.events_until_turn_end().await;
    let detail = events
        .iter()
        .find_map(|e| {
            let tide_tools::ToolDisplay::Agent { dispatch_id, .. } = agent_detail(e)? else { return None };
            dispatch_id.clone()
        })
        .expect("resumed dispatch result");
    assert_eq!(detail, child_id, "resume reuses the child session");

    // The resumed child's engine request saw the prior exchange.
    let requests = resume.requests();
    let child_request = &requests[1];
    let request_text = format!("{:?}", child_request.messages);
    assert!(request_text.contains("First task."), "seeded with the first task");
    assert!(request_text.contains("first report"), "seeded with the first report");
    assert!(request_text.contains("Follow-up."), "plus the follow-up");

    // Transcript: user, assistant, user, assistant.
    let page = fx.reader().session_messages(&child_id, Default::default()).unwrap();
    assert_eq!(page.messages.len(), 4);
    assert_eq!(page.messages[2].parts[0].data, serde_json::json!({ "text": "Follow-up." }));
    fx.wait_idle().await;
}

/// Unknown agent and missing task fail the dispatch result with the TS
/// messages (the turn itself keeps going).
#[tokio::test]
async fn unknown_agent_and_missing_task_fail_gracefully() {
    let mut fx = Fixture::new("validation", &[]);
    let engine = ScriptedEngine::new(vec![
        vec![
            Ok(dispatch_call("call_d1", "does-not-exist", "Anything.", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_d1", "does-not-exist", "Anything.", None)],
            ),
        ],
        vec![
            Ok(dispatch_call("call_d2", "explore", "   ", None)),
            step_end(
                EngineStopReason::ToolUse,
                vec![dispatch_part("call_d2", "explore", "   ", None)],
            ),
        ],
        vec![step_end(EngineStopReason::EndTurn, vec![])],
    ]);
    let result = fx.send("edit", engine, Vec::new()).await;
    assert!(result.accepted, "{:?}", result.error);
    let events = fx.events_until_turn_end().await;

    let AgentEvent::ToolResult { status, output, .. } = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_d1"))
        .unwrap()
    else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Failed);
    assert!(output.as_deref().unwrap().contains("Unknown agent: \"does-not-exist\""));
    assert!(output.as_deref().unwrap().contains("explore"));

    let AgentEvent::ToolResult { status, output, .. } = events
        .iter()
        .find(|e| matches!(e, AgentEvent::ToolResult { tool_call_id, .. } if tool_call_id == "call_d2"))
        .unwrap()
    else { unreachable!() };
    assert_eq!(*status, OutcomeStatus::Failed);
    assert!(output.as_deref().unwrap().contains("Missing \"task\""));
    fx.wait_idle().await;
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn child_parent_id(fx: &Fixture, child_id: &str) -> Option<Option<String>> {
    fx.hub
        .writer()
        .lock()
        .unwrap()
        .session_parent_id(child_id)
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

fn event_session(event: &AgentEvent) -> &str {
    match event {
        AgentEvent::Delta { session_id, .. }
        | AgentEvent::Reasoning { session_id, .. }
        | AgentEvent::ToolCallStart { session_id, .. }
        | AgentEvent::ToolCallDelta { session_id, .. }
        | AgentEvent::ToolCall { session_id, .. }
        | AgentEvent::ToolExecuting { session_id, .. }
        | AgentEvent::ToolResult { session_id, .. }
        | AgentEvent::Usage { session_id, .. }
        | AgentEvent::PermissionRequired { session_id, .. }
        | AgentEvent::FollowupRequired { session_id, .. }
        | AgentEvent::Compacting { session_id, .. }
        | AgentEvent::Retry { session_id, .. }
        | AgentEvent::Error { session_id, .. }
        | AgentEvent::TurnEnd { session_id, .. } => session_id,
    }
}

fn event_parent_tc(event: &AgentEvent) -> Option<String> {
    match event {
        AgentEvent::Delta { parent_tool_call_id, .. }
        | AgentEvent::Reasoning { parent_tool_call_id, .. }
        | AgentEvent::ToolCallStart { parent_tool_call_id, .. }
        | AgentEvent::ToolCallDelta { parent_tool_call_id, .. }
        | AgentEvent::ToolCall { parent_tool_call_id, .. }
        | AgentEvent::ToolExecuting { parent_tool_call_id, .. }
        | AgentEvent::ToolResult { parent_tool_call_id, .. } => parent_tool_call_id.clone(),
        _ => None,
    }
}
