//! Shared command state: the data dir (from `TIDE_DATA_DIR` else `~/.tide`)
//! plus the in-memory config cache. M1 opens `~/.tide` READ-WITH-CARE — the
//! only write path is `AppState::update_config`, which clones, mutates, saves
//! atomically via tide-store, and only then swaps the cache, so a failed save
//! never leaves memory diverged from disk.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tide_store::config::{self, Config};

use crate::commands::CommandError;

pub struct AppState {
    data_dir: PathBuf,
    config: Mutex<Config>,
    /// Set when config.json failed to load at startup. Every config-backed
    /// command fails with it (code `CONFIG_UNREADABLE`) instead of serving
    /// defaults, and updates refuse to write — a silent default here would
    /// destroy the user's real config on the next save.
    config_error: Option<String>,
}

impl AppState {
    pub fn from_env() -> Self {
        Self::load(tide_store::paths::data_dir())
    }

    pub fn load(data_dir: PathBuf) -> Self {
        match config::load(&data_dir.join("config.json")) {
            Ok(config) => Self {
                data_dir,
                config: Mutex::new(config),
                config_error: None,
            },
            Err(e) => Self {
                data_dir,
                config: Mutex::new(Config::default()),
                config_error: Some(e.to_string()),
            },
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn config_path(&self) -> PathBuf {
        self.data_dir().join("config.json")
    }

    pub fn sessions_db_path(&self) -> PathBuf {
        self.data_dir().join("sessions-v2.db")
    }

    fn ensure_readable(&self) -> Result<(), CommandError> {
        match &self.config_error {
            None => Ok(()),
            Some(message) => Err(CommandError::with_code(
                format!("config.json is unreadable: {message}"),
                "CONFIG_UNREADABLE",
            )),
        }
    }

    pub fn read_config<T>(&self, read: impl FnOnce(&Config) -> T) -> Result<T, CommandError> {
        self.ensure_readable()?;
        let guard = self.config.lock().expect("config mutex poisoned");
        Ok(read(&guard))
    }

    pub fn update_config<T>(
        &self,
        mutate: impl FnOnce(&mut Config) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        self.ensure_readable()?;
        let mut guard = self.config.lock().expect("config mutex poisoned");
        let mut draft = guard.clone();
        let value = mutate(&mut draft)?;
        config::save(&self.config_path(), &draft).map_err(CommandError::from)?;
        *guard = draft;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex as StdMutex;

    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_reads_config_from_data_dir() {
        let dir = temp_dir("load");
        fs::write(
            dir.join("config.json"),
            r#"{"providers":[{"id":"p1","name":"n","apiStyle":"openai","baseUrl":"u","enabled":true,"models":[]}]}"#,
        )
        .unwrap();
        let state = AppState::load(dir.clone());
        assert_eq!(state.data_dir(), dir.as_path());
        assert_eq!(state.config_path(), dir.join("config.json"));
        assert_eq!(state.sessions_db_path(), dir.join("sessions-v2.db"));
        assert_eq!(
            state
                .read_config(|cfg| cfg.providers.first().map(|p| p.id.clone()))
                .unwrap(),
            Some("p1".to_string())
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn from_env_respects_tide_data_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("env");
        std::env::set_var(tide_store::paths::DATA_DIR_ENV, &dir);
        let state = AppState::from_env();
        std::env::remove_var(tide_store::paths::DATA_DIR_ENV);
        assert_eq!(state.data_dir(), dir.as_path());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_config_persists_and_updates_memory() {
        let dir = temp_dir("update");
        let state = AppState::load(dir.clone());
        state
            .update_config(|cfg| {
                cfg.agent_settings = Some(tide_store::config::AgentSettings {
                    max_steps: Some(7),
                    ..Default::default()
                });
                Ok(())
            })
            .unwrap();
        assert_eq!(
            state.read_config(|cfg| cfg.agent_settings.as_ref().and_then(|s| s.max_steps)).unwrap(),
            Some(7)
        );
        let reloaded = config::load(&dir.join("config.json")).unwrap();
        assert_eq!(reloaded.agent_settings.and_then(|s| s.max_steps), Some(7));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_config_reverts_memory_when_save_fails() {
        let dir = temp_dir("save-fail");
        fs::write(dir.join("config.json"), "{}").unwrap();
        let state = AppState::load(dir.clone());
        // A directory where the atomic-write temp file should land makes the
        // save fail without touching any real path outside the tempdir.
        fs::create_dir_all(dir.join("config.json.tmp")).unwrap();
        let err = state
            .update_config(|cfg| {
                cfg.agent_settings = Some(tide_store::config::AgentSettings {
                    max_steps: Some(9),
                    ..Default::default()
                });
                Ok(())
            })
            .unwrap_err();
        assert_eq!(err.code.as_deref(), Some("CONFIG_IO"));
        assert_eq!(state.read_config(|cfg| cfg.agent_settings.as_ref().and_then(|s| s.max_steps)).unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_config_fails_reads_and_never_clobbers() {
        let dir = temp_dir("unreadable");
        let original = "{ not valid json";
        fs::write(dir.join("config.json"), original).unwrap();
        let state = AppState::load(dir.clone());

        let read_err = state.read_config(|_| ()).unwrap_err();
        assert_eq!(read_err.code.as_deref(), Some("CONFIG_UNREADABLE"));
        assert!(read_err.message.contains("unreadable"));

        let update_err = state
            .update_config(|cfg| {
                cfg.agent_settings = Some(tide_store::config::AgentSettings::default());
                Ok(())
            })
            .unwrap_err();
        assert_eq!(update_err.code.as_deref(), Some("CONFIG_UNREADABLE"));

        assert_eq!(fs::read_to_string(dir.join("config.json")).unwrap(), original);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_config_is_a_clean_default() {
        let dir = temp_dir("missing");
        let state = AppState::load(dir.clone());
        assert!(state.read_config(|cfg| cfg.providers.is_empty()).unwrap());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn config_error_kinds_map_to_codes() {
        use tide_store::config::ConfigError;
        let io = ConfigError::Io(std::io::Error::other("boom"));
        assert_eq!(CommandError::from(io).code.as_deref(), Some("CONFIG_IO"));
        let parse = ConfigError::Parse(serde_json::from_str::<Config>("{").unwrap_err());
        assert_eq!(CommandError::from(parse).code.as_deref(), Some("CONFIG_PARSE"));
    }
}
