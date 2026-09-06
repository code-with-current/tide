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

pub mod attachments;
pub mod blob_store;
pub mod checkpoint;
pub mod command_env;
pub mod composer_complete;
pub mod computer_use;
pub mod daemon;
pub mod driver;
mod frontmatter;
pub mod git_branch;
pub mod git_commit;
pub mod git_identities;
pub mod git_panel;
pub mod i18n;
pub mod identity;
pub mod model;
pub mod model_metadata;
pub mod or_catalog;
pub mod persistence;
pub mod projectless;
pub mod rag;
pub mod settings;
pub mod skills;
pub mod terminal;
pub mod theme;
pub mod tide_providers;
pub mod usage;
pub mod usage_history;
pub mod workspace;
pub mod worktree;

mod fs_ext;
mod server;
mod wire;

pub use server::{Backend, EventSink, ServerOptions, serve};
pub use settings::{DaemonSettings, DaemonSettingsStore};
pub use wire::{
    APP_EXECUTABLE_ENV, ClientMessage, Command, DAEMON_ADDRESS_ENV, DAEMON_TOKEN_ENV, DaemonReady,
    PROTOCOL_VERSION, ReplayCursor, Request, ResponseOutcome, ResponsePayload, RpcError,
    SequencedEvent, ServerMessage, WireComputerToolRequest, WireDriverEvent,
    WireDriverStartOptions, WireSessionOptions,
};
pub use workspace::{WorkspaceOperation, WorkspaceResult};

/// One lock for every test that redirects `TIDE_DATA_DIR`: the env var is
/// process-global, so two modules' tests setting it under separate locks
/// race each other and a config read lands against the wrong data dir.
#[cfg(test)]
pub(crate) static TIDE_DIR_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Serializes read-modify-write cycles on tide's shared `config.json`
/// (provider management, git attribution, background models, and the
/// post-refresh model-enrichment pass) — the pass runs on its own thread,
/// and an interleaved load/save pair would write the other's change back
/// out of existence.
pub(crate) static TIDE_CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
