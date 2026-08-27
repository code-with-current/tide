//! The orchestrator domain (M2): turn loop, EventSink, and the chat command
//! surface. Sits above the churn firewall — talks to tide-engine
//! abstractions ([`orchestrator::StepStream`]) and tide-tools' `Tool` +
//! permission gate; never touches rig directly.
//!
//! - [`events`] — the AgentEvent wire union + the Channel push envelope.
//! - [`sink`] — batched (~50ms) event persistence + live FlushBatch pushes.
//! - [`history`] — sessions-v2 parts → engine history mapping.
//! - [`hub`] — process-wide chat state: active turns, permission +
//!   followup registries, push broadcast, seq counters.
//! - [`mcp`] — the MCP pool cell (user servers boot-connected, project
//!   servers per workspace) feeding MCP tools into each turn's tool list.
//! - [`orchestrator`] — the turn loop (stream → events → tools → repeat).
//! - [`auto_compact`] — the multi-layer context compaction subsystem +
//!   summarizer seam the orchestrator drives between steps.
//! - [`dispatch`] — the sub-agent runner `dispatch_agent` spawns (child
//!   turn, catalog agent prompt/toolset, mirrored events, permission
//!   inheritance, abort propagation).

pub mod auto_compact;
pub mod dispatch;
pub mod events;
pub mod history;
pub mod hub;
pub mod mcp;
pub mod orchestrator;
pub mod sink;

#[cfg(test)]
mod dispatch_tests;
#[cfg(test)]
mod turn_tests;
