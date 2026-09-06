//! Git identities + GitHub accounts — port of tide's
//! `src-tauri/src/commands/git_identities.rs` on tide's daemon. Profiles
//! live in git-identities.json (store), tokens in config.json's
//! encrypted secrets map, application writes repo-local git config via
//! git2 (never --global). `git_set_identity` with the id `"global"` clears
//! the local override.

use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;

use git2::{ConfigLevel, Repository};

use protocol::git_panel::PanelCurrentIdentity;
use protocol::git_settings::{
    GhCliAccountWire, GhCliStatusWire, GitAttributionWire, GitDiscoveredCredentialWire,
    GitGlobalIdentityWire, GitOpResultWire, GitProfileWire, GitProjectStatusWire, GitSnapshotWire,
    GithubAccountWire, GithubConnectPollWire, GithubDeviceStartWire, ModelRefWire,
};
use serde_json::Value;
use store::git_identities::GitIdentityProfile;

/// Directory handle for the identities file + secrets-bearing config. Tests
/// construct `at()` with a scratch dir; production uses tide's data dir.
#[derive(Clone)]
pub struct GitIdentities {
    data_dir: PathBuf,
}

impl GitIdentities {
    pub fn shared() -> Self {
        Self {
            data_dir: store::paths::data_dir(),
        }
    }

    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: dir.into(),
        }
    }

    pub fn profiles(&self) -> Vec<GitIdentityProfile> {
        store::git_identities::get_profiles(&self.data_dir)
    }

    pub fn profile(&self, id: &str) -> Option<GitIdentityProfile> {
        store::git_identities::get_profile(&self.data_dir, id)
    }

    /// Create when the id is new, update when it exists — the settings
    /// dialog's single save path.
    pub fn save_profile(
        &self,
        input: &GitIdentityProfile,
        token: Option<String>,
    ) -> Result<GitIdentityProfile, String> {
        self.save_profile_with(input, token, store::secrets::encrypt_stored)
    }

    fn save_profile_with(
        &self,
        input: &GitIdentityProfile,
        token: Option<String>,
        encrypt: impl Fn(&str) -> store::secrets::SecretsResult<String>,
    ) -> Result<GitIdentityProfile, String> {
        let existing = store::git_identities::get_profile(&self.data_dir, &input.id);
        let profile = match existing {
            Some(_) => store::git_identities::update_profile(&self.data_dir, input),
            None => store::git_identities::create_profile(&self.data_dir, input),
        }
        .map_err(|e| e.to_string())?;
        // Upstream gates on `!token.is_empty()`; trim first so a paste of
        // whitespace never stores a bogus credential.
        if let Some(token) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            if profile.auth_type == "token" {
                self.store_secret_with(
                    &format!("gitIdentityToken:{}", profile.id),
                    &token,
                    encrypt,
                )?;
            }
        }
        Ok(profile)
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        // The OS credential helper's copy (if any) is deliberately left
        // alone — never purge credentials we didn't store ourselves.
        store::git_identities::delete_profile(&self.data_dir, id).map_err(|e| e.to_string())?;
        self.update_config(|cfg| {
            if let Some(map) = cfg.secrets.as_mut() {
                map.remove(&format!("gitIdentityToken:{id}"));
            }
            Ok(())
        })
    }

    pub fn stored_token(&self, name: &str) -> Result<Option<String>, String> {
        let stored = self
            .load_config()?
            .secrets
            .as_ref()
            .and_then(|m| m.get(name))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        match stored {
            None => Ok(None),
            Some(stored) => store::secrets::decrypt_stored(&stored).map_err(|e| e.to_string()),
        }
    }

    pub fn store_secret(&self, name: &str, token: &str) -> Result<(), String> {
        self.store_secret_with(name, token, store::secrets::encrypt_stored)
    }

    /// `store_secret` with the encryptor injected — tests substitute a
    /// plain transform so no keychain item is ever written.
    fn store_secret_with(
        &self,
        name: &str,
        token: &str,
        encrypt: impl Fn(&str) -> store::secrets::SecretsResult<String>,
    ) -> Result<(), String> {
        self.update_config(|cfg| {
            let encrypted = encrypt(token).map_err(|e| e.to_string())?;
            let map = cfg.secrets.get_or_insert_with(serde_json::Map::new);
            map.insert(name.into(), serde_json::Value::String(encrypted));
            Ok(())
        })
    }

    pub fn remove_secret(&self, name: &str) -> Result<(), String> {
        self.update_config(|cfg| {
            if let Some(map) = cfg.secrets.as_mut() {
                map.remove(name);
            }
            Ok(())
        })
    }

    pub fn set_identity(&self, root: &Path, profile_id: &str) -> GitOpResultWire {
        // Applying "Global" clears the override — the repo falls back to
        // the user's global config.
        if profile_id == "global" {
            return clear_override(root);
        }
        let Some(profile) = self.profile(profile_id) else {
            return GitOpResultWire::err(format!("unknown identity: {profile_id}"));
        };
        let repo = match Repository::open(root) {
            Ok(repo) => repo,
            Err(e) => return GitOpResultWire::err(format!("not a git repository: {e}")),
        };
        if let Err(e) = apply_profile_config(&repo, &profile) {
            return GitOpResultWire::err(e);
        }
        if profile.auth_type == "token" {
            if let Some(host) = profile.host.as_deref().filter(|h| !h.is_empty()) {
                let secret_name = if profile.source == "github" {
                    profile
                        .github_login
                        .as_deref()
                        .map(|login| format!("github:{login}"))
                } else {
                    Some(format!("gitIdentityToken:{}", profile.id))
                };
                if let Some(secret_name) = secret_name {
                    if let Ok(Some(token)) = self.stored_token(&secret_name) {
                        let username = profile
                            .github_login
                            .as_deref()
                            .unwrap_or(&profile.user_name);
                        credential_approve(root, host, username, &token);
                    } else {
                        eprintln!(
                            "[tide] identity {} has no stored token; helper not updated",
                            profile.id
                        );
                    }
                }
            }
        }
        GitOpResultWire {
            ok: true,
            error: None,
        }
    }

    pub fn clear_identity(&self, root: &Path) -> GitOpResultWire {
        clear_override(root)
    }

    pub fn global_identity(&self) -> GitGlobalIdentityWire {
        GitGlobalIdentityWire {
            name: global_config_string("user.name"),
            email: global_config_string("user.email"),
            ssh_command: global_config_string("core.sshCommand"),
        }
    }

    /// One row per project: local config → global fallback → profile match
    /// on the (user.name, user.email) pair. The global chain opens once,
    /// not once per row.
    pub fn statuses(&self, projects: &[protocol::model::Project]) -> Vec<GitProjectStatusWire> {
        let profiles = self.profiles();
        let global_name = global_config_string("user.name");
        let global_email = global_config_string("user.email");
        projects
            .iter()
            .map(|project| {
                let repo = Repository::open(&project.path).ok();
                let local = repo
                    .as_ref()
                    .and_then(|r| r.config().ok())
                    .and_then(|cfg| cfg.open_level(ConfigLevel::Local).ok());
                let has_override = local.as_ref().is_some_and(|cfg| {
                    cfg.get_string("user.name").is_ok() || cfg.get_string("user.email").is_ok()
                });
                let name = local
                    .as_ref()
                    .and_then(|cfg| cfg.get_string("user.name").ok())
                    .or_else(|| global_name.clone());
                let email = local
                    .as_ref()
                    .and_then(|cfg| cfg.get_string("user.email").ok())
                    .or_else(|| global_email.clone());
                let profile_id = match (&name, &email) {
                    (Some(name), Some(email)) => profiles
                        .iter()
                        .find(|p| p.user_name == *name && p.user_email == *email)
                        .map(|p| p.id.clone()),
                    _ => None,
                };
                GitProjectStatusWire {
                    project_id: project.id,
                    name: project.name.clone(),
                    path: project.path.display().to_string(),
                    is_repo: repo.is_some(),
                    has_override,
                    identity_name: name,
                    identity_email: email,
                    profile_id,
                }
            })
            .collect()
    }

    /// The identity the next commit at `root` would use — local
    /// user.name/user.email with global fallback — plus the matching profile
    /// id when the resolved pair equals a stored profile (the Git panel
    /// colors its dot from it). Port of tide's `current_identity`.
    pub fn current_identity(&self, root: &Path) -> PanelCurrentIdentity {
        let repo = match Repository::open(root) {
            Ok(repo) => repo,
            Err(_) => {
                return PanelCurrentIdentity::default();
            }
        };
        let local = repo
            .config()
            .ok()
            .and_then(|cfg| cfg.open_level(ConfigLevel::Local).ok());
        let name = local
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.name").ok())
            .or_else(|| global_config_string("user.name"));
        let email = local
            .as_ref()
            .and_then(|cfg| cfg.get_string("user.email").ok())
            .or_else(|| global_config_string("user.email"));
        let profile_id = match (&name, &email) {
            (Some(name), Some(email)) => self
                .profiles()
                .into_iter()
                .find(|p| p.user_name == *name && p.user_email == *email)
                .map(|p| p.id),
            _ => None,
        };
        PanelCurrentIdentity {
            name,
            email,
            profile_id,
        }
    }

    pub fn github_accounts(&self) -> Vec<store::git_identities::GitHubAccount> {
        store::git_identities::list_github_accounts(&self.data_dir)
    }

    /// Persist the account card + encrypted token after a successful
    /// connect. Tests inject the encryptor so no keychain item is written.
    pub fn persist_github_account_with(
        &self,
        login: &str,
        avatar_url: Option<String>,
        account_id: Option<String>,
        token: &str,
        encrypt: impl Fn(&str) -> store::secrets::SecretsResult<String>,
    ) -> Result<(), String> {
        let account = store::git_identities::GitHubAccount {
            id: login.into(),
            login: login.into(),
            avatar_url,
            account_id,
        };
        store::git_identities::upsert_github_account(&self.data_dir, &account)
            .map_err(|e| e.to_string())?;
        self.store_secret_with(&format!("github:{login}"), token, encrypt)
    }

    pub fn persist_github_account(
        &self,
        login: &str,
        avatar_url: Option<String>,
        account_id: Option<String>,
        token: &str,
    ) -> Result<(), String> {
        self.persist_github_account_with(
            login,
            avatar_url,
            account_id,
            token,
            &store::secrets::encrypt_stored,
        )
    }

    /// Disconnect one account: remove its card + `github:{login}` secret.
    /// Idempotent by design — removing the secret of an already-absent
    /// account is harmless (upstream doesn't error either), so a stale
    /// Disconnect click cleans up rather than fails.
    pub fn github_disconnect(&self, login: &str) -> Result<(), String> {
        store::git_identities::remove_github_account(&self.data_dir, login)
            .map_err(|e| e.to_string())?;
        self.remove_secret(&format!("github:{login}"))
    }

    pub fn github_connect_start(&self) -> anyhow::Result<GithubDeviceStartWire> {
        let form = [
            ("client_id", client_id()),
            ("scope", GITHUB_SCOPE.to_owned()),
        ];
        let reply = post_form_json(DEVICE_CODE_URL, &form)?;
        let start = parse_device_start(&reply).map_err(anyhow::Error::msg)?;
        Ok(GithubDeviceStartWire {
            device_code: start.device_code,
            user_code: start.user_code,
            verification_uri: start.verification_uri,
            expires_in: start.expires_in,
            interval: start.interval,
        })
    }

    pub fn github_connect_poll(&self, device_code: &str) -> anyhow::Result<GithubConnectPollWire> {
        let form = [
            ("client_id", client_id()),
            ("device_code", device_code.to_owned()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_owned(),
            ),
        ];
        let reply = post_form_json(TOKEN_URL, &form)?;
        Ok(match parse_token_reply(&reply) {
            // SlowDown folds into "pending": RFC 8628's interval increase is
            // deliberately deferred to the polling layer (the UI driver owns
            // the cadence).
            TokenReply::Pending | TokenReply::SlowDown => GithubConnectPollWire {
                status: "pending".into(),
                login: None,
                avatar_url: None,
                error: None,
            },
            TokenReply::Denied => GithubConnectPollWire {
                status: "denied".into(),
                login: None,
                avatar_url: None,
                error: Some("authorization denied".into()),
            },
            TokenReply::Expired => GithubConnectPollWire {
                status: "expired".into(),
                login: None,
                avatar_url: None,
                error: Some("code expired".into()),
            },
            TokenReply::Token(token) => {
                let user = github_user(&token)?;
                let Some((login, avatar_url, account_id)) = parse_github_user(&user) else {
                    anyhow::bail!("github user reply missing login");
                };
                self.persist_github_account(&login, avatar_url.clone(), account_id, &token)
                    .map_err(anyhow::Error::msg)?;
                GithubConnectPollWire {
                    status: "success".into(),
                    login: Some(login),
                    avatar_url,
                    error: None,
                }
            }
            TokenReply::Other(error) => GithubConnectPollWire {
                status: "error".into(),
                login: None,
                avatar_url: None,
                error: Some(error),
            },
        })
    }

    /// One-click connect: pull the account's token out of the gh CLI
    /// keyring, validate it against the API, persist like a device-flow
    /// success. No browser round-trip.
    pub fn github_connect_from_gh_cli(&self, login: &str) -> anyhow::Result<GithubConnectPollWire> {
        let output = crate::command_env::command("gh")
            .args(["auth", "token", "--hostname", "github.com", "--user", login])
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| anyhow::anyhow!("gh CLI unavailable: {e}"))?;
        if !output.status.success() {
            return Ok(GithubConnectPollWire {
                status: "error".into(),
                login: None,
                avatar_url: None,
                error: Some(format!(
                    "gh auth token failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )),
            });
        }
        let token = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if token.is_empty() {
            return Ok(GithubConnectPollWire {
                status: "error".into(),
                login: None,
                avatar_url: None,
                error: Some("gh auth token returned no token".into()),
            });
        }
        let user = github_user(&token)?;
        let Some((api_login, avatar_url, account_id)) = parse_github_user(&user) else {
            return Ok(GithubConnectPollWire {
                status: "error".into(),
                login: None,
                avatar_url: None,
                error: Some("github user reply missing login".into()),
            });
        };
        self.persist_github_account(&api_login, avatar_url.clone(), account_id, &token)
            .map_err(anyhow::Error::msg)?;
        Ok(GithubConnectPollWire {
            status: "success".into(),
            login: Some(api_login),
            avatar_url,
            error: None,
        })
    }

    fn load_config(&self) -> Result<store::config::Config, String> {
        store::config::load(&self.data_dir.join("config.json")).map_err(|e| e.to_string())
    }

    fn update_config(
        &self,
        mutate: impl FnOnce(&mut store::config::Config) -> Result<(), String>,
    ) -> Result<(), String> {
        // The lock spans load → mutate → save: this file is shared with
        // provider management and the background enrichment pass.
        let _guard = crate::TIDE_CONFIG_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut cfg = self.load_config()?;
        mutate(&mut cfg)?;
        store::config::save(&self.data_dir.join("config.json"), &cfg).map_err(|e| e.to_string())
    }
}

/// The keys an identity application owns; clear = unset exactly these.
const LOCAL_IDENTITY_KEYS: [&str; 5] = [
    "user.name",
    "user.email",
    "core.sshCommand",
    "commit.gpgsign",
    "user.signingkey",
];

fn local_config(repo: &Repository) -> Result<git2::Config, String> {
    repo.config()
        .and_then(|cfg| cfg.open_level(ConfigLevel::Local))
        .map_err(|e| format!("cannot open local git config: {e}"))
}

fn set_local(cfg: &mut git2::Config, key: &str, value: &str) -> Result<(), String> {
    cfg.set_str(key, value)
        .map_err(|e| format!("git config {key}: {e}"))
}

/// Unset ignoring not-found (the key wasn't ours to clear).
fn unset_local(cfg: &mut git2::Config, key: &str) -> Result<(), String> {
    match cfg.remove(key) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(()),
        Err(e) => Err(format!("git config --unset {key}: {e}")),
    }
}

fn apply_profile_config(repo: &Repository, profile: &GitIdentityProfile) -> Result<(), String> {
    let mut cfg = local_config(repo)?;
    set_local(&mut cfg, "user.name", &profile.user_name)?;
    set_local(&mut cfg, "user.email", &profile.user_email)?;
    match profile.auth_type.as_str() {
        "ssh" => {
            let key = profile.ssh_key.as_deref().unwrap_or("");
            let command = if key.is_empty() {
                String::new()
            } else {
                store::git_identities::escape_ssh_key_path(key).map_err(|e| e.to_string())?
            };
            if command.is_empty() {
                unset_local(&mut cfg, "core.sshCommand")?;
            } else {
                set_local(&mut cfg, "core.sshCommand", &command)?;
            }
        }
        _ => unset_local(&mut cfg, "core.sshCommand")?,
    }
    if profile.sign_commits {
        set_local(&mut cfg, "commit.gpgsign", "true")?;
        match profile.signing_key.as_deref() {
            Some(key) if !key.trim().is_empty() => set_local(&mut cfg, "user.signingkey", key)?,
            _ => unset_local(&mut cfg, "user.signingkey")?,
        }
    } else {
        unset_local(&mut cfg, "commit.gpgsign")?;
        unset_local(&mut cfg, "user.signingkey")?;
    }
    Ok(())
}

fn clear_profile_config(repo: &Repository) -> Result<(), String> {
    let mut cfg = local_config(repo)?;
    for key in LOCAL_IDENTITY_KEYS {
        unset_local(&mut cfg, key)?;
    }
    Ok(())
}

/// Shared clear path for `set_identity("global")` and `clear_identity`:
/// open the repo and unset exactly the identity-owned local keys.
fn clear_override(root: &Path) -> GitOpResultWire {
    Repository::open(root)
        .map_err(|e| format!("not a git repository: {e}"))
        .and_then(|repo| clear_profile_config(&repo))
        .map(|_| GitOpResultWire {
            ok: true,
            error: None,
        })
        .unwrap_or_else(GitOpResultWire::err)
}

// ── ~/.git-credentials discovery ────────────────────────────────────────

/// Parse `~/.git-credentials` URL lines into deduped `{host, username}`
/// pairs. The password/token half is deliberately dropped — discovered
/// entries prefill profiles; the user completes the secret.
pub fn parse_git_credentials(text: &str) -> Vec<GitDiscoveredCredentialWire> {
    let mut out: Vec<GitDiscoveredCredentialWire> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(after_scheme) = line
            .strip_prefix("https://")
            .or(line.strip_prefix("http://"))
        else {
            continue;
        };
        let Some((userinfo, rest)) = after_scheme.split_once('@') else {
            continue;
        };
        let Some(username) = userinfo.split(':').next() else {
            continue;
        };
        let Some(host) = rest.split('/').next() else {
            continue;
        };
        if username.is_empty() || host.is_empty() {
            continue;
        }
        if !out.iter().any(|c| c.host == host && c.username == username) {
            out.push(GitDiscoveredCredentialWire {
                host: host.into(),
                username: username.into(),
            });
        }
    }
    out
}

pub fn discover_credentials() -> Vec<GitDiscoveredCredentialWire> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let path = Path::new(&home).join(".git-credentials");
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_git_credentials(&text),
        Err(_) => Vec::new(),
    }
}

fn global_config_string(key: &str) -> Option<String> {
    git2::Config::open_default()
        .ok()
        .and_then(|cfg| cfg.get_string(key).ok())
}

/// `git credential approve` — feeds the token to the user's configured
/// helper(s). Best-effort: config application already succeeded, so a
/// missing git binary or failing helper logs instead of failing the apply.
fn credential_approve(workdir: &Path, host: &str, username: &str, token: &str) {
    let mut command = crate::command_env::command("git");
    command
        .args([
            "-c",
            "credential.interactive=false",
            "credential",
            "approve",
        ])
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        eprintln!("[tide] credential approve skipped: git CLI unavailable");
        return;
    };
    let request = format!("url=https://{host}\nusername={username}\npassword={token}\n\n");
    if let Some(stdin) = child.stdin.as_mut() {
        if stdin.write_all(request.as_bytes()).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
    }
    // Close stdin so a helper reading to EOF sees it and can't deadlock.
    drop(child.stdin.take());
    match child.wait() {
        Ok(status) if status.success() => {}
        other => eprintln!("[tide] credential approve failed: {other:?}"),
    }
}

// ── GitHub device flow ──────────────────────────────────────────────────

/// Tide's GitHub OAuth app (device flow; no client secret — public client).
/// Overridable via TIDE_GITHUB_CLIENT_ID for dev/forks.
const GITHUB_CLIENT_ID: &str = "Ov23lionvmSN4H63OP4D";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL: &str = "https://api.github.com/user";
/// `repo` so OAuth-backed token identities can actually push; `read:user`
/// for the account card.
const GITHUB_SCOPE: &str = "repo read:user";

fn client_id() -> String {
    std::env::var("TIDE_GITHUB_CLIENT_ID").unwrap_or_else(|_| GITHUB_CLIENT_ID.into())
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TokenReply {
    Pending,
    SlowDown,
    Denied,
    Expired,
    Token(String),
    Other(String),
}

/// Pure halves of the device-flow state machine so the polling rules are
/// testable without HTTP.
pub fn parse_device_start(value: &Value) -> Result<DeviceStart, String> {
    let device_code = value
        .get("device_code")
        .and_then(Value::as_str)
        .ok_or_else(|| "device flow: no device_code in reply".to_owned())?;
    Ok(DeviceStart {
        device_code: device_code.into(),
        user_code: value
            .get("user_code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        verification_uri: value
            .get("verification_uri")
            .and_then(Value::as_str)
            .unwrap_or("https://github.com/login/device")
            .into(),
        expires_in: value
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(900),
        interval: value.get("interval").and_then(Value::as_u64).unwrap_or(5),
    })
}

pub fn parse_token_reply(value: &Value) -> TokenReply {
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return match error {
            "authorization_pending" => TokenReply::Pending,
            "slow_down" => TokenReply::SlowDown,
            "access_denied" => TokenReply::Denied,
            "expired_token" => TokenReply::Expired,
            other => TokenReply::Other(other.into()),
        };
    }
    match value.get("access_token").and_then(Value::as_str) {
        Some(token) if !token.is_empty() => TokenReply::Token(token.into()),
        _ => TokenReply::Other("no access_token in reply".into()),
    }
}

pub fn parse_github_user(value: &Value) -> Option<(String, Option<String>, Option<String>)> {
    let login = value.get("login").and_then(Value::as_str)?;
    Some((
        login.into(),
        value
            .get("avatar_url")
            .and_then(Value::as_str)
            .map(str::to_owned),
        value
            .get("id")
            .and_then(Value::as_i64)
            .map(|id| id.to_string()),
    ))
}

fn http_client() -> anyhow::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| anyhow::anyhow!("could not build the github client: {e}"))
}

fn post_form_json(url: &str, form: &[(&str, String)]) -> anyhow::Result<Value> {
    let client = http_client()?;
    let response = client
        .post(url)
        .header("Accept", "application/json")
        // "tide" is deliberate upstream parity — the OAuth app and API
        // fingerprints are Tide's; don't "fix" to tide.
        .header("User-Agent", "tide")
        .form(form)
        .send()
        .map_err(|e| anyhow::anyhow!("github request failed: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("github request failed: {e}"))?;
    response
        .json::<Value>()
        .map_err(|e| anyhow::anyhow!("github reply was not json: {e}"))
}

fn github_user(token: &str) -> anyhow::Result<Value> {
    let client = http_client()?;
    client
        .get(GITHUB_USER_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        // "tide" is deliberate upstream parity — the OAuth app and API
        // fingerprints are Tide's; don't "fix" to tide.
        .header("User-Agent", "tide")
        .send()
        .map_err(|e| anyhow::anyhow!("github user lookup failed: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow::anyhow!("github user lookup failed: {e}"))?
        .json::<Value>()
        .map_err(|e| anyhow::anyhow!("github user reply was not json: {e}"))
}

// ── GitHub CLI (gh) detection ───────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct GhAccount {
    pub login: String,
    pub active: bool,
}

/// Parse `gh auth status` text (stdout+stderr combined — gh writes the
/// account blocks to either). One block per account; a lone account has no
/// Active line and is active by definition.
pub fn parse_gh_auth_status(text: &str) -> Vec<GhAccount> {
    let mut accounts: Vec<GhAccount> = Vec::new();
    let mut current: Option<usize> = None;
    for line in text.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("✓ Logged in to ") {
            if let Some((_, after)) = rest.split_once(" account ") {
                let login = after
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_matches(|c| c == '(' || c == ')');
                if !login.is_empty() {
                    current = Some(accounts.len());
                    accounts.push(GhAccount {
                        login: login.into(),
                        active: false,
                    });
                }
            }
        } else if let Some(rest) = line.strip_prefix("- Active account:") {
            if rest.trim() == "true" {
                if let Some(index) = current {
                    accounts[index].active = true;
                }
            }
        } else if line.starts_with("✗") {
            current = None;
        }
    }
    if accounts.len() == 1 && !accounts[0].active {
        accounts[0].active = true;
    }
    accounts
}

pub fn gh_cli_status() -> GhCliStatusWire {
    // One-shot command cadence: `.output()` drains and reaps the child;
    // gh writes the account blocks to either stream, so both are read.
    let output = crate::command_env::command("gh")
        .args(["auth", "status", "--hostname", "github.com"])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return GhCliStatusWire {
            installed: false,
            accounts: Vec::new(),
        };
    };
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    GhCliStatusWire {
        installed: true,
        accounts: parse_gh_auth_status(&text)
            .into_iter()
            .map(|a| GhCliAccountWire {
                login: a.login,
                active: a.active,
            })
            .collect(),
    }
}

// ── Settings snapshot ───────────────────────────────────────────────────

/// Everything the settings screen renders, in one payload. One-shot
/// command cadence — subprocess and config I/O are fine here, but this
/// must never be reachable from a frame.
pub fn git_snapshot(projects: &[protocol::model::Project]) -> GitSnapshotWire {
    let identities = GitIdentities::shared();
    let general = match store::config::load(&store::paths::config_path()) {
        Ok(cfg) => cfg
            .general_settings
            .map(|g| g.effective())
            .unwrap_or_default(),
        Err(e) => {
            eprintln!("[tide] tide config unreadable, rendering default attribution: {e}");
            Default::default()
        }
    };
    let wire_profile = |p: GitIdentityProfile| GitProfileWire {
        id: p.id,
        name: p.name,
        user_name: p.user_name,
        user_email: p.user_email,
        auth_type: p.auth_type,
        ssh_key: p.ssh_key,
        host: p.host,
        github_login: p.github_login,
        sign_commits: p.sign_commits,
        signing_key: p.signing_key,
        color: p.color,
        icon: p.icon,
        source: p.source,
    };
    let wire_account = |a: store::git_identities::GitHubAccount| GithubAccountWire {
        id: a.id,
        login: a.login,
        avatar_url: a.avatar_url,
        account_id: a.account_id,
    };
    GitSnapshotWire {
        profiles: identities
            .profiles()
            .into_iter()
            .map(wire_profile)
            .collect(),
        accounts: identities
            .github_accounts()
            .into_iter()
            .map(wire_account)
            .collect(),
        gh_cli: gh_cli_status(),
        statuses: identities.statuses(projects),
        attribution: GitAttributionWire {
            co_authored: general.git_co_authored,
            name: general.git_co_author_name.clone(),
            email: general.git_co_author_email.clone(),
            mode: general.git_attribution_mode.clone(),
        },
        global: identities.global_identity(),
        background_title_model: general.title_model.map(|r| ModelRefWire {
            provider_id: r.provider_id,
            model_id: r.model_id,
        }),
        background_commit_model: general.commit_message_model.map(|r| ModelRefWire {
            provider_id: r.provider_id,
            model_id: r.model_id,
        }),
    }
}

/// Per-key attribution update, mirroring tide's per-key settings merge:
/// absent keys keep their stored value, present keys overwrite.
pub fn update_attribution(
    git_co_authored: Option<bool>,
    git_attribution_mode: Option<String>,
) -> Result<(), String> {
    let _guard = crate::TIDE_CONFIG_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let path = store::paths::config_path();
    let mut cfg = store::config::load(&path).map_err(|e| e.to_string())?;
    let general = cfg.general_settings.get_or_insert_with(Default::default);
    if let Some(value) = git_co_authored {
        general.git_co_authored = Some(value);
    }
    if let Some(mode) = git_attribution_mode {
        if !matches!(mode.as_str(), "co-author" | "author") {
            return Err(format!("unknown attribution mode: {mode}"));
        }
        general.git_attribution_mode = Some(mode);
    }
    store::config::save(&path, &cfg).map_err(|e| e.to_string())
}

/// Per-task background-model update: `task` is `"title"` | `"commit-message"`;
/// `model: None` clears the override (fall back to the session model).
/// A provided pair is validated against tide config providers AND the known
/// `ProviderKind` catalog names — an unknown pair errors without writing.
pub fn set_background_model(
    task: &str,
    model: Option<store::config::ModelRef>,
) -> Result<(), String> {
    let _guard = crate::TIDE_CONFIG_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let path = store::paths::config_path();
    let mut cfg = store::config::load(&path).map_err(|e| e.to_string())?;
    if let Some(r#override) = &model {
        // Validate against the loaded config before touching stored state.
        crate::driver::tide::resolve_background_model_strict(&cfg, r#override)?;
    }
    let general = cfg.general_settings.get_or_insert_with(Default::default);
    match task {
        "title" => general.title_model = model,
        "commit-message" => general.commit_message_model = model,
        _ => return Err(format!("unknown background task: {task}")),
    }
    store::config::save(&path, &cfg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::RepositoryInitOptions;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-gitids-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // set_var/remove_var are process-global; serialize the env-touching tests.

    #[test]
    fn update_attribution_merges_per_key_and_rejects_unknown_modes() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let dir = temp_dir("attribution");
        // Edition 2024: env mutation is unsafe because it is process-global;
        // ENV_LOCK serializes the mutation against the other env tests.
        unsafe { std::env::set_var("TIDE_DATA_DIR", &dir) };

        // Absent config → update writes only the touched keys.
        update_attribution(Some(false), Some("author".into())).unwrap();
        let cfg = store::config::load(&dir.join("config.json")).unwrap();
        let general = cfg.general_settings.unwrap();
        assert_eq!(general.git_co_authored, Some(false));
        assert_eq!(general.git_attribution_mode.as_deref(), Some("author"));
        // Per-key merge: untouched GeneralSettings fields stay absent.
        assert_eq!(general.start_at_login, None);
        assert_eq!(general.notifications, None);

        // An invalid mode errors and writes nothing.
        let before = fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(update_attribution(None, Some("bogus".into())).is_err());
        assert_eq!(fs::read_to_string(dir.join("config.json")).unwrap(), before);

        unsafe { std::env::remove_var("TIDE_DATA_DIR") };
        fs::remove_dir_all(&dir).unwrap();
    }

    fn scratch_tide_config(dir: &Path) {
        fs::write(
            dir.join("config.json"),
            r#"{
                "providers": [
                    {
                        "id": "p1", "name": "One", "apiStyle": "anthropic", "baseUrl": "",
                        "models": [
                            {"id": "m-a", "alias": "", "modelId": "model-a", "contextWindow": 1000, "providerId": "p1"}
                        ]
                    }
                ]
            }"#,
        )
        .unwrap();
    }

    fn model_ref(provider_id: &str, model_id: &str) -> store::config::ModelRef {
        store::config::ModelRef {
            provider_id: provider_id.into(),
            model_id: model_id.into(),
        }
    }

    #[test]
    fn set_background_model_round_trips_and_clears() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let dir = temp_dir("bgmodel");
        unsafe { std::env::set_var("TIDE_DATA_DIR", &dir) };
        scratch_tide_config(&dir);

        // A tide provider ref is accepted for either task and round-trips
        // through the stored config.
        set_background_model("title", Some(model_ref("p1", "model-a"))).unwrap();
        set_background_model("commit-message", Some(model_ref("p1", "model-a"))).unwrap();
        let cfg = store::config::load(&dir.join("config.json")).unwrap();
        let general = cfg.general_settings.clone().unwrap();
        assert_eq!(general.title_model, Some(model_ref("p1", "model-a")));
        assert_eq!(
            general.commit_message_model,
            Some(model_ref("p1", "model-a"))
        );

        // The settings snapshot carries both overrides so the General page
        // renders them without a second read command.
        let snapshot = git_snapshot(&[]);
        assert_eq!(
            snapshot.background_title_model,
            Some(protocol::git_settings::ModelRefWire {
                provider_id: "p1".into(),
                model_id: "model-a".into()
            })
        );
        assert_eq!(
            snapshot.background_commit_model,
            Some(protocol::git_settings::ModelRefWire {
                provider_id: "p1".into(),
                model_id: "model-a".into()
            })
        );

        // Both stored refs resolve to the tide sub-provider.
        assert_eq!(
            crate::driver::tide::background_model_override("title"),
            Some(crate::driver::tide::BackgroundModel::Tide {
                provider_id: "p1".into(),
                model_id: "model-a".into()
            })
        );
        assert_eq!(
            crate::driver::tide::background_model_override("commit-message"),
            Some(crate::driver::tide::BackgroundModel::Tide {
                provider_id: "p1".into(),
                model_id: "model-a".into()
            })
        );

        // Clearing falls back to "use the session's model".
        set_background_model("title", None).unwrap();
        set_background_model("commit-message", None).unwrap();
        assert_eq!(
            crate::driver::tide::background_model_override("title"),
            None
        );
        assert_eq!(
            crate::driver::tide::background_model_override("commit-message"),
            None
        );
        let cfg = store::config::load(&dir.join("config.json")).unwrap();
        let general = cfg.general_settings.unwrap();
        assert_eq!(general.title_model, None);
        assert_eq!(general.commit_message_model, None);

        unsafe { std::env::remove_var("TIDE_DATA_DIR") };
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn set_background_model_rejects_unknown_providers_and_tasks() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let dir = temp_dir("bgmodel-invalid");
        unsafe { std::env::set_var("TIDE_DATA_DIR", &dir) };
        scratch_tide_config(&dir);

        let before = fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(set_background_model("title", Some(model_ref("nope", "m"))).is_err());
        assert!(set_background_model("bogus-task", Some(model_ref("p1", "model-a"))).is_err());
        // Nothing was written on either failure.
        assert_eq!(fs::read_to_string(dir.join("config.json")).unwrap(), before);

        unsafe { std::env::remove_var("TIDE_DATA_DIR") };
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn background_model_override_tolerates_vanished_providers() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let dir = temp_dir("bgmodel-stale");
        unsafe { std::env::set_var("TIDE_DATA_DIR", &dir) };
        scratch_tide_config(&dir);

        // Stored ref whose tide provider disappeared (and is no ProviderKind).
        set_background_model("title", Some(model_ref("p1", "model-a"))).unwrap();
        fs::write(
            dir.join("config.json"),
            r#"{"generalSettings": {"titleModel": {"providerId": "gone", "modelId": "m"}}}"#,
        )
        .unwrap();
        assert_eq!(
            crate::driver::tide::background_model_override("title"),
            None
        );

        // Unset → None as well.
        fs::write(dir.join("config.json"), r#"{}"#).unwrap();
        assert_eq!(
            crate::driver::tide::background_model_override("title"),
            None
        );

        unsafe { std::env::remove_var("TIDE_DATA_DIR") };
        fs::remove_dir_all(&dir).unwrap();
    }

    fn seeded_repo(dir: &Path, name: &str) -> PathBuf {
        let root = dir.join(name);
        fs::create_dir_all(&root).unwrap();
        Repository::init_opts(&root, RepositoryInitOptions::new().initial_head("main")).unwrap();
        root
    }

    fn repo_local(root: &Path) -> git2::Config {
        Repository::open(root)
            .unwrap()
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap()
    }

    fn test_profile(id: &str) -> GitIdentityProfile {
        GitIdentityProfile {
            id: id.into(),
            name: None,
            user_name: "Ada".into(),
            user_email: "ada@example.com".into(),
            auth_type: "ssh".into(),
            ssh_key: Some("/keys/id_ed25519".into()),
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
    fn apply_writes_local_only_and_clear_unsets() {
        let dir = temp_dir("apply");
        let root = seeded_repo(&dir, "repo");
        let profile = git_identities_create_for_test(&dir, &test_profile("work"));

        let repo = Repository::open(&root).unwrap();
        apply_profile_config(&repo, &profile).unwrap();
        let cfg = repo_local(&root);
        assert_eq!(cfg.get_string("user.name").unwrap(), "Ada");
        assert_eq!(cfg.get_string("user.email").unwrap(), "ada@example.com");
        assert_eq!(
            cfg.get_string("core.sshCommand").unwrap(),
            "ssh -i '/keys/id_ed25519'"
        );

        clear_profile_config(&repo).unwrap();
        let cfg = repo_local(&root);
        assert!(cfg.get_string("user.name").is_err());
        assert!(cfg.get_string("core.sshCommand").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn apply_signing_only_when_enabled() {
        let dir = temp_dir("sign");
        let root = seeded_repo(&dir, "repo");
        let mut profile = test_profile("work");
        profile.ssh_key = None;
        profile.sign_commits = true;
        profile.signing_key = Some("ABC123".into());
        let profile = git_identities_create_for_test(&dir, &profile);

        let repo = Repository::open(&root).unwrap();
        apply_profile_config(&repo, &profile).unwrap();
        let cfg = repo_local(&root);
        assert_eq!(cfg.get_string("commit.gpgsign").unwrap(), "true");
        assert_eq!(cfg.get_string("user.signingkey").unwrap(), "ABC123");

        let mut unsigned = profile.clone();
        unsigned.sign_commits = false;
        apply_profile_config(&repo, &unsigned).unwrap();
        let cfg = repo_local(&root);
        assert!(cfg.get_string("commit.gpgsign").is_err());
        assert!(cfg.get_string("user.signingkey").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Plain-base64 stand-in for the kcv2 keychain envelope: `decrypt_with`
    /// passes non-kcv2 handles through as plaintext, so the read side
    /// round-trips without any keychain access.
    fn b64_encrypt(value: &str) -> store::secrets::SecretsResult<String> {
        use base64::Engine as _;
        Ok(base64::engine::general_purpose::STANDARD.encode(value))
    }

    #[test]
    fn identity_save_stores_profile_and_encrypted_token() {
        let dir = temp_dir("crud");
        let identities = GitIdentities::at(&dir);
        let mut profile = test_profile("tok");
        profile.auth_type = "token".into();
        profile.ssh_key = None;
        profile.host = Some("github.com".into());
        identities
            .save_profile_with(&profile, Some("ghp_secret".into()), b64_encrypt)
            .unwrap();

        let stored = identities.profile("tok").unwrap();
        assert_eq!(stored.auth_type, "token");
        // The token never appears in git-identities.json...
        let identities_text = fs::read_to_string(dir.join("git-identities.json")).unwrap();
        assert!(!identities_text.contains("ghp_secret"));
        // ...and config.json holds a transformed value, not the plaintext.
        let config_text = fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(!config_text.contains("ghp_secret"));
        assert_eq!(
            identities
                .stored_token("gitIdentityToken:tok")
                .unwrap()
                .as_deref(),
            Some("ghp_secret")
        );

        // Update path: same id updates in place.
        let mut renamed = profile.clone();
        renamed.user_name = "Ada Lovelace".into();
        identities
            .save_profile_with(&renamed, None, b64_encrypt)
            .unwrap();
        assert_eq!(identities.profile("tok").unwrap().user_name, "Ada Lovelace");

        // Delete removes profile and secret.
        identities.delete_profile("tok").unwrap();
        assert!(identities.profile("tok").is_none());
        assert_eq!(
            identities.stored_token("gitIdentityToken:tok").unwrap(),
            None
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn identity_save_gates_token_storage() {
        let dir = temp_dir("gate");
        let identities = GitIdentities::at(&dir);

        // ssh profiles never store a token even when one is supplied.
        let ssh = test_profile("ssh1");
        identities
            .save_profile_with(&ssh, Some("ghp_secret".into()), b64_encrypt)
            .unwrap();
        assert_eq!(
            identities.stored_token("gitIdentityToken:ssh1").unwrap(),
            None
        );

        // A whitespace-only token is treated as absent.
        let mut token_profile = test_profile("ws");
        token_profile.auth_type = "token".into();
        token_profile.ssh_key = None;
        identities
            .save_profile_with(&token_profile, Some("   ".into()), b64_encrypt)
            .unwrap();
        assert_eq!(
            identities.stored_token("gitIdentityToken:ws").unwrap(),
            None
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remove_secret_drops_the_named_entry() {
        let dir = temp_dir("rmsecret");
        let identities = GitIdentities::at(&dir);
        identities
            .store_secret_with("gitIdentityToken:x", "tok", b64_encrypt)
            .unwrap();
        assert_eq!(
            identities
                .stored_token("gitIdentityToken:x")
                .unwrap()
                .as_deref(),
            Some("tok")
        );
        identities.remove_secret("gitIdentityToken:x").unwrap();
        assert_eq!(identities.stored_token("gitIdentityToken:x").unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    fn project(project_id: &str, path: &Path) -> protocol::model::Project {
        protocol::model::Project {
            id: uuid::Uuid::parse_str(project_id).unwrap(),
            name: "repo".into(),
            path: path.to_path_buf(),
            created_at: 0,
        }
    }

    #[test]
    fn statuses_resolve_override_and_profile_match() {
        let dir = temp_dir("statuses");
        let root = seeded_repo(&dir, "repo");
        let identities = GitIdentities::at(&dir);
        let profile = identities
            .save_profile(&test_profile("work"), None)
            .unwrap();
        apply_profile_config(&Repository::open(&root).unwrap(), &profile).unwrap();

        let projects = vec![project("00000000-0000-0000-0000-000000000001", &root)];
        let statuses = identities.statuses(&projects);
        assert_eq!(statuses.len(), 1);
        assert!(statuses[0].is_repo);
        assert!(statuses[0].has_override);
        assert_eq!(statuses[0].profile_id.as_deref(), Some("work"));
        assert_eq!(statuses[0].identity_name.as_deref(), Some("Ada"));
        assert_eq!(
            statuses[0].identity_email.as_deref(),
            Some("ada@example.com")
        );

        clear_profile_config(&Repository::open(&root).unwrap()).unwrap();
        let statuses = identities.statuses(&projects);
        assert!(!statuses[0].has_override);
        assert!(statuses[0].is_repo);
        // With the override cleared the resolved identity falls back to the
        // machine's global config — do NOT assert its value (machine-dependent);
        // only assert has_override flipped and profile_id no longer matches "work"
        // via the override path (it may match global if the dev's git identity
        // happens to equal the profile — acceptable, so assert only has_override).
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn set_identity_global_clears_and_unknown_profiles_error() {
        let dir = temp_dir("set");
        let root = seeded_repo(&dir, "repo");
        let identities = GitIdentities::at(&dir);
        identities
            .save_profile(&test_profile("work"), None)
            .unwrap();

        let result = identities.set_identity(&root, "work");
        assert!(result.ok, "{:?}", result.error);
        assert!(repo_local(&root).get_string("user.email").is_ok());

        let result = identities.set_identity(&root, "global");
        assert!(result.ok, "{:?}", result.error);
        assert!(repo_local(&root).get_string("user.email").is_err());

        let result = identities.set_identity(&root, "nope");
        assert!(!result.ok);
        assert!(result.error.unwrap().contains("unknown identity"));

        // Not-a-repo path errors politely.
        let empty = dir.join("not-a-repo");
        fs::create_dir_all(&empty).unwrap();
        let result = identities.set_identity(&empty, "work");
        assert!(!result.ok);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Port of tide's current-identity test: after applying a profile the
    /// resolved identity matches it; after clearing the override the fields
    /// fall back to the machine's global config and no profile matches. The
    /// global half is read as a baseline instead of asserted — libgit2's
    /// config search paths are process-global state no test should pin.
    #[test]
    fn current_identity_matches_profile_then_falls_back_to_global() {
        let dir = temp_dir("current");
        let root = seeded_repo(&dir, "repo");
        let identities = GitIdentities::at(&dir);
        let profile = identities
            .save_profile(&test_profile("work"), None)
            .unwrap();

        // Baseline: whatever the machine's global config resolves to.
        let global = identities.current_identity(&root);

        // After applying the profile: the local override wins and the pair
        // resolves back to the profile id.
        apply_profile_config(&Repository::open(&root).unwrap(), &profile).unwrap();
        let current = identities.current_identity(&root);
        assert_eq!(current.name.as_deref(), Some("Ada"));
        assert_eq!(current.email.as_deref(), Some("ada@example.com"));
        assert_eq!(current.profile_id.as_deref(), Some("work"));

        // After clearing: the resolved fields return to the global baseline
        // and — unless the developer's own git identity happens to equal the
        // test profile — no profile matches anymore.
        clear_profile_config(&Repository::open(&root).unwrap()).unwrap();
        let cleared = identities.current_identity(&root);
        assert_eq!(cleared, global);
        if (global.name.as_deref(), global.email.as_deref())
            != (Some("Ada"), Some("ada@example.com"))
        {
            assert_eq!(cleared.profile_id, None);
        }

        // Not-a-repo paths answer the empty identity, not an error.
        let empty = dir.join("not-a-repo");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            identities.current_identity(&empty),
            PanelCurrentIdentity::default()
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parse_git_credentials_dedupes_and_drops_tokens() {
        let creds = parse_git_credentials(
            "https://ada:ghp_secret@github.com\n\
             https://ada:ghp_other@github.com\n\
             https://bob@gitlab.com/org/repo.git\n\
             not-a-url\n\
             https://tokenonly@host.example\n",
        );
        assert_eq!(
            creds,
            vec![
                GitDiscoveredCredentialWire {
                    host: "github.com".into(),
                    username: "ada".into()
                },
                GitDiscoveredCredentialWire {
                    host: "gitlab.com".into(),
                    username: "bob".into()
                },
                GitDiscoveredCredentialWire {
                    host: "host.example".into(),
                    username: "tokenonly".into()
                },
            ]
        );
    }

    #[test]
    fn device_flow_parsing_covers_every_reply() {
        let start = parse_device_start(&serde_json::json!({
            "device_code": "dc", "user_code": "AB12-CD34",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900, "interval": 5
        }))
        .unwrap();
        assert_eq!(start.user_code, "AB12-CD34");
        assert_eq!(start.interval, 5);

        assert_eq!(
            parse_token_reply(&serde_json::json!({"error": "authorization_pending"})),
            TokenReply::Pending
        );
        assert_eq!(
            parse_token_reply(&serde_json::json!({"error": "slow_down"})),
            TokenReply::SlowDown
        );
        assert_eq!(
            parse_token_reply(&serde_json::json!({"error": "access_denied"})),
            TokenReply::Denied
        );
        assert_eq!(
            parse_token_reply(&serde_json::json!({"error": "expired_token"})),
            TokenReply::Expired
        );
        assert_eq!(
            parse_token_reply(&serde_json::json!({"access_token": "gho_x"})),
            TokenReply::Token("gho_x".into())
        );
        assert!(matches!(
            parse_token_reply(&serde_json::json!({"error": "unsupported_grant_type"})),
            TokenReply::Other(_)
        ));

        let (login, avatar, id) = parse_github_user(&serde_json::json!({
            "login": "octocat", "id": 583231, "avatar_url": "https://a"
        }))
        .unwrap();
        assert_eq!(login, "octocat");
        assert_eq!(avatar.as_deref(), Some("https://a"));
        assert_eq!(id.as_deref(), Some("583231"));
    }

    #[test]
    fn persist_github_account_stores_card_and_token_hermetically() {
        let dir = temp_dir("persist");
        let identities = GitIdentities::at(&dir);
        identities
            .persist_github_account_with(
                "octocat",
                Some("https://a".into()),
                Some("583231".into()),
                "gho_token",
                &b64_encrypt,
            )
            .unwrap();
        let accounts = store::git_identities::list_github_accounts(&dir);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].login, "octocat");
        assert_eq!(accounts[0].account_id.as_deref(), Some("583231"));
        // Round-trips through the seam; never plaintext in config.json.
        let config_text = fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(!config_text.contains("gho_token"));
        assert_eq!(
            identities
                .stored_token("github:octocat")
                .unwrap()
                .as_deref(),
            Some("gho_token")
        );

        // Disconnect removes exactly that account card and secret; other
        // accounts survive with their tokens intact.
        identities
            .persist_github_account_with(
                "torvalds",
                None,
                Some("1024025".into()),
                "gho_other",
                &b64_encrypt,
            )
            .unwrap();
        identities.github_disconnect("octocat").unwrap();
        let accounts = store::git_identities::list_github_accounts(&dir);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].login, "torvalds");
        assert_eq!(identities.stored_token("github:octocat").unwrap(), None);
        assert_eq!(
            identities
                .stored_token("github:torvalds")
                .unwrap()
                .as_deref(),
            Some("gho_other")
        );
        // Idempotent: a second disconnect of a missing account is a no-op.
        identities.github_disconnect("octocat").unwrap();
        assert_eq!(store::git_identities::list_github_accounts(&dir).len(), 1);
        identities.github_disconnect("torvalds").unwrap();
        assert!(store::git_identities::list_github_accounts(&dir).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parse_gh_auth_status_covers_single_multi_and_logged_out() {
        let single = "github.com\n  ✓ Logged in to github.com account yodeput (keyring)\n  - Active account: true\n  - Token: gho_****\n";
        assert_eq!(
            parse_gh_auth_status(single),
            vec![GhAccount {
                login: "yodeput".into(),
                active: true
            }]
        );

        let lone = "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token scopes: 'repo'\n";
        assert_eq!(
            parse_gh_auth_status(lone),
            vec![GhAccount {
                login: "octocat".into(),
                active: true
            }]
        );

        let multi = "github.com\n  ✓ Logged in to github.com account yodeput (keyring)\n  - Active account: true\n  - Token: gho_****\n  ✓ Logged in to github.com account yodeput-work (keyring)\n  - Active account: false\n  - Token: gho_****\n";
        assert_eq!(
            parse_gh_auth_status(multi),
            vec![
                GhAccount {
                    login: "yodeput".into(),
                    active: true
                },
                GhAccount {
                    login: "yodeput-work".into(),
                    active: false
                },
            ]
        );

        assert!(parse_gh_auth_status("You are not logged into any GitHub hosts.").is_empty());
        let failed = "github.com\n  ✗ Logged in to github.com account bad (keyring)\n  - The token in keyring is invalid\n";
        assert!(parse_gh_auth_status(failed).is_empty());
    }

    fn git_identities_create_for_test(
        dir: &Path,
        profile: &GitIdentityProfile,
    ) -> GitIdentityProfile {
        store::git_identities::create_profile(dir, profile).unwrap()
    }
}
