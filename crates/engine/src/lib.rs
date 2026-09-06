//! rig agent engine — the ONLY crate permitted to depend on rig (churn firewall).
//!
//! Wraps [`rig_core`] (pinned 0.42) for Tide's two provider styles (Anthropic
//! Messages + OpenAI-compatible chat completions) behind Tide's own abstractions:
//!
//! - [`quirk`]: the provider quirk layer — thinking-budget carve (never
//!   stacked), host-based thinking strip, tool-output token floor, tool-input
//!   repair — validated against the M0 SSE fixtures in `fixtures/sse/`.
//! - [`events`]: [`EngineEvent`] — the streaming subset of the renderer's
//!   AgentEvent union (`src/lib/agent/events.ts`), field-compatible.
//! - [`history`]: [`HistoryMessage`] — the engine's normalized history, shaped
//!   after both rig's message types and the sessions-v2 part kinds.
//! - [`model`]: [`EngineModel::from_config`] — provider construction.
//! - [`turn`]: [`stream_step`] — one completion step as a Stream. The agentic
//!   loop (tool execution, permissions, retries, abort) lives in the app
//!   crate's orchestrator, above this firewall.
//!
//! SSE stall watchdog: the reqwest client injected into rig carries a
//! `read_timeout` ([`quirk::SSE_READ_TIMEOUT`]) that fires per response-body
//! read and resets on every chunk — the same semantics as the TS stack's
//! chunk-idle wrapper, scoped to the response body so long tool execution is
//! unaffected.

pub mod events;
pub mod history;
pub mod model;
pub mod quirk;
pub mod turn;

#[cfg(test)]
pub(crate) mod fixture_tests;
#[cfg(test)]
pub(crate) mod mock_sse;

pub use events::{EngineEvent, EngineStopReason, EngineUsage};
pub use history::{HistoryMessage, HistoryPart, HistoryRole};
pub use model::{EngineModel, EngineModelConfig, ProviderApiStyle};
pub use quirk::{
    anthropic_call_options, budget_to_effort, clamp_tool_result_output, is_context_overflow_error,
    is_native_anthropic_host, openai_call_options, repair_json_tool_input, resolve_reasoning,
    ProtocolCallOptions, ProtocolContext, ReasoningInstruction, ReasoningOption, ThinkingLevel,
    DEFAULT_MAX_TOKENS, SSE_READ_TIMEOUT, TOOL_OUTPUT_FLOOR,
};
pub use turn::{stream_step, ToolSpec, TurnParams, TurnRequest};

/// Errors surfaced by the engine. Transport/stream failures carry rig's
/// `CompletionError` text; the orchestrator decides retry policy.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("provider construction failed: {0}")]
    Config(String),
    #[error("stream failed: {0}")]
    Stream(#[from] rig_core::completion::CompletionError),
}
