//! Pure daemon-path classification shared by clients and the daemon.
//!
//! A projectless ("No project") session has exactly one location: the home
//! directory of the host that owns the workspace root. Nothing is generated
//! on disk for it, so shell and file tools always start in a directory that
//! exists. Historic layouts — `~/.tide/projects/<date>/<slug>`, the older
//! dated directories directly under `~/.tide`, and everything the pre-rename
//! `~/.waku` app directory left behind — stay recognized so existing projects
//! can be classified and repointed to the home directory.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

fn workspace_root_slot() -> &'static RwLock<Option<PathBuf>> {
    static ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
    ROOT.get_or_init(|| {
        RwLock::new(dirs::home_dir().map(|home| home.join(".tide").join("projects")))
    })
}

pub fn set_workspace_root(root: Option<PathBuf>) {
    if let Ok(mut current) = workspace_root_slot().write() {
        *current = root;
    }
}

pub fn workspace_root() -> Option<PathBuf> {
    workspace_root_slot().read().ok()?.clone()
}

/// Home directory on the host that owns the configured projectless root.
/// Remote desktops use this only to abbreviate daemon paths for display.
pub fn home_directory() -> Option<PathBuf> {
    let root = workspace_root()?;
    root.parent()?.parent().map(Path::to_path_buf)
}

/// The root a host derives from its own home directory, used when no
/// daemon-installed root is available yet.
fn default_workspace_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".tide").join("projects"))
}

/// Whether `path` names a projectless session location for the home that owns
/// `root`: the hardcoded home directory itself, the generated-workspace root,
/// or any historic layout under `~/.tide` and the pre-rename `~/.waku`.
pub fn is_projectless_path_under(path: &Path, root: &Path) -> bool {
    let Some(home) = root.parent().and_then(Path::parent) else {
        return false;
    };
    if path == home || path.starts_with(root) {
        return true;
    }
    let waku = home.join(".waku");
    let legacy_roots = [root.parent(), Some(waku.as_path())];
    legacy_roots
        .into_iter()
        .flatten()
        .any(|legacy_root| {
            path == legacy_root
                || path.starts_with(legacy_root.join("projects"))
                || is_legacy_workspace_path(path, legacy_root)
        })
}

pub fn is_projectless_path(path: &Path) -> bool {
    let root = match workspace_root() {
        Some(root) => root,
        None => match default_workspace_root() {
            Some(root) => root,
            None => return false,
        },
    };
    is_projectless_path_under(path, &root)
}

/// A projectless project migrates when it classifies as projectless but no
/// longer points at the hardcoded home location — stale generated layouts
/// under `~/.tide`, and everything the deleted pre-rename `~/.waku` left
/// behind in persisted state.
pub fn needs_migration(path: &Path) -> bool {
    is_projectless_path(path) && home_directory().is_some_and(|home| path != home)
}

pub fn is_legacy_root_path(path: &Path) -> bool {
    workspace_root()
        .is_some_and(|root| root.parent().is_some_and(|legacy_root| path == legacy_root))
}

fn is_legacy_workspace_path(path: &Path, legacy_root: &Path) -> bool {
    if path == legacy_root {
        return true;
    }
    let Some(date) = path
        .strip_prefix(legacy_root)
        .ok()
        .and_then(|relative| relative.components().next())
        .and_then(|component| component.as_os_str().to_str())
    else {
        return false;
    };
    is_date_component(date)
}

fn is_date_component(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic `<home>/.tide/projects` root so the classification matrix
    /// never depends on — or mutates — the caller's real home directory.
    fn test_root() -> PathBuf {
        std::env::temp_dir()
            .join("tide-projectless-classification")
            .join(".tide")
            .join("projects")
    }

    #[test]
    fn classification_recognizes_the_hardcoded_home_and_every_generated_layout() {
        let root = test_root();
        let dot_tide = root.parent().unwrap();
        let home = dot_tide.parent().unwrap();

        // The hardcoded location itself.
        assert!(is_projectless_path_under(home, &root));
        // Current generated layout.
        assert!(is_projectless_path_under(
            &root.join("2026-09-05/new-chat"),
            &root
        ));
        // Pre-projects dated layout directly under ~/.tide, and the config
        // directory itself.
        assert!(is_projectless_path_under(
            &dot_tide.join("2026-08-08/new-chat"),
            &root
        ));
        assert!(is_projectless_path_under(dot_tide, &root));
        // The pre-rename app directory, both of its layouts, and its root.
        let waku = home.join(".waku");
        assert!(is_projectless_path_under(
            &waku.join("projects/2026-08-29/new-chat"),
            &root
        ));
        assert!(is_projectless_path_under(
            &waku.join("2026-08-29/new-chat"),
            &root
        ));
        assert!(is_projectless_path_under(&waku, &root));

        // Ordinary workspaces stay ordinary, including prefix look-alikes.
        assert!(!is_projectless_path_under(&home.join("dev/tide"), &root));
        assert!(!is_projectless_path_under(
            &home.join(".tide-projects/2026-09-05/new-chat"),
            &root
        ));
        assert!(!is_projectless_path_under(
            &home.join(".waku-backup/2026-08-29/new-chat"),
            &root
        ));
    }

    #[test]
    fn classification_needs_a_root_with_a_home_above_it() {
        // A two-component root cannot name a home; nothing classifies.
        assert!(!is_projectless_path_under(
            Path::new("/anything"),
            Path::new("/tmp")
        ));
    }

    #[test]
    fn migration_targets_every_recognized_location_except_the_hardcoded_home() {
        let root = test_root();
        let dot_tide = root.parent().unwrap();
        let home = dot_tide.parent().unwrap();

        let migrates = |path: &Path| is_projectless_path_under(path, &root) && path != home;

        assert!(!migrates(home));
        assert!(migrates(&root.join("2026-09-05/new-chat")));
        assert!(migrates(dot_tide));
        assert!(migrates(&home.join(".waku/projects/2026-08-29/new-chat")));
        assert!(!migrates(&home.join("dev/tide")));
    }
}
