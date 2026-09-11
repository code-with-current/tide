#![recursion_limit = "256"]

//! Tide's daemon-side core.
//!
//! Provider, database, filesystem, and Git implementations live here, behind
//! the transport-neutral contract in `protocol`. Client applications
//! intentionally depend on `client` instead of this crate.

rust_i18n::i18n!("../../locales", fallback = "en");

macro_rules! tr {
    ($key:expr) => {
        crate::i18n::translate($key)
    };
    ($key:expr, $($args:tt)*) => {
        rust_i18n::t!($key, $($args)*).into_owned()
    };
}

pub mod daemon;
pub mod i18n;
pub mod identity;
pub mod model;
pub mod theme;
pub mod usage;
pub mod usage_history;
pub mod usage_report;
pub mod workspace;

mod terminal_adapter;
pub use host::{
    checkpoint, command_env, computer_use, git_branch, git_panel, kb_commands, projectless,
    terminal, worktree,
};
pub use runtime::{
    action_jobs, composer_complete, driver, frontmatter, git_commit, git_identities,
    model_metadata, or_catalog, rag, session_history, skills, tide_providers, tide_zed,
};
pub use settings::{DaemonSettings, DaemonSettingsStore};
pub use store::{attachments, blob_store, persistence, settings};
pub use transport::{
    APP_EXECUTABLE_ENV, ClientMessage, Command, DAEMON_ADDRESS_ENV, DAEMON_TOKEN_ENV, DaemonReady,
    PROTOCOL_VERSION, ReplayCursor, Request, ResponseOutcome, ResponsePayload, RpcError,
    SequencedEvent, ServerMessage, WireComputerToolRequest, WireDriverEvent,
    WireDriverStartOptions, WireSessionOptions,
};
pub use transport::{Backend, EventSink, ServerCore, ServerOptions, serve, serve_with_core};
pub use workspace::{WorkspaceOperation, WorkspaceResult};
