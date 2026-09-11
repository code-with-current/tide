#![recursion_limit = "256"]

//! Tide's transport-neutral provider runtime.
//!
//! This crate owns session execution and its closely coupled provider/model,
//! skill, RAG, history, and model-assisted Git services. The backend composes
//! these services into protocol request handling.

pub mod action_jobs;
pub mod composer_complete;
pub mod driver;
pub mod frontmatter;
pub mod git_commit;
pub mod git_identities;
pub mod model_metadata;
pub mod or_catalog;
pub mod rag;
pub mod session_history;
pub mod skills;
pub mod tide_providers;
pub mod tide_zed;

// Compatibility aliases keep the extracted modules focused on behavior while
// making their ownership explicit at this crate boundary.
pub use host::{command_env, computer_use};
pub use protocol::{i18n, identity, model, theme};

/// One lock for runtime tests that redirect Tide's process-global data dir.
#[cfg(test)]
pub(crate) static TIDE_DIR_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
