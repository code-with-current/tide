//! Private workspaces for tasks that are not attached to a user project.
//!
//! A projectless task has exactly one location: the daemon host's home
//! directory. Tide used to generate a dated workspace under `~/.tide/projects`
//! for every
//! projectless task; those generated directories could dangle — a renamed or
//! removed data directory left persisted projects pointing at paths that no
//! longer exist, and every shell execution in the session failed to spawn.
//! Hardcoding the home directory removes the failure mode: the location
//! always exists and never needs creating. Historic layouts stay recognized
//! so startup migration can repoint persisted projects at the home directory
//! without touching the filesystem.

use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Workspace {
    pub cwd: PathBuf,
    pub workspace_root: PathBuf,
}

pub use protocol::projectless::{
    home_directory, is_legacy_root_path, is_projectless_path, needs_migration, set_workspace_root,
    workspace_root,
};

/// The hardcoded projectless session location.
fn session_location() -> io::Result<PathBuf> {
    home_directory().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "could not locate the home directory for the projectless session workspace",
        )
    })
}

fn workspace_in(home: PathBuf) -> Workspace {
    Workspace {
        cwd: home.clone(),
        workspace_root: home,
    }
}

/// Projectless tasks run in the home directory; nothing is created on disk.
pub fn create_workspace(_prompt: Option<&str>) -> io::Result<Workspace> {
    session_location().map(workspace_in)
}

/// Repoint a projectless project at the hardcoded home location. Migration is
/// intentionally filesystem-free: a workspace whose old directory was already
/// deleted must still repair cleanly, and any
/// generated files an old layout left behind remain reachable from the home
/// directory the session now runs in.
pub fn migrate_workspace(path: &Path) -> io::Result<Workspace> {
    let _ = path;
    session_location().map(workspace_in)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projectless_sessions_run_in_the_hardcoded_home_directory() {
        let home = dirs::home_dir().expect("the test user has a home directory");

        let workspace =
            create_workspace(Some("Fix projectless sessions")).expect("home is available");

        assert_eq!(workspace.cwd, home);
        assert_eq!(workspace.workspace_root, home);
    }

    #[test]
    fn migration_repoints_to_home_without_touching_the_old_directory() {
        let home = dirs::home_dir().expect("the test user has a home directory");
        let old =
            std::env::temp_dir().join(format!("tide-projectless-old-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&old).unwrap();

        let migrated = migrate_workspace(&old).expect("repointing needs only the home directory");

        assert_eq!(migrated.cwd, home);
        assert!(
            old.exists(),
            "repointing must leave the old directory alone"
        );
        std::fs::remove_dir_all(&old).ok();
    }
}
