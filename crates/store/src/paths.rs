//! Data-dir resolution ported from `app/platform/paths.ts`.

use std::path::PathBuf;

const BASE_DIR_NAME: &str = ".tide";
pub const DATA_DIR_ENV: &str = "TIDE_DATA_DIR";

pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(DATA_DIR_ENV) {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    // The TS original appended `-dev` for dev builds; the Tauri app must open
    // the real ~/.tide from dev runs too (M1 homecoming), so the suffix is
    // deliberately dropped — test isolation goes through TIDE_DATA_DIR.
    match dirs::home_dir() {
        Some(home) => home.join(BASE_DIR_NAME),
        None => PathBuf::from(BASE_DIR_NAME),
    }
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

pub fn sessions_db_path() -> PathBuf {
    data_dir().join("sessions-v2.db")
}

/// set_var/remove_var are process-global; serialize every env-touching
/// test in the crate (paths and config) against this one lock.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn env_override_wins() {
        let _guard = super::ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("store-paths-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var(DATA_DIR_ENV, &dir);
        assert_eq!(data_dir(), dir);
        assert_eq!(config_path(), dir.join("config.json"));
        assert_eq!(sessions_db_path(), dir.join("sessions-v2.db"));
        std::env::remove_var(DATA_DIR_ENV);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_override_falls_back_to_home() {
        let _guard = super::ENV_LOCK.lock().unwrap();
        std::env::set_var(DATA_DIR_ENV, "");
        assert_eq!(data_dir(), dirs::home_dir().unwrap().join(".tide"));
        std::env::remove_var(DATA_DIR_ENV);
    }

    #[test]
    fn default_is_home_tide() {
        let _guard = super::ENV_LOCK.lock().unwrap();
        std::env::remove_var(DATA_DIR_ENV);
        assert_eq!(data_dir(), dirs::home_dir().unwrap().join(".tide"));
    }
}
