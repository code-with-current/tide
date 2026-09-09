//! git-identities.json — commit identity profiles + GitHub account metadata,
//! a sibling of config.json (kept out of the config block so profile churn
//! never touches the settings merge path). Port of openchamber's
//! identity-storage.js: plain fs read/JSON parse, `{profiles: []}` on
//! missing or corrupt files (log-and-recover), every write persists the
//! whole array atomically like config::save.
//!
//! Identity tokens never live here — they go into config.json's encrypted
//! secrets map (see commands/git_identities.rs); this file is metadata only.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const IDENTITIES_FILE: &str = "git-identities.json";

pub const DEFAULT_COLOR: &str = "keyword";
pub const DEFAULT_ICON: &str = "branch";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentityProfile {
    pub id: String,
    /// Display name; defaults to userName on create.
    #[serde(default)]
    pub name: Option<String>,
    /// → git user.name.
    pub user_name: String,
    /// → git user.email.
    pub user_email: String,
    /// `'ssh'` | `'token'`.
    pub auth_type: String,
    /// Key path for ssh profiles.
    #[serde(default)]
    pub ssh_key: Option<String>,
    /// Host for token profiles (e.g. github.com).
    #[serde(default)]
    pub host: Option<String>,
    /// Login of the GitHub account whose OAuth token backs a
    /// `source: 'github'` profile.
    #[serde(default)]
    pub github_login: Option<String>,
    #[serde(default)]
    pub sign_commits: bool,
    /// → user.signingkey when sign_commits.
    #[serde(default)]
    pub signing_key: Option<String>,
    /// Theme token for the UI dot.
    #[serde(default = "default_color")]
    pub color: String,
    /// Lucide icon name.
    #[serde(default = "default_icon")]
    pub icon: String,
    /// `'manual'` | `'github'`.
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_color() -> String {
    DEFAULT_COLOR.into()
}

fn default_icon() -> String {
    DEFAULT_ICON.into()
}

fn default_source() -> String {
    "manual".into()
}

impl GitIdentityProfile {
    pub fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.user_name)
    }

    /// Fill the create-time defaults: display name from userName, theme
    /// color/icon, manual source. auth_type defaults to ssh when blank.
    fn with_defaults(mut self) -> Self {
        if self.name.as_deref().map(str::trim).unwrap_or("").is_empty() {
            self.name = None;
        }
        if self.auth_type.trim().is_empty() {
            self.auth_type = "ssh".into();
        }
        if self.color.trim().is_empty() {
            self.color = DEFAULT_COLOR.into();
        }
        if self.icon.trim().is_empty() {
            self.icon = DEFAULT_ICON.into();
        }
        if self.source.trim().is_empty() {
            self.source = "manual".into();
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount {
    /// Unique — the account login.
    pub id: String,
    pub login: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// GitHub's numeric account id.
    #[serde(default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentitiesFile {
    #[serde(default)]
    pub profiles: Vec<GitIdentityProfile>,
    #[serde(default)]
    pub github_accounts: Vec<GitHubAccount>,
}

#[derive(Debug)]
pub enum IdentitiesError {
    Io(std::io::Error),
    Serde(serde_json::Error),
    Validation(String),
}

impl std::fmt::Display for IdentitiesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "git-identities file error: {e}"),
            Self::Serde(e) => write!(f, "git-identities parse error: {e}"),
            Self::Validation(e) => write!(f, "{e}"),
        }
    }
}

fn file_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(IDENTITIES_FILE)
}

/// Missing or corrupt file → the empty default (logged, never fatal — the
/// identities UI degrades to an empty list like a fresh install).
pub fn load(data_dir: &Path) -> GitIdentitiesFile {
    let path = file_path(data_dir);
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(file) => file,
            Err(e) => {
                eprintln!(
                    "[tide] {} is corrupt, recovering empty: {e}",
                    path.display()
                );
                GitIdentitiesFile::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GitIdentitiesFile::default(),
        Err(e) => {
            eprintln!(
                "[tide] {} unreadable, recovering empty: {e}",
                path.display()
            );
            GitIdentitiesFile::default()
        }
    }
}

pub fn save(data_dir: &Path, file: &GitIdentitiesFile) -> Result<(), IdentitiesError> {
    let path = file_path(data_dir);
    let json = serde_json::to_string_pretty(file).map_err(IdentitiesError::Serde)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(IdentitiesError::Io)?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    fs::write(&tmp, json.as_bytes()).map_err(IdentitiesError::Io)?;
    fs::rename(&tmp, &path).map_err(IdentitiesError::Io)?;
    Ok(())
}

/// Shared identity validation (the same rules the attribution name/email
/// fields enforce): non-empty name, `local@domain.tld` email, and no single
/// quotes — git config values must stay injection-safe.
pub fn validate_identity_fields(user_name: &str, user_email: &str) -> Result<(), IdentitiesError> {
    let name = user_name.trim();
    if name.is_empty() {
        return Err(IdentitiesError::Validation("user name is required".into()));
    }
    if user_name.contains('\'') || user_email.contains('\'') {
        return Err(IdentitiesError::Validation(
            "single quotes are not allowed in name or email".into(),
        ));
    }
    let Some((local, domain)) = user_email.split_once('@') else {
        return Err(IdentitiesError::Validation(format!(
            "invalid email: {user_email}"
        )));
    };
    if local.is_empty() || !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.')
    {
        return Err(IdentitiesError::Validation(format!(
            "invalid email: {user_email}"
        )));
    }
    Ok(())
}

/// Rejects values that could break out of `core.sshCommand`'s single-quoted
/// key path (git evaluates that config through a shell later).
pub fn escape_ssh_key_path(path: &str) -> Result<String, IdentitiesError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(IdentitiesError::Validation(
            "ssh key path is required".into(),
        ));
    }
    if trimmed
        .chars()
        .any(|c| matches!(c, '\'' | '"' | '\n' | '\r' | ';' | '$' | '`' | '\\') || c.is_control())
    {
        return Err(IdentitiesError::Validation(
            "ssh key path contains characters that cannot be safely quoted".into(),
        ));
    }
    Ok(format!("ssh -i '{trimmed}'"))
}

pub fn get_profiles(data_dir: &Path) -> Vec<GitIdentityProfile> {
    load(data_dir).profiles
}

pub fn get_profile(data_dir: &Path, id: &str) -> Option<GitIdentityProfile> {
    load(data_dir).profiles.into_iter().find(|p| p.id == id)
}

pub fn create_profile(
    data_dir: &Path,
    input: &GitIdentityProfile,
) -> Result<GitIdentityProfile, IdentitiesError> {
    if input.id.trim().is_empty() {
        return Err(IdentitiesError::Validation("id is required".into()));
    }
    validate_identity_fields(&input.user_name, &input.user_email)?;
    if input.auth_type == "ssh" {
        if let Some(key) = input.ssh_key.as_deref() {
            escape_ssh_key_path(key)?;
        }
    }
    let mut file = load(data_dir);
    if file.profiles.iter().any(|p| p.id == input.id) {
        return Err(IdentitiesError::Validation(format!(
            "identity id already exists: {}",
            input.id
        )));
    }
    let profile = input.clone().with_defaults();
    file.profiles.push(profile.clone());
    save(data_dir, &file)?;
    Ok(profile)
}

/// id is the lookup key, so it is immutable by construction.
pub fn update_profile(
    data_dir: &Path,
    input: &GitIdentityProfile,
) -> Result<GitIdentityProfile, IdentitiesError> {
    validate_identity_fields(&input.user_name, &input.user_email)?;
    if input.auth_type == "ssh" {
        if let Some(key) = input.ssh_key.as_deref() {
            escape_ssh_key_path(key)?;
        }
    }
    let mut file = load(data_dir);
    let profile = input.clone().with_defaults();
    let Some(slot) = file.profiles.iter_mut().find(|p| p.id == input.id) else {
        return Err(IdentitiesError::Validation(format!(
            "no identity with id {}",
            input.id
        )));
    };
    *slot = profile.clone();
    save(data_dir, &file)?;
    Ok(profile)
}

pub fn delete_profile(data_dir: &Path, id: &str) -> Result<(), IdentitiesError> {
    let mut file = load(data_dir);
    let before = file.profiles.len();
    file.profiles.retain(|p| p.id != id);
    if file.profiles.len() == before {
        return Err(IdentitiesError::Validation(format!(
            "no identity with id {id}"
        )));
    }
    save(data_dir, &file)
}

pub fn list_github_accounts(data_dir: &Path) -> Vec<GitHubAccount> {
    load(data_dir).github_accounts
}

pub fn upsert_github_account(
    data_dir: &Path,
    account: &GitHubAccount,
) -> Result<(), IdentitiesError> {
    let mut file = load(data_dir);
    match file.github_accounts.iter_mut().find(|a| a.id == account.id) {
        Some(slot) => *slot = account.clone(),
        None => file.github_accounts.push(account.clone()),
    }
    save(data_dir, &file)
}

pub fn remove_github_account(data_dir: &Path, id: &str) -> Result<(), IdentitiesError> {
    let mut file = load(data_dir);
    file.github_accounts.retain(|a| a.id != id);
    save(data_dir, &file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-git-ids-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(id: &str, name: &str, email: &str) -> GitIdentityProfile {
        GitIdentityProfile {
            id: id.into(),
            name: None,
            user_name: name.into(),
            user_email: email.into(),
            auth_type: "ssh".into(),
            ssh_key: None,
            host: None,
            github_login: None,
            sign_commits: false,
            signing_key: None,
            color: String::new(),
            icon: String::new(),
            source: String::new(),
        }
    }

    #[test]
    fn missing_file_loads_empty() {
        let dir = temp_dir("missing");
        assert_eq!(load(&dir), GitIdentitiesFile::default());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn corrupt_file_recovers_empty() {
        let dir = temp_dir("corrupt");
        fs::write(dir.join(IDENTITIES_FILE), "{ nope").unwrap();
        assert_eq!(load(&dir), GitIdentitiesFile::default());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_fills_defaults_and_round_trips() {
        let dir = temp_dir("create");
        let created = create_profile(&dir, &profile("work", "Ada", "ada@example.com")).unwrap();
        assert_eq!(created.color, DEFAULT_COLOR);
        assert_eq!(created.icon, DEFAULT_ICON);
        assert_eq!(created.source, "manual");
        assert_eq!(created.display_name(), "Ada");

        let stored = get_profile(&dir, "work").unwrap();
        assert_eq!(stored, created);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_rejects_duplicate_id() {
        let dir = temp_dir("dup");
        create_profile(&dir, &profile("work", "Ada", "ada@example.com")).unwrap();
        let err = create_profile(&dir, &profile("work", "Ada L", "adal@example.com")).unwrap_err();
        assert!(err.to_string().contains("already exists"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_validates_fields() {
        let dir = temp_dir("validate");
        assert!(create_profile(&dir, &profile("a", "  ", "a@b.co")).is_err());
        assert!(create_profile(&dir, &profile("a", "Ada", "nope")).is_err());
        assert!(create_profile(&dir, &profile("a", "Ada", "a@b")).is_err());
        assert!(create_profile(&dir, &profile("a", "Ada", "a@.com")).is_err());
        assert!(create_profile(&dir, &profile("a", "O'Brien", "a@b.co")).is_err());
        let mut ssh = profile("a", "Ada", "a@b.co");
        ssh.ssh_key = Some("/home/ada/key'; rm -rf".into());
        assert!(create_profile(&dir, &ssh).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_requires_existing_and_persists() {
        let dir = temp_dir("update");
        assert!(update_profile(&dir, &profile("work", "Ada", "ada@example.com")).is_err());
        create_profile(&dir, &profile("work", "Ada", "ada@example.com")).unwrap();
        let updated =
            update_profile(&dir, &profile("work", "Ada Lovelace", "ada@example.com")).unwrap();
        assert_eq!(updated.display_name(), "Ada Lovelace");
        assert_eq!(get_profile(&dir, "work").unwrap().user_name, "Ada Lovelace");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_errors_when_absent() {
        let dir = temp_dir("delete");
        create_profile(&dir, &profile("work", "Ada", "ada@example.com")).unwrap();
        delete_profile(&dir, "work").unwrap();
        assert!(delete_profile(&dir, "work").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn escape_ssh_key_path_quotes_and_rejects() {
        assert_eq!(
            escape_ssh_key_path("/keys/id_ed25519").unwrap(),
            "ssh -i '/keys/id_ed25519'"
        );
        assert!(escape_ssh_key_path("/key's").is_err());
        assert!(escape_ssh_key_path("/key;cmd").is_err());
        assert!(escape_ssh_key_path("  ").is_err());
    }

    #[test]
    fn github_accounts_upsert_and_remove() {
        let dir = temp_dir("accounts");
        let account = GitHubAccount {
            id: "octocat".into(),
            login: "octocat".into(),
            avatar_url: Some("https://avatars.example/o".into()),
            account_id: Some("583231".into()),
        };
        upsert_github_account(&dir, &account).unwrap();
        let mut updated = account.clone();
        updated.avatar_url = None;
        upsert_github_account(&dir, &updated).unwrap();
        assert_eq!(list_github_accounts(&dir), vec![updated.clone()]);
        remove_github_account(&dir, "octocat").unwrap();
        assert!(list_github_accounts(&dir).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_file_without_accounts_field_still_loads() {
        let dir = temp_dir("legacy");
        fs::write(
            dir.join(IDENTITIES_FILE),
            r#"{"profiles":[{"id":"p","userName":"Ada","userEmail":"a@b.co","authType":"ssh"}]}"#,
        )
        .unwrap();
        let file = load(&dir);
        assert_eq!(file.github_accounts, Vec::<GitHubAccount>::new());
        assert_eq!(file.profiles[0].color, DEFAULT_COLOR);
        assert!(!file.profiles[0].sign_commits);
        fs::remove_dir_all(&dir).unwrap();
    }
}
