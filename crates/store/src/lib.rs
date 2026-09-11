//! rusqlite sessions-v2/config/RAG index (in-place ~/.tide).

pub mod attachments;
pub mod blob_store;
pub mod config;
pub mod git_identities;
pub mod paths;
pub mod persistence;
pub mod secrets;
pub mod sessions_v2;
pub mod sessions_v2_write;
pub mod settings;
pub mod usage;

pub use settings::DaemonSettings;

/// Serializes read-modify-write cycles on Tide's shared `config.json` across
/// runtime and host-facing configuration services.
pub static CONFIG_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// The task store predates this crate extraction and refers to shared domain
// modules through its crate root. Keep those aliases private: callers should
// use `protocol` for domain types and `store` only for persistence APIs.
pub(crate) use protocol::{computer_use, i18n, identity, model, theme};
