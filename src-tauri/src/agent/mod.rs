//! The orchestrator domain (M2): turn loop, EventSink, and the chat command
//! surface. Sits above the churn firewall — talks to tide-engine
//! abstractions ([`orchestrator::StepStream`]) and tide-tools' `Tool` +
//! permission gate; never touches rig directly.
//!
//! - [`events`] — the AgentEvent wire union + the Channel push envelope.
//! - [`sink`] — batched (~50ms) event persistence + live FlushBatch pushes.
//! - [`history`] — sessions-v2 parts → engine history mapping.
//! - [`hub`] — process-wide chat state: active turns, permission registry,
//!   push broadcast, seq counters.
//! - [`mcp`] — the MCP pool cell (user servers boot-connected, project
//!   servers per workspace) feeding MCP tools into each turn's tool list.
//! - [`orchestrator`] — the turn loop (stream → events → tools → repeat).

pub mod events;
pub mod history;
pub mod hub;
pub mod mcp;
pub mod orchestrator;
pub mod sink;

#[cfg(test)]
mod turn_tests;
