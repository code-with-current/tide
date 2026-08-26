//! AgentEvent wire contract — the orchestrator→renderer union
//! (`src/lib/agent/events.ts`). Every variant carries the per-session
//! envelope (`sessionId`, monotonic `seq`) the engine cannot know; payloads
//! serialize byte-compatible with the TS shapes (tagged `type`, camelCase
//! fields, TS `?` optionals omitted).
//!
//! The engine's streaming subset arrives here wrapped by the orchestrator;
//! tool-result / permission / retry / error / turn_end are orchestrator-only
//! and defined here directly. Optional renderer extras the M2 orchestrator
//! does not produce (`parentToolCallId`, sub-agent kinds, `blocks` on
//! turn_end — the renderer's reducer builds blocks from the streamed deltas)
//! are deliberately absent.

use serde::Serialize;
use serde_json::Value;
use tide_engine::EngineUsage;
use tide_store::sessions_v2_write::FlushBatchWire;
use tide_tools::{OutcomeStatus, RiskTier, ToolDisplay};

/// `TurnEndEvent.stopReason` vocabulary (events.ts). The full union is kept
/// even where the M2 loop never produces a variant — the wire vocabulary is
/// the contract, not the producer set.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    PauseTurn,
    Refusal,
    ContentFilter,
    IterationLimit,
    PermissionTimeout,
    SpendCap,
    Aborted,
}

/// `TurnEndEvent.timeline` entries.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum TimelineEntry {
    Text { text: String },
    Tool { tool_index: usize },
}

/// The renderer `ToolCall` (`src/types/index.ts`) — the permission card's
/// payload and the turn_end summary row. `status` is the renderer's
/// `ToolCallStatus` string: `pending` while a permission card awaits an
/// answer, `OutcomeStatus` strings on results.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallWire {
    pub id: String,
    pub message_id: String,
    pub tool_name: String,
    pub arguments: Value,
    pub arg_preview: String,
    pub status: String,
    pub risk_tier: RiskTier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate_decision: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<ToolDisplay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<String>,
}

/// The AgentEvent union subset the Rust orchestrator emits. Field order in
/// each variant follows events.ts; `skip_serializing_if` mirrors TS `?`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    /// Streamed assistant text token — TS `delta`.
    Delta {
        session_id: String,
        seq: u64,
        message_id: String,
        text: String,
        block_id: String,
    },
    /// Streamed reasoning token — TS `reasoning`.
    Reasoning {
        session_id: String,
        seq: u64,
        message_id: String,
        delta: String,
        block_id: String,
    },
    /// Tool call started (id + name known) — TS `tool_call_start`.
    /// `block_id` always equals `tool_call_id` (documented TS invariant).
    ToolCallStart {
        session_id: String,
        seq: u64,
        message_id: String,
        tool_call_id: String,
        tool_name: String,
        block_id: String,
    },
    /// Partial tool-args JSON — TS `tool_call_delta`.
    ToolCallDelta {
        session_id: String,
        seq: u64,
        tool_call_id: String,
        delta: String,
    },
    /// Tool call assembled — TS `tool_call`.
    ToolCall {
        session_id: String,
        seq: u64,
        message_id: String,
        tool_call_id: String,
        tool_name: String,
        arguments: Value,
        arg_preview: String,
        risk_tier: RiskTier,
    },
    /// Execution started — TS `tool_executing`.
    ToolExecuting {
        session_id: String,
        seq: u64,
        tool_call_id: String,
    },
    /// Tool finished — TS `tool_result`.
    ToolResult {
        session_id: String,
        seq: u64,
        tool_call_id: String,
        status: OutcomeStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        display: Option<ToolDisplay>,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        meta: Option<String>,
    },
    /// Per-step usage — TS `usage`.
    Usage {
        session_id: String,
        seq: u64,
        message_id: String,
        tokens: EngineUsage,
        cost_usd: f64,
        running_total_usd: f64,
        iteration: u32,
    },
    /// Gate needs a human decision — TS `permission_required`.
    PermissionRequired {
        session_id: String,
        seq: u64,
        tool_calls: Vec<ToolCallWire>,
        timeout_at: i64,
    },
    /// Between retry attempts — TS `retry`.
    Retry {
        session_id: String,
        seq: u64,
        attempt: u32,
        max_attempts: u32,
        reason: String,
    },
    /// Terminal failure (retries exhausted) — TS `error`. Only ever emitted
    /// at exhaustion, followed by `turn_end`, so the renderer's isStreaming
    /// never flickers mid-retries.
    Error {
        session_id: String,
        seq: u64,
        message: String,
    },
    /// Turn complete — TS `turn_end`.
    TurnEnd {
        session_id: String,
        seq: u64,
        message_id: String,
        stop_reason: TurnStopReason,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeline: Option<Vec<TimelineEntry>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ToolCallWire>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<EngineUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_step_usage: Option<EngineUsage>,
    },
}

/// One message the Rust side pushes over the Tauri Channel. The `channel`
/// tag mirrors the two webview message names in `shared/rpc.ts`
/// (`agentEvents`, `orchestratorEvents`) so the renderer bridge routes by
/// the same discriminator the old RPC schema used.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "channel")]
// The Agent variant is ~320 bytes; broadcast buffers are capacity-bounded
// (1024 slots), so the padding cost is bounded and boxing every event would
// tax the hot path.
#[allow(clippy::large_enum_variant)]
pub enum ChatPush {
    #[serde(rename = "agentEvents")]
    Agent { event: AgentEvent },
    #[serde(rename = "orchestratorEvents")]
    Orchestrator { batch: FlushBatchWire },
}

/// Port of `formatArgPreview` for the core five (`app/core/agent/tools/types.ts`
/// @ 91ec558) — the short human preview on tool_call events and cards.
pub fn format_arg_preview(tool_name: &str, args: &Value) -> String {
    let arg = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default();
    let in_path = || {
        args.get("path")
            .and_then(Value::as_str)
            .map(|p| format!(" in {p}"))
            .unwrap_or_default()
    };
    match tool_name {
        "read_file" => {
            let max_lines = args.get("maxLines").and_then(Value::as_u64);
            format!(
                "{}{}",
                arg("path"),
                max_lines.map(|n| format!(", {n} lines")).unwrap_or_default()
            )
        }
        "glob" => format!("{}{}", arg("pattern"), in_path()),
        "grep" => format!("/{}/{}", arg("pattern"), in_path().trim_start_matches(" in ")),
        "bash" => arg("command").chars().take(80).collect(),
        "edit_file" | "write_file" => arg("path").to_owned(),
        _ => args
            .get("command")
            .or_else(|| args.get("path"))
            .or_else(|| args.get("pattern"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(80)
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delta_serializes_with_envelope_and_camel_case() {
        let event = AgentEvent::Delta {
            session_id: "s_1".into(),
            seq: 3,
            message_id: "m_1".into(),
            text: "hi".into(),
            block_id: "p_1".into(),
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "type": "delta", "sessionId": "s_1", "seq": 3,
                "messageId": "m_1", "text": "hi", "blockId": "p_1"
            })
        );
    }

    #[test]
    fn tool_result_omits_unset_optionals() {
        let event = AgentEvent::ToolResult {
            session_id: "s_1".into(),
            seq: 4,
            tool_call_id: "t_1".into(),
            status: OutcomeStatus::Executed,
            output: Some("done".into()),
            display: None,
            duration_ms: Some(12),
            meta: None,
        };
        let wire = serde_json::to_value(&event).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "type": "tool_result", "sessionId": "s_1", "seq": 4,
                "toolCallId": "t_1", "status": "executed",
                "output": "done", "durationMs": 12
            })
        );
        assert!(!wire.to_string().contains("display"));
        assert!(!wire.to_string().contains("meta"));
    }

    #[test]
    fn turn_end_carries_stop_reason_and_summaries() {
        let event = AgentEvent::TurnEnd {
            session_id: "s_1".into(),
            seq: 9,
            message_id: "m_1".into(),
            stop_reason: TurnStopReason::Aborted,
            content: "partial".into(),
            timeline: Some(vec![
                TimelineEntry::Text { text: "partial".into() },
                TimelineEntry::Tool { tool_index: 0 },
            ]),
            reasoning: None,
            reasoning_tokens: None,
            total_ms: Some(120),
            tool_calls: None,
            usage: Some(EngineUsage::step()),
            last_step_usage: None,
        };
        let wire = serde_json::to_value(&event).unwrap();
        assert_eq!(wire["stopReason"], serde_json::json!("aborted"));
        assert_eq!(wire["totalMs"], serde_json::json!(120));
        assert_eq!(wire["timeline"][1]["toolIndex"], serde_json::json!(0));
        assert_eq!(wire["usage"]["calls"], serde_json::json!(1));
        assert!(wire.get("reasoning").is_none());
    }

    #[test]
    fn chat_push_tag_matches_rpc_message_names() {
        let push = ChatPush::Agent {
            event: AgentEvent::Error {
                session_id: "s".into(),
                seq: 1,
                message: "boom".into(),
            },
        };
        let wire = serde_json::to_value(&push).unwrap();
        assert_eq!(wire["channel"], serde_json::json!("agentEvents"));
        assert_eq!(wire["event"]["type"], serde_json::json!("error"));
    }

    #[test]
    fn arg_previews_match_the_ts_shapes() {
        assert_eq!(
            format_arg_preview("bash", &serde_json::json!({"command": "cargo test"})),
            "cargo test"
        );
        assert_eq!(
            format_arg_preview("grep", &serde_json::json!({"pattern": "foo", "path": "src"})),
            "/foo/src"
        );
        assert_eq!(
            format_arg_preview("glob", &serde_json::json!({"pattern": "*.rs"})),
            "*.rs"
        );
        assert_eq!(
            format_arg_preview("read_file", &serde_json::json!({"path": "a.rs", "maxLines": 5})),
            "a.rs, 5 lines"
        );
        assert_eq!(
            format_arg_preview("bash", &serde_json::json!({"command": "x".repeat(100)})).len(),
            80
        );
    }
}
