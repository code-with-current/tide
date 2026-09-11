//! Host-machine services used by Tide's backend runtime.
//!
//! This crate owns process environment discovery, Git and worktree
//! operations, checkpoint refs, and projectless workspace paths. It has no
//! provider-runtime, WebSocket, or UI dependency.

pub mod checkpoint;
pub mod command_env;
pub mod git_branch;
pub mod git_panel;
pub mod projectless;
pub mod worktree;

// Checkpoint predates this extraction and refers to protocol model types
// through the crate root. Keep the compatibility alias private.
pub(crate) use protocol::model;

/// One lock for tests that redirect Tide's process-global data directory.
#[cfg(test)]
pub(crate) static TIDE_DIR_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
