//! config.json model ported from `app/core/configStore.ts`.
//!
//! Every modeled level carries `#[serde(flatten)] extra` so fields the Rust
//! app doesn't know about yet survive a load→save round-trip: older
//! installed builds re-read this same file.

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<StoredProvider>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspaces: Vec<Workspace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secrets: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_settings: Option<AgentSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub general_settings: Option<GeneralSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rag_enabled_workspaces: Option<Vec<String>>,
    /// Disabled extensions (agents/skills/mcp allowlist of what's OFF).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<ExtensionsConfig>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `config.extensions` (TS shape: `{ disabled: { agents, skills, mcp } }`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsConfig {
    #[serde(default)]
    pub disabled: ExtensionsDisabled,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionsDisabled {
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp: Vec<String>,
}

impl Config {
    pub fn provider(&self, id: &str) -> Option<&StoredProvider> {
        self.providers.iter().find(|p| p.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProvider {
    pub id: String,
    pub name: String,
    pub api_style: String,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_key: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<StoredModel>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredModel {
    pub id: String,
    pub alias: String,
    pub model_id: String,
    pub context_window: u64,
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_mandatory: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_efforts: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_autonomy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_timeout_min: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_mode_dry_run: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_shell_commands: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_keep_turns: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub experimental_background_dispatch: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// AgentSettings with the TS DEFAULT_AGENT_SETTINGS layered over absent
/// fields (the TS merged defaults at every read; doing it here keeps the
/// stored model lossless).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAgentSettings {
    pub default_autonomy: String,
    pub max_steps: u64,
    pub permission_timeout_min: u64,
    pub plan_mode_dry_run: bool,
    pub audit_shell_commands: bool,
    pub compaction_enabled: bool,
    pub compaction_threshold: f64,
    pub compaction_keep_turns: u64,
    pub experimental_background_dispatch: bool,
}

impl Default for EffectiveAgentSettings {
    fn default() -> Self {
        Self {
            default_autonomy: "ask".into(),
            max_steps: 100,
            permission_timeout_min: 10,
            plan_mode_dry_run: true,
            audit_shell_commands: true,
            compaction_enabled: true,
            compaction_threshold: 0.75,
            compaction_keep_turns: 3,
            experimental_background_dispatch: false,
        }
    }
}

impl AgentSettings {
    pub fn effective(&self) -> EffectiveAgentSettings {
        let d = EffectiveAgentSettings::default();
        EffectiveAgentSettings {
            default_autonomy: self.default_autonomy.clone().unwrap_or(d.default_autonomy),
            max_steps: self.max_steps.unwrap_or(d.max_steps),
            permission_timeout_min: self
                .permission_timeout_min
                .unwrap_or(d.permission_timeout_min),
            plan_mode_dry_run: self.plan_mode_dry_run.unwrap_or(d.plan_mode_dry_run),
            audit_shell_commands: self.audit_shell_commands.unwrap_or(d.audit_shell_commands),
            compaction_enabled: self.compaction_enabled.unwrap_or(d.compaction_enabled),
            compaction_threshold: self.compaction_threshold.unwrap_or(d.compaction_threshold),
            compaction_keep_turns: self
                .compaction_keep_turns
                .unwrap_or(d.compaction_keep_turns),
            experimental_background_dispatch: self
                .experimental_background_dispatch
                .unwrap_or(d.experimental_background_dispatch),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at_login: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_sound: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_co_authored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_co_author_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_co_author_email: Option<String>,
    /// `'co-author'` (repo identity authors, Tide trails) or `'author'`
    /// (Tide authors, repo identity trails).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_attribution_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_message_model: Option<ModelRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_update_check: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// GeneralSettings with the TS DEFAULT_GENERAL_SETTINGS layered over absent
/// fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveGeneralSettings {
    pub start_at_login: bool,
    pub notifications: bool,
    pub notification_sound: bool,
    pub git_co_authored: bool,
    pub git_co_author_name: String,
    pub git_co_author_email: String,
    pub git_attribution_mode: String,
    pub title_model: Option<ModelRef>,
    pub commit_message_model: Option<ModelRef>,
    pub auto_update_check: bool,
}

impl Default for EffectiveGeneralSettings {
    fn default() -> Self {
        Self {
            start_at_login: false,
            notifications: true,
            notification_sound: true,
            git_co_authored: true,
            git_co_author_name: "Tide".into(),
            git_co_author_email: "314188112+tide-codes@users.noreply.github.com".into(),
            git_attribution_mode: GitAttributionMode::Author.as_str().into(),
            title_model: None,
            commit_message_model: None,
            auto_update_check: true,
        }
    }
}

impl GeneralSettings {
    pub fn effective(&self) -> EffectiveGeneralSettings {
        let d = EffectiveGeneralSettings::default();
        EffectiveGeneralSettings {
            start_at_login: self.start_at_login.unwrap_or(d.start_at_login),
            notifications: self.notifications.unwrap_or(d.notifications),
            notification_sound: self.notification_sound.unwrap_or(d.notification_sound),
            git_co_authored: self.git_co_authored.unwrap_or(d.git_co_authored),
            git_co_author_name: self
                .git_co_author_name
                .clone()
                .unwrap_or(d.git_co_author_name),
            git_co_author_email: self
                .git_co_author_email
                .clone()
                .unwrap_or(d.git_co_author_email),
            git_attribution_mode: self
                .git_attribution_mode
                .clone()
                .unwrap_or(d.git_attribution_mode),
            title_model: self.title_model.clone().or(d.title_model),
            commit_message_model: self.commit_message_model.clone().or(d.commit_message_model),
            auto_update_check: self.auto_update_check.unwrap_or(d.auto_update_check),
        }
    }
}

// ── commit attribution ─────────────────────────────────────────────────

/// The two attribution roles. Co-author is the classic behavior: the repo's
/// applied identity authors the commit and Tide rides the trailer. Author
/// flips it: Tide authors commits it makes, the user's identity moves to the
/// trailer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitAttributionMode {
    CoAuthor,
    Author,
}

impl GitAttributionMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "co-author" => Some(Self::CoAuthor),
            "author" => Some(Self::Author),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::CoAuthor => "co-author",
            Self::Author => "author",
        }
    }
}

/// Tide's attribution decision for a commit, derived from GeneralSettings.
/// Consumed by both commit paths — the panel's git_commit/git_amend and the
/// agent git tool — so the two can never disagree.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitAttribution {
    pub mode: GitAttributionMode,
    /// Tide's configured display name / no-reply email.
    pub name: String,
    pub email: String,
}

impl CommitAttribution {
    /// The `Co-authored-by` trailer this commit should carry. In Co-author
    /// mode Tide trails; in Author mode the user's applied identity trails.
    pub fn trailer(&self, user_name: &str, user_email: &str) -> String {
        match self.mode {
            GitAttributionMode::CoAuthor => co_author_trailer(&self.name, &self.email),
            GitAttributionMode::Author => co_author_trailer(user_name, user_email),
        }
    }

    /// The commit author override — only Author mode moves the author.
    pub fn author_override(&self) -> Option<(&str, &str)> {
        match self.mode {
            GitAttributionMode::CoAuthor => None,
            GitAttributionMode::Author => Some((&self.name, &self.email)),
        }
    }
}

pub fn co_author_trailer(name: &str, email: &str) -> String {
    format!("Co-authored-by: {name} <{email}>")
}

/// Append the trailer unless the message already carries it verbatim —
/// amends and agent re-commits stay idempotent.
pub fn append_trailer_once(message: &str, trailer: &str) -> String {
    if message.lines().map(str::trim).any(|l| l == trailer) {
        message.to_owned()
    } else {
        format!("{message}\n\n{trailer}")
    }
}

/// The attribution decision for the next commit, read fresh from the
/// data-dir config (never cached — a settings change applies to the next
/// commit without a process restart). Absent/unreadable config → no
/// attribution, exactly like the panel path's read failure.
pub fn current_attribution() -> Option<CommitAttribution> {
    let cfg = load(&crate::paths::config_path()).ok()?;
    cfg.general_settings
        .map(|g| g.effective())
        .and_then(|g| g.commit_attribution())
}

impl EffectiveGeneralSettings {
    pub fn commit_attribution(&self) -> Option<CommitAttribution> {
        if !self.git_co_authored {
            return None;
        }
        let mode = GitAttributionMode::parse(&self.git_attribution_mode)
            .unwrap_or(GitAttributionMode::CoAuthor);
        Some(CommitAttribution {
            mode,
            name: self.git_co_author_name.clone(),
            email: self.git_co_author_email.clone(),
        })
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Io(std::io::Error),
    Parse(serde_json::Error),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "config io error: {e}"),
            ConfigError::Parse(e) => write!(f, "config parse error: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ConfigError::Io(e) => Some(e),
            ConfigError::Parse(e) => Some(e),
        }
    }
}

impl From<std::io::Error> for ConfigError {
    fn from(e: std::io::Error) -> Self {
        ConfigError::Io(e)
    }
}

impl From<serde_json::Error> for ConfigError {
    fn from(e: serde_json::Error) -> Self {
        ConfigError::Parse(e)
    }
}

pub type ConfigResult<T> = Result<T, ConfigError>;

/// Missing file → first-run default. Unlike the TS (which swallowed parse
/// errors into the default and would then overwrite the file on next write),
/// malformed JSON is an error — a silent default here risks destroying the
/// user's real config.
pub fn load(path: &Path) -> ConfigResult<Config> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(ConfigError::Io(e)),
    }
}

/// Atomic write: temp file + fsync + rename. Matches the TS byte shape
/// (JSON.stringify(cfg, null, 2), no trailing newline) and self-heals a
/// missing parent dir like the TS write() fallback did.
pub fn save(path: &Path, config: &Config) -> ConfigResult<()> {
    let json = serde_json::to_string_pretty(config)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut file = fs::File::create(&tmp)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../engine/fixtures/schemas/mcp-config.json"
    ));

    fn temp_path(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("store-config-{}-{}", std::process::id(), name));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fixture_round_trips_losslessly() {
        let original: Value = serde_json::from_str(FIXTURE).unwrap();
        let cfg: Config = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(cfg.providers.len(), 2);
        assert_eq!(cfg.workspaces.len(), 6);
        assert_eq!(
            cfg.general_settings
                .as_ref()
                .unwrap()
                .title_model
                .as_ref()
                .unwrap()
                .model_id,
            "glm-4.5-air"
        );
        let once = serde_json::to_value(&cfg).unwrap();
        assert_eq!(
            original, once,
            "round-trip must not change any field or value"
        );
        let cfg2: Config = serde_json::from_value(once.clone()).unwrap();
        assert_eq!(serde_json::to_value(&cfg2).unwrap(), once);
    }

    #[test]
    fn unknown_fields_survive_at_every_level() {
        let raw = r#"{
          "futureTopLevel": {"a": [1, 2.5, null, true]},
          "providers": [{
            "id": "p_1", "name": "x", "apiStyle": "openai", "baseUrl": "https://x",
            "encryptedKey": "kcv2notreally", "enabled": false, "providerFuture": 7,
            "models": [{ "id": "m_1", "alias": "a", "modelId": "g", "contextWindow": 8,
                         "providerId": "p_1", "modelFuture": "keep" }]
          }],
          "workspaces": [{ "id": "ws_1", "name": "w", "path": "/tmp/w", "wsFuture": true }],
          "agentSettings": { "maxSteps": 5, "agentFuture": "keep" },
          "generalSettings": { "titleModel": { "providerId": "p_1", "modelId": "g" }, "generalFuture": "keep" },
          "mcpServers": { "srv": { "type": "http", "url": "https://mcp", "unknownMcpField": 1 } },
          "secrets": { "svc": "enc" },
          "ragEnabledWorkspaces": ["ws_1"]
        }"#;
        let original: Value = serde_json::from_str(raw).unwrap();
        let cfg: Config = serde_json::from_str(raw).unwrap();
        assert_eq!(serde_json::to_value(&cfg).unwrap(), original);
    }

    #[test]
    fn load_missing_file_yields_default() {
        let dir = temp_path("missing");
        let cfg = load(&dir.join("absent.json")).unwrap();
        assert_eq!(cfg, Config::default());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn load_malformed_file_errors() {
        let dir = temp_path("malformed");
        let path = dir.join("config.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(matches!(load(&path), Err(ConfigError::Parse(_))));
        fs::write(&path, "[1, 2]").unwrap();
        assert!(matches!(load(&path), Err(ConfigError::Parse(_))));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_is_atomic_and_reloads_identically() {
        let dir = temp_path("save");
        let path = dir.join("nested").join("config.json");
        let cfg: Config = serde_json::from_str(FIXTURE).unwrap();
        save(&path, &cfg).unwrap();
        let entries: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert_eq!(entries.len(), 1, "temp file must be renamed away");
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            bytes.last(),
            Some(&b'}'),
            "no trailing newline (TS byte shape)"
        );
        let reloaded = load(&path).unwrap();
        assert_eq!(
            serde_json::to_value(&reloaded).unwrap(),
            serde_json::to_value(&cfg).unwrap()
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn settings_defaults_layer_over_partial_blocks() {
        let agent: AgentSettings = serde_json::from_str(r#"{"maxSteps": 5}"#).unwrap();
        let eff = agent.effective();
        assert_eq!(eff.max_steps, 5);
        assert_eq!(eff.default_autonomy, "ask");
        assert!((eff.compaction_threshold - 0.75).abs() < f64::EPSILON);
        let general = GeneralSettings::default();
        let geff = general.effective();
        assert_eq!(geff.git_co_author_name, "Tide");
        assert_eq!(
            geff.git_co_author_email,
            "314188112+tide-codes@users.noreply.github.com"
        );
        assert!(geff.notifications);
        assert_eq!(geff.title_model, None);
    }

    /// `TIDE_DATA_DIR` is process-global; serialize against the crate-wide
    /// env lock so the paths tests can't unset it mid-read.
    #[test]
    fn current_attribution_reads_the_data_dir_config_fresh() {
        let _guard = crate::paths::ENV_LOCK.lock().unwrap();
        let scratch = std::env::temp_dir().join(format!("tide-attr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir_all(&scratch).unwrap();
        std::env::set_var(crate::paths::DATA_DIR_ENV, &scratch);

        // Absent config → no attribution.
        assert!(current_attribution().is_none());

        // A written config applies on the next read without a restart.
        let cfg: Config = serde_json::from_str(
            r#"{"generalSettings":{"gitCoAuthored":true,"gitAttributionMode":"author"}}"#,
        )
        .unwrap();
        save(&scratch.join("config.json"), &cfg).unwrap();
        let attribution = current_attribution().unwrap();
        assert_eq!(attribution.author_override().unwrap().0, "Tide");
        assert_eq!(attribution.mode, GitAttributionMode::Author);

        // Disabled → none, even with mode/name set.
        let cfg: Config =
            serde_json::from_str(r#"{"generalSettings":{"gitCoAuthored":false}}"#).unwrap();
        save(&scratch.join("config.json"), &cfg).unwrap();
        assert!(current_attribution().is_none());

        std::env::remove_var(crate::paths::DATA_DIR_ENV);
        fs::remove_dir_all(&scratch).unwrap();
    }
}
