//! One-time move of pre-rename (Waku) data directories to their Tide names.
//!
//! Runs at boot before any store opens. Every step is guarded so a rerun is a
//! no-op, and each move is best-effort: a failure logs and leaves the legacy
//! directory in place rather than blocking startup. The legacy spellings are
//! frozen history — keep them literal on purpose.

use std::fs;
use std::path::Path;

pub fn migrate_legacy_directories() {
    if let Some(data_local) = dirs::data_local_dir() {
        rename_once(&data_local.join("Waku"), &data_local.join("Tide"));
        rename_once(
            &data_local.join("Waku Debug"),
            &data_local.join("Tide Debug"),
        );
        // The single-instance lock is recreated under its new name; a stale
        // lock carried over by the rename would look like a live instance.
        let _ = fs::remove_file(data_local.join("Tide").join("waku-single-instance.lock"));
        let _ = fs::remove_file(
            data_local
                .join("Tide Debug")
                .join("waku-single-instance.lock"),
        );
    }
    if let Some(cache) = dirs::cache_dir() {
        rename_once(&cache.join("Waku"), &cache.join("Tide"));
    }
    if let Some(home) = dirs::home_dir() {
        let legacy_config = home.join(".waku");
        let config = home.join(".tide");
        // The pre-rename vendored tide stack also used `~/.tide`; the rebrand
        // decision discards its data when the Waku configuration moves in.
        // Without `~/.waku` (fresh install) an existing `~/.tide` is left
        // untouched.
        if legacy_config.is_dir() && config.exists() {
            match fs::remove_dir_all(&config) {
                Ok(()) => eprintln!("tide: removed superseded {}", config.display()),
                Err(error) => {
                    eprintln!(
                        "tide: could not remove superseded {}: {error}",
                        config.display()
                    );
                    return;
                }
            }
        }
        rename_once(&legacy_config, &config);
    }
}

fn rename_once(from: &Path, to: &Path) {
    if !from.is_dir() || to.exists() {
        return;
    }
    match fs::rename(from, to) {
        Ok(()) => eprintln!("tide: migrated {} -> {}", from.display(), to.display()),
        Err(error) => eprintln!(
            "tide: could not migrate {} -> {}: {error}",
            from.display(),
            to.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::rename_once;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tide-migration-{name}-{}", Uuid::new_v4()))
    }

    #[test]
    fn moves_directory_when_target_is_absent() {
        let from = scratch("source");
        let to = scratch("target");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("app.db"), b"db").unwrap();

        rename_once(&from, &to);

        assert!(!from.exists());
        assert_eq!(fs::read(to.join("app.db")).unwrap(), b"db");
        let _ = fs::remove_dir_all(&to);
    }

    #[test]
    fn keeps_existing_target_untouched() {
        let from = scratch("source");
        let to = scratch("target");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("app.db"), b"old").unwrap();
        fs::create_dir_all(&to).unwrap();
        fs::write(to.join("app.db"), b"new").unwrap();

        rename_once(&from, &to);

        assert!(from.exists(), "legacy directory is left in place");
        assert_eq!(fs::read(to.join("app.db")).unwrap(), b"new");
        let _ = fs::remove_dir_all(&from);
        let _ = fs::remove_dir_all(&to);
    }

    #[test]
    fn ignores_missing_source() {
        let from = scratch("absent");
        let to = scratch("target");
        rename_once(&from, &to);
        assert!(!to.exists());
    }
}
