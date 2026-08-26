//! The turn loop — port of `app/core/agent/orchestrator.ts` @ 91ec558,
//! driving tide-engine's [`stream_step`] one completion at a time:
//!
//! ```text
//! build history (v2 reader) → stream EngineEvents → map to AgentEvents
//!   (sessionId/seq/messageId/blockId envelope) → {sink persist, Channel push}
//!   → tool calls → permission gate → execute → append results → repeat
//! ```
//!
//! Semantics ported exactly:
//! - **Retry**: on stream failure with a TRANSIENT error, emit `retry` and
//!   wait a 10s ABORTABLE delay (max 10 retries, budget re-earned each clean
//!   step). `error` events fire ONLY at exhaustion, immediately before
//!   `turn_end` — isStreaming never flickers mid-retries. Auth errors,
//!   "no output generated" and context-overflow errors never retry.
//! - **Abort**: watch-channel cancellation drops the in-flight stream
//!   future; the tool AbortFlag terminates running tools; partial parts
//!   stay persisted; `turn_end(aborted)` closes the turn.
//! - **v2 parts**: text deltas stream as `part.delta`, commit at block
//!   boundaries (tool start / new block / turn end); tool parts commit once
//!   at their result. `message.end` carries the usage rollup, `turn.end`
//!   anchors event pruning.
//! - **Permissions**: gate check BEFORE execute. Allow → run; Deny →
//!   rejected tool result; Ask → `permission_required` + parked oneshot
//!   (`permission_respond`), with the TS timeout (auto-reject) and
//!   remember/escalate answers.
//! - One turn per session ([`ChatHub::begin_turn`]).

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use futures::{StreamExt, Stream};
use tide_engine::{
    stream_step as engine_stream_step, EngineError, EngineEvent, EngineModel, EngineStopReason,
    EngineUsage, HistoryMessage, HistoryPart, HistoryRole, ThinkingLevel, ToolSpec as EngineToolSpec,
    TurnParams, TurnRequest,
};
use tide_store::sessions_v2::{
    SessionWindowOptsV2, SessionsV2,
};
use tide_store::sessions_v2_write::{
    new_message_id, new_part_id, InsertMessageInput, SessionsV2Writer, SinkEventWire, SinkEventType,
    SinkUsage,
};
use tide_tools::permission::{parse_rule, Decision, PermissionGate};
use tide_tools::permission::risk_tier_for;
use tide_tools::{AutonomyMode, OutcomeStatus, Tool, ToolContext, ToolOutcome};
use tokio::sync::watch;

use super::events::{
    format_arg_preview, AgentEvent, TimelineEntry, ToolCallWire, TurnStopReason,
};
use super::history::history_from_messages;
use super::hub::{ChatHub, PermissionAnswer, TurnHandle};
use super::sink::unix_ms_now;

const MAX_STEPS_DEFAULT: u32 = 100;
pub(crate) const TURN_MAX_RETRIES: u32 = 10;
pub(crate) const RETRY_DELAY: Duration = Duration::from_secs(10);
const PERMISSION_TIMEOUT_DEFAULT: Duration = Duration::from_secs(10 * 60);

/// Bundled system prompt — `build/promptMarkdownUtils.mjs` emits the same
/// fragment order/content as the renderer bundle; strip the generated-file
/// header comment the way the TS bundler strips fragment frontmatter.
pub fn system_prompt() -> String {
    let raw = include_str!("../../system-prompt.md");
    match raw.split_once("-->") {
        Some((_, body)) => body.trim().to_owned(),
        None => raw.trim().to_owned(),
    }
}

// ── Engine seam ─────────────────────────────────────────────────────────────

/// One completion step as a Stream — the ONLY engine dependency of the loop,
/// so tests script it without rig. Production: [`RigStepStream`].
pub trait StepStream: Send + Sync {
    fn stream_step(&self, request: TurnRequest) -> BoxStreamLocal;
}

pub type BoxStreamLocal = std::pin::Pin<Box<dyn Stream<Item = Result<EngineEvent, EngineError>> + Send>>;

/// The production engine: tide-engine's rig-backed stream_step over a
/// pre-constructed provider model.
pub struct RigStepStream {
    model: EngineModel,
}

impl RigStepStream {
    pub fn new(model: EngineModel) -> Self {
        Self { model }
    }
}

impl StepStream for RigStepStream {
    fn stream_step(&self, request: TurnRequest) -> BoxStreamLocal {
        Box::pin(engine_stream_step(self.model.clone(), request))
    }
}

// ── Turn spec ───────────────────────────────────────────────────────────────

/// Everything one turn needs, resolved from session/model config by the
/// command layer before spawning the loop. The autonomy mode lives in the
/// [`TurnHandle`] (escalations mutate it mid-turn), not here.
#[derive(Clone)]
pub struct TurnSpec {
    pub session_id: String,
    pub model_id: String,
    pub thinking_level: ThinkingLevel,
    pub model_max_output_tokens: Option<u64>,
    pub max_steps: u32,
    pub permission_timeout: Duration,
    /// Between-retry delay — the TS RETRY_DELAY_MS (10s); a spec field so
    /// tests shrink it instead of sleeping through the real thing.
    pub retry_delay: Duration,
    pub workspace_root: PathBuf,
}

impl Default for TurnSpec {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            model_id: String::new(),
            thinking_level: ThinkingLevel::default(),
            model_max_output_tokens: None,
            max_steps: MAX_STEPS_DEFAULT,
            permission_timeout: PERMISSION_TIMEOUT_DEFAULT,
            retry_delay: RETRY_DELAY,
            workspace_root: PathBuf::new(),
        }
    }
}

impl TurnSpec {
    pub fn effective_max_steps(agent_max_steps: Option<u64>) -> u32 {
        agent_max_steps
            .filter(|n| *n > 0)
            .map(|n| n.min(u32::MAX as u64) as u32)
            .unwrap_or(MAX_STEPS_DEFAULT)
    }

    pub fn effective_permission_timeout(min: Option<u64>) -> Duration {
        min.filter(|m| *m > 0)
            .map(|m| Duration::from_secs(m * 60))
            .unwrap_or(PERMISSION_TIMEOUT_DEFAULT)
    }
}

/// The user message a `chat_run_turn` payload appends before the turn runs
/// (role user + non-empty content required).
#[derive(Debug, Clone)]
pub struct IncomingUserMessage {
    pub content: String,
}

/// Persist the turn's incoming user message the way the TS twinV2 path did:
/// message row + a committed text part through the sink.
pub fn persist_user_message(
    writer: &StdMutex<SessionsV2Writer>,
    sink: &super::sink::EventSink,
    session_id: &str,
    message: &IncomingUserMessage,
) -> Result<(), String> {
    let message_id = new_message_id();
    writer
        .lock()
        .expect("sink writer poisoned")
        .insert_message(
            InsertMessageInput {
                id: &message_id,
                session_id,
                role: "user",
                model: None,
            },
            unix_ms_now(),
        )
        .map_err(|e| e.to_string())?;
    let part_id = new_part_id();
    sink.emit(SinkEventWire {
        r#type: SinkEventType::PartCommit,
        session_id: session_id.to_owned(),
        message_id: Some(message_id),
        part_id: Some(part_id),
        data: Some(serde_json::json!({
            "kind": "text",
            "data": { "text": message.content },
            "seq": 0,
        })),
        seq: None,
    });
    Ok(())
}

// ── v2 part tracker — port of V2TurnTracker @ 91ec558 ───────────────────────

struct V2ToolEnd {
    tool_name: String,
    input: serde_json::Value,
    output: Option<String>,
    status: OutcomeStatus,
    duration_ms: Option<u64>,
}

/// Pure per-turn sequencer for the v2 event stream: consumes stream
/// boundaries (text deltas keyed by block id, tool start/end by toolCallId)
/// and produces SinkEvents in commit order. Close-out is idempotent.
struct TurnTracker {
    session_id: String,
    message_id: String,
    part_index: i64,
    open_text: Option<(String, String)>, // (part_id == block_id, accumulated text)
    open_tools: HashMap<String, String>, // tool_call_id → armed part id
    closed: bool,
}

impl TurnTracker {
    fn new(session_id: &str, message_id: &str) -> Self {
        Self {
            session_id: session_id.to_owned(),
            message_id: message_id.to_owned(),
            part_index: 0,
            open_text: None,
            open_tools: HashMap::new(),
            closed: false,
        }
    }

    fn text_delta(&mut self, block_id: &str, text: &str) -> Vec<SinkEventWire> {
        if self.closed || text.is_empty() {
            return Vec::new();
        }
        let mut events = Vec::new();
        if self.open_text.as_ref().map(|(id, _)| id.as_str()) != Some(block_id) {
            events.extend(self.commit_text());
            self.open_text = Some((block_id.to_owned(), String::new()));
        }
        if let Some((_, buffer)) = &mut self.open_text {
            buffer.push_str(text);
        }
        events.push(SinkEventWire {
            r#type: SinkEventType::PartDelta,
            session_id: self.session_id.clone(),
            message_id: Some(self.message_id.clone()),
            part_id: Some(block_id.to_owned()),
            data: Some(serde_json::json!({ "text": text })),
            seq: None,
        });
        events
    }

    fn tool_start(&mut self, tool_call_id: &str) -> Vec<SinkEventWire> {
        if self.closed {
            return Vec::new();
        }
        let committed = self.commit_text();
        self.open_tools
            .insert(tool_call_id.to_owned(), new_part_id());
        committed
    }

    /// Arm the part for a call that never sent a ToolCallStart (a defensive
    /// engine-shape gap) — no-op when already armed. Commits any open text
    /// part like [`TurnTracker::tool_start`] does.
    fn ensure_armed(&mut self, tool_call_id: &str) -> Vec<SinkEventWire> {
        if self.closed {
            return Vec::new();
        }
        let committed = self.commit_text();
        self.open_tools
            .entry(tool_call_id.to_owned())
            .or_insert_with(new_part_id);
        committed
    }

    fn tool_end(&mut self, tool_call_id: &str, call: V2ToolEnd) -> Vec<SinkEventWire> {
        if self.closed {
            return Vec::new();
        }
        let Some(part_id) = self.open_tools.remove(tool_call_id) else {
            return Vec::new();
        };
        let seq = self.part_index;
        self.part_index += 1;
        vec![SinkEventWire {
            r#type: SinkEventType::PartCommit,
            session_id: self.session_id.clone(),
            message_id: Some(self.message_id.clone()),
            part_id: Some(part_id),
            data: Some(serde_json::json!({
                "kind": "tool",
                "data": {
                    "toolName": call.tool_name,
                    "input": call.input,
                    "output": call.output,
                    "status": call.status,
                    "durationMs": call.duration_ms,
                },
                "seq": seq,
            })),
            seq: None,
        }]
    }

    fn finish(&mut self, usage: SinkUsage) -> Vec<SinkEventWire> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        let mut events = self.commit_text();
        events.push(SinkEventWire {
            r#type: SinkEventType::MessageEnd,
            session_id: self.session_id.clone(),
            message_id: Some(self.message_id.clone()),
            part_id: None,
            data: Some(serde_json::to_value(serde_json::json!({ "usage": usage })).unwrap_or_default()),
            seq: None,
        });
        events.push(SinkEventWire {
            r#type: SinkEventType::TurnEnd,
            session_id: self.session_id.clone(),
            message_id: Some(self.message_id.clone()),
            part_id: None,
            data: None,
            seq: None,
        });
        events
    }

    fn commit_text(&mut self) -> Vec<SinkEventWire> {
        let Some((part_id, text)) = self.open_text.take() else {
            return Vec::new();
        };
        let seq = self.part_index;
        self.part_index += 1;
        vec![SinkEventWire {
            r#type: SinkEventType::PartCommit,
            session_id: self.session_id.clone(),
            message_id: Some(self.message_id.clone()),
            part_id: Some(part_id),
            data: Some(serde_json::json!({
                "kind": "text",
                "data": { "text": text },
                "seq": seq,
            })),
            seq: None,
        }]
    }
}

// ── Turn state ──────────────────────────────────────────────────────────────

/// Live mirror of the turn for event emission — the TS `Turn` struct's
/// block/timeline/usage fields.
struct TurnState {
    final_text: String,
    reasoning: String,
    text_block: Option<String>,
    reasoning_block: Option<String>,
    reasoning_seq: u32,
    timeline: Vec<TimelineEntry>,
    tool_calls: Vec<ToolCallWire>,
    usage: EngineUsage,
    last_step_usage: Option<EngineUsage>,
    steps_completed: u32,
}

impl TurnState {
    fn new() -> Self {
        Self {
            final_text: String::new(),
            reasoning: String::new(),
            text_block: None,
            reasoning_block: None,
            reasoning_seq: 0,
            timeline: Vec::new(),
            tool_calls: Vec::new(),
            usage: EngineUsage::default(),
            last_step_usage: None,
            steps_completed: 0,
        }
    }

    fn append_text(&mut self, text: &str) {
        if let Some(TimelineEntry::Text { text: buffer }) = self.timeline.last_mut() {
            buffer.push_str(text);
        } else {
            self.timeline.push(TimelineEntry::Text { text: text.to_owned() });
        }
    }
}

struct PendingCall {
    tool_call_id: String,
    tool_name: String,
    arguments: serde_json::Value,
}

enum LoopOutcome {
    Finish(TurnStopReason),
    Aborted,
}

// ── The loop ────────────────────────────────────────────────────────────────

/// Run one full agent turn to completion (or abort). Returns Err ONLY for
/// pre-loop setup failures (missing session, unreadable store); everything
/// the model/provider does wrong is an error+turn_end event pair.
pub async fn execute_turn(
    hub: &ChatHub,
    spec: &TurnSpec,
    engine: Arc<dyn StepStream>,
    tools: Vec<Arc<dyn Tool>>,
    turn: TurnHandle,
) -> Result<(), String> {
    let session_id = spec.session_id.as_str();

    // v2 message row lands at turn start (parts reference it; message.end
    // completes it). A failed insert = no v2 session row → v2 emission off,
    // streaming continues push-only (TS initV2Turn semantics).
    let message_id = new_message_id();
    let v2 = {
        let writer = hub.writer().lock().expect("sink writer poisoned");
        writer
            .insert_message(
                InsertMessageInput {
                    id: &message_id,
                    session_id,
                    role: "assistant",
                    model: Some(&spec.model_id),
                },
                unix_ms_now(),
            )
            .is_ok()
    };

    // Barrier: the just-persisted user part commits before the history read.
    hub.sink().flush().await;
    let reader = SessionsV2::open(hub.db_path()).map_err(|e| e.to_string())?;
    let window = reader
        .session_messages(session_id, SessionWindowOptsV2::default())
        .map_err(|e| e.to_string())?;
    let mut history = history_from_messages(&window.messages);
    if history.is_empty() {
        return Err("turn request has no messages".to_owned());
    }

    let engine_tools: Vec<EngineToolSpec> = tools
        .iter()
        .map(|t| {
            let spec = t.spec();
            EngineToolSpec {
                name: spec.name,
                description: spec.description,
                parameters: spec.parameters,
            }
        })
        .collect();

    let params = TurnParams {
        system: Some(system_prompt()),
        thinking_level: spec.thinking_level,
        reasoning_contracts: Vec::new(),
        model_max_output_tokens: spec.model_max_output_tokens,
    };

    let sink = hub.sink();
    let mut state = TurnState::new();
    let mut tracker = TurnTracker::new(session_id, &message_id);
    let mut gate = PermissionGate::from_workspace(&spec.workspace_root);
    let tool_ctx = ToolContext {
        session_id: session_id.to_owned(),
        workspace_root: spec.workspace_root.clone(),
        abort: turn.tool_abort.clone(),
    };
    let started = Instant::now();
    let mut retry_count = 0u32;
    let mut last_error: Option<String> = None;

    let mut abort_rx = turn.abort_rx.clone();
    let outcome = loop {
        if turn.is_aborted() {
            break LoopOutcome::Aborted;
        }

        let history_len_before_step = history.len();
        let mut stream = engine.stream_step(TurnRequest {
            messages: history.clone(),
            tools: engine_tools.clone(),
            params: params.clone(),
        });

        let mut pending_calls: Vec<PendingCall> = Vec::new();
        let mut step_error: Option<String> = None;
        let mut step_stop: Option<EngineStopReason> = None;
        let mut aborted_mid_stream = false;

        loop {
            tokio::select! {
                biased;
                _ = abort_rx.changed() => {
                    if turn.is_aborted() {
                        aborted_mid_stream = true;
                        break;
                    }
                }
                item = stream.next() => match item {
                    None => break,
                    Some(Ok(event)) => {
                        handle_engine_event(
                            hub, &mut state, &mut tracker, &mut pending_calls,
                            &mut step_stop, &mut history, &message_id, &event, v2,
                        );
                    }
                    Some(Err(e)) => {
                        let message = e.to_string();
                        last_error = Some(message.clone());
                        step_error = Some(message);
                    }
                }
            }
        }
        drop(stream);

        if aborted_mid_stream || turn.is_aborted() {
            break LoopOutcome::Aborted;
        }

        if let Some(error) = step_error {
            if retry_count < TURN_MAX_RETRIES && is_transient_error(&error) {
                retry_count += 1;
                hub.emit_agent(AgentEvent::Retry {
                    session_id: session_id.to_owned(),
                    seq: hub.next_seq(session_id),
                    attempt: retry_count,
                    max_attempts: TURN_MAX_RETRIES,
                    reason: error,
                });
                // The failed attempt's partial assistant message must not
                // ride into the retried request.
                history.truncate(history_len_before_step);
                abortable_sleep(spec.retry_delay, &mut abort_rx).await;
                if turn.is_aborted() {
                    break LoopOutcome::Aborted;
                }
                continue;
            }
            // Error emission happens once, in the close-out (TS emitTurnEnd:
            // error before turn_end, only at exhaustion).
            break LoopOutcome::Finish(TurnStopReason::Refusal);
        }

        // Clean step: the retry budget re-earns (a later step must not be
        // doomed by an earlier step's recovered retries) and stale errors
        // must not resurface on a later abort.
        retry_count = 0;
        last_error = None;
        state.steps_completed += 1;

        // Execute the step's tool calls (emission order), gated.
        let step_message = history.last().cloned();
        let call_id_map = step_message.as_ref().map(|m| map_call_ids(m, &pending_calls));
        let mut step_results: Vec<HistoryPart> = Vec::new();
        let mut had_tool_calls = false;
        for call in &pending_calls {
            had_tool_calls = true;
            let outcome = run_gated_tool(
                hub, spec, &turn, &mut gate, &tool_ctx, &tools, call,
                &call_id_map, &message_id, &mut state, &mut tracker, v2,
            )
            .await;
            if let Some(result) = outcome {
                step_results.push(result);
            }
            if turn.is_aborted() {
                break;
            }
        }
        if !step_results.is_empty() {
            history.push(HistoryMessage {
                role: HistoryRole::User,
                parts: step_results,
            });
        }
        if turn.is_aborted() {
            break LoopOutcome::Aborted;
        }

        let stop = step_stop.unwrap_or(EngineStopReason::Other("unknown".to_owned()));
        match stop {
            EngineStopReason::ToolUse if had_tool_calls => {
                if state.steps_completed >= spec.max_steps {
                    break LoopOutcome::Finish(TurnStopReason::IterationLimit);
                }
                continue;
            }
            EngineStopReason::ToolUse => {
                // Tool calls failed to map/execute — nothing to answer; a
                // bare loop would spin, so end the turn instead.
                break LoopOutcome::Finish(TurnStopReason::EndTurn);
            }
            EngineStopReason::EndTurn => break LoopOutcome::Finish(TurnStopReason::EndTurn),
            EngineStopReason::MaxTokens => break LoopOutcome::Finish(TurnStopReason::MaxTokens),
            EngineStopReason::Refusal => break LoopOutcome::Finish(TurnStopReason::Refusal),
            EngineStopReason::ContentFilter => {
                break LoopOutcome::Finish(TurnStopReason::ContentFilter)
            }
            EngineStopReason::Other(_) => break LoopOutcome::Finish(TurnStopReason::EndTurn),
        }
    };

    // ── close out ──
    let stop_reason = match outcome {
        LoopOutcome::Finish(reason) => reason,
        LoopOutcome::Aborted => TurnStopReason::Aborted,
    };
    // Aborted turns surface why they were failing, if they were (TS
    // emitTurnEnd: failureMsg on refusal|aborted).
    if matches!(stop_reason, TurnStopReason::Refusal | TurnStopReason::Aborted) {
        if let Some(message) = last_error {
            hub.emit_agent(AgentEvent::Error {
                session_id: session_id.to_owned(),
                seq: hub.next_seq(session_id),
                message,
            });
        }
    }
    let usage = state.usage;
    if v2 {
        for event in tracker.finish(to_sink_usage(&usage)) {
            sink.emit(event);
        }
    }
    let timeline = state
        .timeline
        .into_iter()
        .filter(|e| !matches!(e, TimelineEntry::Text { text } if text.trim().is_empty()))
        .collect::<Vec<_>>();
    hub.emit_agent(AgentEvent::TurnEnd {
        session_id: session_id.to_owned(),
        seq: hub.next_seq(session_id),
        message_id: message_id.clone(),
        stop_reason,
        content: state.final_text.clone(),
        timeline: Some(timeline),
        reasoning: (!state.reasoning.is_empty()).then(|| state.reasoning.clone()),
        reasoning_tokens: (usage.reasoning_tokens > 0).then_some(usage.reasoning_tokens),
        total_ms: Some(started.elapsed().as_millis() as u64),
        tool_calls: (!state.tool_calls.is_empty()).then(|| state.tool_calls.clone()),
        usage: Some(usage),
        last_step_usage: state.last_step_usage,
    });
    Ok(())
}

/// Translate one EngineEvent into AgentEvents + sink events + state updates.
/// Appends the StepEnd assistant message to `history`.
#[allow(clippy::too_many_arguments)]
fn handle_engine_event(
    hub: &ChatHub,
    state: &mut TurnState,
    tracker: &mut TurnTracker,
    pending_calls: &mut Vec<PendingCall>,
    step_stop: &mut Option<EngineStopReason>,
    history: &mut Vec<HistoryMessage>,
    message_id: &str,
    event: &EngineEvent,
    v2: bool,
) {
    let session_id = tracker.session_id.clone();
    let sink = hub.sink();
    match event {
        EngineEvent::Delta { text } => {
            let block_id = match &state.text_block {
                Some(id) => id.clone(),
                None => {
                    let id = new_part_id();
                    state.text_block = Some(id.clone());
                    id
                }
            };
            if v2 {
                for ev in tracker.text_delta(&block_id, text) {
                    sink.emit(ev);
                }
            }
            state.final_text.push_str(text);
            state.append_text(text);
            hub.emit_agent(AgentEvent::Delta {
                session_id: session_id.clone(),
                seq: hub.next_seq(&session_id),
                message_id: message_id.to_owned(),
                text: text.clone(),
                block_id,
            });
        }
        EngineEvent::Reasoning { delta } => {
            let block_id = match &state.reasoning_block {
                Some(id) => id.clone(),
                None => {
                    state.reasoning_seq += 1;
                    let id = format!("{message_id}-r{}", state.reasoning_seq);
                    state.reasoning_block = Some(id.clone());
                    id
                }
            };
            state.reasoning.push_str(delta);
            hub.emit_agent(AgentEvent::Reasoning {
                session_id: session_id.clone(),
                seq: hub.next_seq(&session_id),
                message_id: message_id.to_owned(),
                delta: delta.clone(),
                block_id,
            });
        }
        EngineEvent::ToolCallStart {
            tool_call_id,
            tool_name,
        } => {
            if v2 {
                for ev in tracker.tool_start(tool_call_id) {
                    sink.emit(ev);
                }
            }
            // A tool call closes the open text segment AND the thinking
            // segment (next step's reasoning opens a fresh block).
            state.text_block = None;
            state.reasoning_block = None;
            hub.emit_agent(AgentEvent::ToolCallStart {
                session_id: session_id.clone(),
                seq: hub.next_seq(&session_id),
                message_id: message_id.to_owned(),
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                block_id: tool_call_id.clone(),
            });
        }
        EngineEvent::ToolCallDelta {
            tool_call_id,
            delta,
        } => {
            hub.emit_agent(AgentEvent::ToolCallDelta {
                session_id: session_id.clone(),
                seq: hub.next_seq(&session_id),
                tool_call_id: tool_call_id.clone(),
                delta: delta.clone(),
            });
        }
        EngineEvent::ToolCall {
            tool_call_id,
            tool_name,
            arguments,
        } => {
            // Defensive: a start-less call (engine-shape gap) still gets its
            // part armed and the open text committed at the boundary.
            if v2 {
                for ev in tracker.ensure_armed(tool_call_id) {
                    sink.emit(ev);
                }
            }
            pending_calls.push(PendingCall {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                arguments: arguments.clone(),
            });
            hub.emit_agent(AgentEvent::ToolCall {
                session_id: session_id.clone(),
                seq: hub.next_seq(&session_id),
                message_id: message_id.to_owned(),
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                arguments: arguments.clone(),
                arg_preview: format_arg_preview(tool_name, arguments),
                risk_tier: risk_tier_for(tool_name),
            });
        }
        EngineEvent::Usage { tokens } => {
            accumulate_usage(&mut state.usage, tokens);
            state.last_step_usage = Some(*tokens);
            hub.emit_agent(AgentEvent::Usage {
                session_id: session_id.clone(),
                seq: hub.next_seq(&session_id),
                message_id: message_id.to_owned(),
                tokens: *tokens,
                cost_usd: tokens.cost_usd,
                running_total_usd: state.usage.cost_usd,
                iteration: state.steps_completed + 1,
            });
        }
        EngineEvent::StepEnd { stop_reason, message } => {
            *step_stop = Some(stop_reason.clone());
            history.push(message.clone());
        }
    }
}

/// Gate + execute one tool call; emits tool_result, persists the v2 tool
/// part, and returns the user-side ToolResult history part (None when the
/// call could not be mapped at all).
#[allow(clippy::too_many_arguments)]
async fn run_gated_tool(
    hub: &ChatHub,
    spec: &TurnSpec,
    turn: &TurnHandle,
    gate: &mut PermissionGate,
    tool_ctx: &ToolContext,
    tools: &[Arc<dyn Tool>],
    call: &PendingCall,
    call_id_map: &Option<HashMap<String, String>>,
    message_id: &str,
    state: &mut TurnState,
    tracker: &mut TurnTracker,
    v2: bool,
) -> Option<HistoryPart> {
    let session_id = spec.session_id.as_str();
    let mode = turn.mode();

    // Escalation + remember rules may have mutated the gate's rule set mid-
    // turn; the check itself is stateless over it.
    let decision = gate.check(mode, &call.tool_name, &call.arguments);
    let outcome = match decision {
        Decision::Allow => execute_tool(hub, session_id, tools, tool_ctx, call).await,
        Decision::Deny { reason } => ToolOutcome::rejected(reason),
        Decision::Ask {
            risk,
            reason: _,
            allow_rule,
        } => {
            hub.emit_agent(AgentEvent::PermissionRequired {
                session_id: session_id.to_owned(),
                seq: hub.next_seq(session_id),
                tool_calls: vec![ToolCallWire {
                    id: call.tool_call_id.clone(),
                    message_id: message_id.to_owned(),
                    tool_name: call.tool_name.clone(),
                    arguments: call.arguments.clone(),
                    arg_preview: format_arg_preview(&call.tool_name, &call.arguments),
                    status: "pending".to_owned(),
                    risk_tier: risk,
                    gate_decision: Some(if mode == AutonomyMode::Plan {
                        "blocked"
                    } else {
                        "ask"
                    }),
                    allow_rule: Some(allow_rule.clone()),
                    output: None,
                    display: None,
                    duration_ms: None,
                    meta: None,
                }],
                timeout_at: unix_ms_now() + spec.permission_timeout.as_millis() as i64,
            });
            let rx = hub.register_ask(session_id, &call.tool_call_id);
            let answer = tokio::time::timeout(spec.permission_timeout, rx).await;
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
            if answer.approve {
                if answer.remember {
                    if let Some(rule) = parse_rule(&allow_rule) {
                        let mut rules = gate.rules().clone();
                        rules.allow.push(rule);
                        gate.set_rules(rules);
                    }
                }
                execute_tool(hub, session_id, tools, tool_ctx, call).await
            } else {
                ToolOutcome::rejected(
                    answer
                        .reason
                        .unwrap_or_else(|| "rejected by user".to_owned()),
                )
            }
        }
    };

    let status_str = serde_json::to_value(outcome.status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "failed".to_owned());
    state.tool_calls.push(ToolCallWire {
        id: call.tool_call_id.clone(),
        message_id: message_id.to_owned(),
        tool_name: call.tool_name.clone(),
        arguments: call.arguments.clone(),
        arg_preview: format_arg_preview(&call.tool_name, &call.arguments),
        status: status_str,
        risk_tier: risk_tier_for(&call.tool_name),
        gate_decision: None,
        allow_rule: None,
        output: Some(outcome.output.clone()),
        display: outcome.display.clone(),
        duration_ms: outcome.duration_ms,
        meta: outcome.meta.clone(),
    });
    state
        .timeline
        .push(TimelineEntry::Tool { tool_index: state.tool_calls.len() - 1 });

    hub.emit_agent(AgentEvent::ToolResult {
        session_id: session_id.to_owned(),
        seq: hub.next_seq(session_id),
        tool_call_id: call.tool_call_id.clone(),
        status: outcome.status,
        output: Some(outcome.output.clone()),
        display: outcome.display.clone(),
        duration_ms: outcome.duration_ms,
        meta: outcome.meta.clone(),
    });
    if v2 {
        for ev in tracker.tool_end(
            &call.tool_call_id,
            V2ToolEnd {
                tool_name: call.tool_name.clone(),
                input: call.arguments.clone(),
                output: Some(outcome.output.clone()),
                status: outcome.status,
                duration_ms: outcome.duration_ms,
            },
        ) {
            hub.sink().emit(ev);
        }
    }

    let call_id = call_id_map
        .as_ref()
        .and_then(|m| m.get(&call.tool_call_id).cloned())
        .unwrap_or_else(|| call.tool_call_id.clone());
    Some(HistoryPart::ToolResult {
        call_id,
        tool_name: call.tool_name.clone(),
        output: outcome.output.clone(),
    })
}

async fn execute_tool(
    hub: &ChatHub,
    session_id: &str,
    tools: &[Arc<dyn Tool>],
    tool_ctx: &ToolContext,
    call: &PendingCall,
) -> ToolOutcome {
    let Some(tool) = tools.iter().find(|t| t.spec().name == call.tool_name) else {
        return ToolOutcome::failed(format!("Unknown tool: {}", call.tool_name));
    };
    hub.emit_agent(AgentEvent::ToolExecuting {
        session_id: session_id.to_owned(),
        seq: hub.next_seq(session_id),
        tool_call_id: call.tool_call_id.clone(),
    });
    let started = Instant::now();
    let tool = Arc::clone(tool);
    let ctx = tool_ctx.clone();
    let args = call.arguments.clone();
    let joined = tokio::task::spawn_blocking(move || tool.execute(&ctx, args)).await;
    let mut outcome = match joined {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(tide_tools::ToolError::Aborted)) => ToolOutcome {
            status: OutcomeStatus::Aborted,
            output: "Tool execution aborted.".to_owned(),
            display: None,
            meta: None,
            duration_ms: Some(started.elapsed().as_millis() as u64),
        },
        Ok(Err(e)) => ToolOutcome::failed(e.to_string()),
        Err(e) => ToolOutcome::failed(format!("tool task failed: {e}")),
    };
    if outcome.duration_ms.is_none() {
        outcome.duration_ms = Some(started.elapsed().as_millis() as u64);
    }
    outcome
}

/// Pending-call (engine stream correlator) → provider tool-call id, by
/// matching name+arguments against the StepEnd message's ToolCall parts
/// (order-preserving within equal-signature groups). Keeps Anthropic's
/// assistant tool_use ↔ user tool_result id pairing consistent on replay.
fn map_call_ids(step_message: &HistoryMessage, pending: &[PendingCall]) -> HashMap<String, String> {
    let mut groups: HashMap<(String, String), VecDeque<String>> = HashMap::new();
    for part in &step_message.parts {
        if let HistoryPart::ToolCall {
            id,
            tool_name,
            arguments,
        } = part
        {
            groups
                .entry((tool_name.clone(), arguments.to_string()))
                .or_default()
                .push_back(id.clone());
        }
    }
    pending
        .iter()
        .map(|call| {
            let key = (call.tool_name.clone(), call.arguments.to_string());
            let mapped = groups
                .get_mut(&key)
                .and_then(|queue| queue.pop_front())
                .unwrap_or_else(|| call.tool_call_id.clone());
            (call.tool_call_id.clone(), mapped)
        })
        .collect()
}

fn accumulate_usage(total: &mut EngineUsage, step: &EngineUsage) {
    total.input_tokens += step.input_tokens;
    total.output_tokens += step.output_tokens;
    total.cache_read += step.cache_read;
    total.cache_write += step.cache_write;
    total.reasoning_tokens += step.reasoning_tokens;
    total.calls += step.calls.max(1);
    total.cost_usd += step.cost_usd;
}

fn to_sink_usage(usage: &EngineUsage) -> SinkUsage {
    SinkUsage {
        input_tokens: usage.input_tokens as i64,
        output_tokens: usage.output_tokens as i64,
        reasoning_tokens: (usage.reasoning_tokens > 0).then_some(usage.reasoning_tokens as i64),
        cache_read: (usage.cache_read > 0).then_some(usage.cache_read as i64),
        cost_usd: usage.cost_usd,
    }
}

async fn abortable_sleep(duration: Duration, abort_rx: &mut watch::Receiver<bool>) {
    tokio::select! {
        _ = tokio::time::sleep(duration) => {}
        _ = abort_rx.changed() => {}
    }
}

// ── Error classification — port of isTransientError/isContextOverflow ──────

pub(crate) fn is_transient_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    if lower.contains("no output generated") {
        return false;
    }
    if ["api key", "unauthorized", "forbidden", "401", "403"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return false;
    }
    if is_context_overflow(&lower) {
        return false;
    }
    true
}

pub(crate) fn is_context_overflow(lower: &str) -> bool {
    if lower.contains("prompt too long") {
        return true;
    }
    // `context.{0,20}length`-style TS patterns: needle b within `gap` chars
    // after needle a.
    if within(lower, "context", "length", 20)
        || within(lower, "context", "exceed", 20)
        || within(lower, "maximum", "context", 20)
        || within(lower, "request", "too large", 20)
        || within(lower, "token", "limit", 20)
        || (within(lower, "input", "token", 20) && within(lower, "token", "limit", 20))
    {
        return true;
    }
    // `/code["']?:\s*["']?1261/i`
    lower.contains("code 1261") || lower.contains("code: 1261") || lower.contains("code:1261")
}

fn within(haystack: &str, a: &str, b: &str, gap: usize) -> bool {
    let mut from = 0;
    while let Some(start) = haystack[from..].find(a) {
        let after = from + start + a.len();
        let window_end = (after + gap).min(haystack.len());
        if haystack[after..window_end].contains(b) {
            return true;
        }
        from = after;
    }
    false
}

/// core_tools as shared Arc handles (the turn loop holds tools by Arc).
pub fn core_tools_shared() -> Vec<Arc<dyn Tool>> {
    tide_tools::core_tools()
        .into_iter()
        .map(Arc::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_classification_matches_the_ts_regexes() {
        assert!(is_transient_error("connection reset by peer"));
        assert!(is_transient_error("HTTP 500: upstream blew up"));
        assert!(!is_transient_error("The API key is invalid"));
        assert!(!is_transient_error("Unauthorized request"));
        assert!(!is_transient_error("403 Forbidden"));
        assert!(!is_transient_error("no output generated (provider returned an empty stream)"));
        assert!(!is_transient_error("prompt too long: 200000 tokens > 128000 limit"));
        assert!(is_context_overflow(&"maximum context length exceeded".to_lowercase()));
        assert!(is_context_overflow("request entity too large"));
        assert!(!is_transient_error("request entity too large"));
    }

    #[test]
    fn system_prompt_strips_generated_header() {
        let prompt = system_prompt();
        assert!(!prompt.contains("AUTO-GENERATED"));
        assert!(prompt.contains("You are Tide"), "prompt body present");
    }
}
