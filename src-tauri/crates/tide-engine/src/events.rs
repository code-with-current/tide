//! Engine event contract — the streaming subset of the renderer's AgentEvent
//! union (`src/lib/agent/events.ts`).
//!
//! Byte-compatibility: each variant serializes with the same `type`
//! discriminator and camelCase payload fields as its TS counterpart
//! (`{"type":"tool_call_delta","toolCallId":…,"delta":…}`). The orchestrator
//! (T4) wraps each event with the per-event envelope the full wire format
//! requires — `sessionId`, `seq`, `messageId`, `blockId` — none of which the
//! engine can know. Tool-result, permission, retry, compaction and turn-end
//! events are orchestrator concerns and deliberately absent here; the engine's
//! terminal event is [`EngineEvent::StepEnd`] (one completion step).

use serde::{Deserialize, Serialize};

use crate::history::HistoryMessage;

/// Normalized per-step token usage — the renderer `Usage` shape
/// (`src/types/index.ts`) that TS `UsageEvent.tokens` carries. `calls` is 1
/// per step; `costUsd` is priced by the orchestrator (0.0 until pricing
/// lands there).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub reasoning_tokens: u64,
    pub calls: u64,
    pub cost_usd: f64,
}

impl EngineUsage {
    pub const fn step() -> Self {
        Self {
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            cache_write: 0,
            reasoning_tokens: 0,
            calls: 1,
            cost_usd: 0.0,
        }
    }
}

impl From<&rig_core::completion::Usage> for EngineUsage {
    fn from(usage: &rig_core::completion::Usage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read: usage.cached_input_tokens,
            cache_write: usage.cache_creation_input_tokens,
            reasoning_tokens: usage.reasoning_tokens,
            calls: 1,
            cost_usd: 0.0,
        }
    }
}

/// Why the step ended — the engine-visible slice of the TS `TurnEndEvent`
/// stop-reason vocabulary. `Other` carries a provider-specific reason
/// verbatim (e.g. Anthropic `pause_turn`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineStopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    Refusal,
    ContentFilter,
    Other(String),
}

impl From<rig_core::completion::FinishReason> for EngineStopReason {
    fn from(reason: rig_core::completion::FinishReason) -> Self {
        match reason {
            rig_core::completion::FinishReason::Stop => Self::EndTurn,
            rig_core::completion::FinishReason::Length => Self::MaxTokens,
            rig_core::completion::FinishReason::ToolCalls => Self::ToolUse,
            rig_core::completion::FinishReason::ContentFilter => Self::ContentFilter,
            rig_core::completion::FinishReason::Other(other) => Self::Other(other),
        }
    }
}

/// One streamed completion event. See the module docs for the wire contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EngineEvent {
    /// Streamed assistant text token — TS `delta`.
    Delta { text: String },
    /// Streamed reasoning token (Anthropic `thinking`, GLM
    /// `reasoning_content`, …) — TS `reasoning`.
    Reasoning { delta: String },
    /// Tool call started: id + name known, args still streaming — TS
    /// `tool_call_start`. The id is the engine's stream correlator (stable
    /// across the call's `ToolCallDelta`s and final `ToolCall`).
    ToolCallStart {
        tool_call_id: String,
        tool_name: String,
    },
    /// Partial tool-args JSON fragment — TS `tool_call_delta`.
    ToolCallDelta { tool_call_id: String, delta: String },
    /// Tool call fully assembled and parsed — TS `tool_call` (without the
    /// UI-only `argPreview`/`riskTier`, which the orchestrator derives).
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
    },
    /// Final usage for this step — TS `usage` (token payload only).
    Usage { tokens: EngineUsage },
    /// The step ended. Carries the assistant message to append to history
    /// (text/thinking/tool-call parts in emission order, with the provider
    /// tool-call ids needed for wire replay) plus the normalized stop
    /// reason. The orchestrator decides whether the loop continues.
    StepEnd {
        stop_reason: EngineStopReason,
        message: HistoryMessage,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire contract: each variant serializes exactly like its TS
    /// AgentEvent counterpart's payload (same `type` tag, same camelCase
    /// fields) — the orchestrator only adds the envelope fields
    /// (sessionId/seq/messageId/blockId) around these.
    #[test]
    fn engine_event_wire_shapes_match_ts() {
        let cases: [(EngineEvent, &str); 7] = [
            (
                EngineEvent::Delta {
                    text: "hi".to_owned(),
                },
                r#"{"type":"delta","text":"hi"}"#,
            ),
            (
                EngineEvent::Reasoning {
                    delta: "hm".to_owned(),
                },
                r#"{"type":"reasoning","delta":"hm"}"#,
            ),
            (
                EngineEvent::ToolCallStart {
                    tool_call_id: "t1".to_owned(),
                    tool_name: "bash".to_owned(),
                },
                r#"{"type":"tool_call_start","toolCallId":"t1","toolName":"bash"}"#,
            ),
            (
                EngineEvent::ToolCallDelta {
                    tool_call_id: "t1".to_owned(),
                    delta: "{\"a\"".to_owned(),
                },
                r#"{"type":"tool_call_delta","toolCallId":"t1","delta":"{\"a\""}"#,
            ),
            (
                EngineEvent::ToolCall {
                    tool_call_id: "t1".to_owned(),
                    tool_name: "bash".to_owned(),
                    arguments: serde_json::json!({ "cmd": "ls" }),
                },
                r#"{"type":"tool_call","toolCallId":"t1","toolName":"bash","arguments":{"cmd":"ls"}}"#,
            ),
            (
                EngineEvent::Usage {
                    tokens: EngineUsage::step(),
                },
                r#"{"type":"usage","tokens":{"inputTokens":0,"outputTokens":0,"cacheRead":0,"cacheWrite":0,"reasoningTokens":0,"calls":1,"costUsd":0.0}}"#,
            ),
            (
                EngineEvent::StepEnd {
                    stop_reason: EngineStopReason::ToolUse,
                    message: crate::history::HistoryMessage::user_text("x"),
                },
                r#"{"type":"step_end","stopReason":"tool_use","message":{"role":"user","parts":[{"type":"text","text":"x"}]}}"#,
            ),
        ];
        for (event, want) in cases {
            assert_eq!(serde_json::to_string(&event).unwrap(), want);
        }
    }
}
