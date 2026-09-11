//! Tide's authenticated WebSocket server and RPC dispatch layer.
//!
//! This crate owns connection handling, request idempotency, subscriptions,
//! and the bounded event replay journal. It depends only on the shared
//! protocol in production; provider, persistence, filesystem, and Git
//! implementations stay behind the [`Backend`] trait.

mod server;
mod wire;

pub use server::{Backend, EventSink, ServerCore, ServerOptions, serve, serve_with_core};
pub use wire::{
    APP_EXECUTABLE_ENV, ClientMessage, Command, DAEMON_ADDRESS_ENV, DAEMON_TOKEN_ENV, DaemonReady,
    PROTOCOL_VERSION, ReplayCursor, Request, ResponseOutcome, ResponsePayload, RpcError,
    SequencedEvent, ServerMessage, WireComputerToolRequest, WireDriverEvent,
    WireDriverStartOptions, WireSessionOptions,
};
