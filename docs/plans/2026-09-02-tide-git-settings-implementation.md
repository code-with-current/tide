# Tide Git Settings Port — Detailed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port Tide's Git settings screen to Waku — GitHub accounts (device-flow OAuth + gh CLI), per-project commit identity profiles (applied as repo-local git config), commit attribution settings, and per-project identity status — and extend attribution to Waku's own panel commits.

**Architecture:** Three layers following the existing Tide-providers pattern: a daemon-owned service module `crates/waku-core/src/git_identities.rs` (port of `/Volumes/512gb/TestAi/tide/src-tauri/src/commands/git_identities.rs`), new `Command`/`ResponsePayload` variants in `waku-protocol`, and a `SettingsPage::Git` UI backed by a `GitSettingsPanel` in `src/app/git_settings.rs` (port of `/Volumes/512gb/TestAi/tide/src/components/screens/settings/git.tsx`). Storage already exists in `tide-store` (`git_identities.rs`, `config.rs`, `secrets.rs`).

**Tech Stack:** Rust, GPUI, git2 (libgit2), reqwest blocking, serde, tide-store config/secrets.

**Upstream sources (read these, do not work from memory):**
- `tide/src/components/screens/settings/git.tsx` — the UI being ported (1020 lines)
- `tide/src-tauri/src/commands/git_identities.rs` — the backend being ported (1237 lines incl. tests)
- `tide/src/components/right-panel/git/git-panel.tsx` — reference only (identity apply UX)
- Waku precedents: `crates/waku-core/src/tide_providers.rs`, `src/app/tide_providers.rs`, `src/app/runtime.rs:3737` (`tide_dispatch`), `src/app/runtime.rs:4145` (`drain_tide_ops_events`), `src/app/settings.rs` (page registration), `crates/waku-core/src/git_commit.rs`

**Design doc:** [2026-08-31-tide-git-settings-design.md](2026-08-31-tide-git-settings-design.md) — decisions: full port; identity apply lives in the settings Workspaces rows; panel commits are attributed too; workspaces = waku projects from `app.db`; Tide's OAuth client ID with `TIDE_GITHUB_CLIENT_ID` override.

**Conventions:**
- The dev watcher (`bun ./scripts/dev.ts`) owns `Waku Debug.app` — never run `scripts/bundle.sh debug`, never quit/relaunch manually. Wait for its rebuild before visual checks.
- Test runner: `cargo test -p <crate> <test_name>`. Server/socket tests flake while the watcher daemon is live; crate-unit tests here are safe.
- Commit after every task (or sub-step where marked). Style: `feat(git): …`, `test(git): …`, `refactor(git): …` — see `docs/commit-messages.md`.
- `TIDE_DATA_DIR` env var redirects tide's data dir; tests that touch it must serialize (lock pattern shown in Task 11).

---

## Task 1: Wire types (`waku-protocol/src/git_settings.rs`)

**Files:**
- Create: `crates/waku-protocol/src/git_settings.rs`
- Modify: `crates/waku-protocol/src/lib.rs:35` (add `pub mod git_settings;` next to `pub mod git;`)

**Step 1: Write the failing test**

Append to the new file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_round_trips_through_json() {
        let snapshot = GitSnapshotWire {
            profiles: vec![GitProfileWire {
                id: "work".into(),
                name: Some("Work laptop".into()),
                user_name: "Ada".into(),
                user_email: "ada@example.com".into(),
                auth_type: "ssh".into(),
                ssh_key: Some("~/.ssh/id_ed25519".into()),
                host: None,
                github_login: None,
                sign_commits: false,
                signing_key: None,
                color: "keyword".into(),
                icon: "branch".into(),
                source: "manual".into(),
            }],
            accounts: Vec::new(),
            gh_cli: GhCliStatusWire { installed: false, accounts: Vec::new() },
            statuses: Vec::new(),
            attribution: GitAttributionWire {
                co_authored: true,
                name: "Tide".into(),
                email: "314188112+tide-codes@users.noreply.github.com".into(),
                mode: "author".into(),
            },
            global: GitGlobalIdentityWire { name: None, email: None, ssh_command: None },
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"userEmail\""), "{json}");
        assert!(json.contains("\"coAuthored\""), "{json}");
        let back: GitSnapshotWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back.profiles[0].id, "work");
    }
}
```

**Step 2: Run — verify it fails**

Run: `cargo test -p waku-protocol git_settings`
Expected: FAIL (module/types not defined — the test won't compile, which counts).

**Step 3: Implement the module**

`crates/waku-protocol/src/git_settings.rs`:

```rust
//! Wire shapes for Git identity management — the settings-screen half of
//! tide's git-identities feature. Mirrors the wire structs in tide's
//! `commands/git_identities.rs`; tokens never cross the wire.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// One commit identity profile, mirroring
/// `tide_store::git_identities::GitIdentityProfile` without the storage
/// defaults (the service fills those before sending).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitProfileWire {
    pub id: String,
    pub name: Option<String>,
    pub user_name: String,
    pub user_email: String,
    /// `"ssh"` | `"token"`.
    pub auth_type: String,
    pub ssh_key: Option<String>,
    pub host: Option<String>,
    pub github_login: Option<String>,
    pub sign_commits: bool,
    pub signing_key: Option<String>,
    /// Theme token for the UI dot.
    pub color: String,
    /// Icon name for the UI tile.
    pub icon: String,
    /// `"manual"` | `"github"`.
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccountWire {
    pub id: String,
    pub login: String,
    pub avatar_url: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GhCliAccountWire {
    pub login: String,
    pub active: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GhCliStatusWire {
    pub installed: bool,
    pub accounts: Vec<GhCliAccountWire>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitGlobalIdentityWire {
    pub name: Option<String>,
    pub email: Option<String>,
    pub ssh_command: Option<String>,
}

/// Identity state for one waku project, mirroring tide's
/// `GitWorkspaceIdentityStatusWire` with the workspace swapped for a project.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitProjectStatusWire {
    pub project_id: Uuid,
    pub name: String,
    pub path: String,
    pub is_repo: bool,
    pub has_override: bool,
    pub identity_name: Option<String>,
    pub identity_email: Option<String>,
    pub profile_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitAttributionWire {
    pub co_authored: bool,
    pub name: String,
    pub email: String,
    /// `"co-author"` | `"author"`.
    pub mode: String,
}

/// The whole Git settings screen in one payload: every mutation returns a
/// fresh snapshot, so the UI refreshes with one round-trip and never probes
/// per row.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshotWire {
    pub profiles: Vec<GitProfileWire>,
    pub accounts: Vec<GithubAccountWire>,
    pub gh_cli: GhCliStatusWire,
    pub statuses: Vec<GitProjectStatusWire>,
    pub attribution: GitAttributionWire,
    pub global: GitGlobalIdentityWire,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResultWire {
    pub ok: bool,
    pub error: Option<String>,
}

impl GitOpResultWire {
    pub fn err(message: impl Into<String>) -> Self {
        Self { ok: false, error: Some(message.into()) }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscoveredCredentialWire {
    pub host: String,
    pub username: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceStartWire {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectPollWire {
    /// `"pending"` | `"success"` | `"denied"` | `"expired"` | `"error"`.
    pub status: String,
    pub login: Option<String>,
    pub avatar_url: Option<String>,
    pub error: Option<String>,
}
```

Register in `crates/waku-protocol/src/lib.rs` after `pub mod git;`:

```rust
pub mod git_settings;
```

**Step 4: Run — verify it passes**

Run: `cargo test -p waku-protocol git_settings`
Expected: PASS (1 test). Then `cargo check -p waku-protocol` — clean.

**Step 5: Commit**

```bash
git add crates/waku-protocol/src/git_settings.rs crates/waku-protocol/src/lib.rs
git commit -m "feat(git): wire types for the tide git-identities surface"
```

---

## Task 2: Protocol commands and responses

**Files:**
- Modify: `crates/waku-protocol/src/protocol.rs` (Command enum after the `TideTestConnection` block ~line 186; ResponsePayload after `TideConnection` ~line 444; imports at top)

**Step 1: Add the Command variants**

In `protocol.rs`, add to the imports (line ~16 already imports from `crate::tide`; add):

```rust
use crate::git_settings::{
    GitDiscoveredCredentialWire, GithubConnectPollWire, GithubDeviceStartWire, GitOpResultWire,
    GitProfileWire, GitSnapshotWire,
};
```

Add to the `Command` enum after the `TideTestConnection` variant:

```rust
    /// ── Git identities (tide git-settings port) ─────────────────────
    /// The whole Git settings screen in one payload. The daemon supplies
    /// its own project list; clients refresh after every mutation.
    GitSnapshot,
    /// Create or update a profile (create when the id is new to the store,
    /// update when it exists). `token` is stored encrypted, never returned.
    GitIdentitySave {
        profile: GitProfileWire,
        token: Option<String>,
    },
    GitIdentityDelete {
        profile_id: String,
    },
    /// Apply a profile to the project at `project_path` as repo-local git
    /// config. `"global"` clears the override.
    GitSetIdentity {
        project_path: PathBuf,
        profile_id: String,
    },
    GitClearIdentity {
        project_path: PathBuf,
    },
    /// Per-key attribution update, mirroring tide's per-key settings merge.
    GitUpdateAttribution {
        git_co_authored: Option<bool>,
        git_attribution_mode: Option<String>,
    },
    GitDiscoverCredentials,
    GithubConnectStart,
    /// One poll of the GitHub device-flow token endpoint; the client owns
    /// the polling cadence.
    GithubConnectPoll {
        device_code: String,
    },
    GithubConnectFromGhCli {
        login: String,
    },
    GithubDisconnect {
        login: String,
    },
```

**Step 2: Add the ResponsePayload variants**

After `TideConnection { .. }` in `ResponsePayload`:

```rust
    GitSnapshot {
        snapshot: GitSnapshotWire,
    },
    GitOp {
        result: GitOpResultWire,
    },
    GithubDeviceStart {
        start: GithubDeviceStartWire,
    },
    GithubConnectPoll {
        poll: GithubConnectPollWire,
    },
    GitCredentials {
        items: Vec<GitDiscoveredCredentialWire>,
    },
```

**Step 3: Fix exhaustive matches (compiler-guided)**

Run: `cargo check -p waku-protocol -p waku-core -p waku-client`
Expected: errors pointing at every exhaustive `match` over `Command`/`ResponsePayload` (daemon arms, any client dispatch, possibly the list at `crates/waku-core/src/daemon.rs:1636`). For now, add unreachable-style arms only where the compiler demands (e.g. `_ => {}` is NOT acceptable in the daemon request handler — that gets real arms in Task 9; temporary `todo!()` arms are fine within this task since nothing invokes them yet, but Task 9 must replace them). Prefer: implement the daemon arms immediately after in Task 9 before running the app.

`PROTOCOL_VERSION` stays at 6: the daemon and app ship from one build (repo history has never bumped it for additive variants).

**Step 4: Run protocol tests + commit**

Run: `cargo test -p waku-protocol`
Expected: PASS.

```bash
git add crates/waku-protocol/src/protocol.rs
git commit -m "feat(git): daemon commands for git identities, attribution, github connect"
```

---

## Task 3: Service — identity apply/clear via repo-local config

**Files:**
- Create: `crates/waku-core/src/git_identities.rs`
- Modify: `crates/waku-core/src/lib.rs` (register `pub mod git_identities;`)

This and Tasks 4–9 port `tide/src-tauri/src/commands/git_identities.rs` function-for-function. Keep the upstream doc comments — they explain the invariants.

**Step 1: Write the failing tests (ported from upstream `apply_writes_local_only_and_clear_unsets`, `apply_signing_only_when_enabled`)**

Create `crates/waku-core/src/git_identities.rs` with ONLY the test module plus empty stubs, then make it compile:

```rust
//! Git identities + GitHub accounts — port of tide's
//! `src-tauri/src/commands/git_identities.rs` on waku's daemon. Profiles
//! live in git-identities.json (tide-store), tokens in config.json's
//! encrypted secrets map, application writes repo-local git config via
//! git2 (never --global). `git_set_identity` with the id `"global"` clears
//! the local override.

use std::path::{Path, PathBuf};

use git2::{ConfigLevel, Repository};
use waku_protocol::git_settings::{
    GhCliAccountWire, GhCliStatusWire, GitGlobalIdentityWire, GitProfileWire,
};

use tide_store::git_identities::{self, GitIdentityProfile};

/// Directory handle for the identities file + secrets-bearing config. Tests
/// construct `at()` with a scratch dir; production uses tide's data dir.
#[derive(Clone)]
pub struct GitIdentities {
    data_dir: PathBuf,
}

impl GitIdentities {
    pub fn shared() -> Self {
        Self { data_dir: tide_store::paths::data_dir() }
    }

    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { data_dir: dir.into() }
    }
}
```

Test module (verbatim port of the two upstream apply tests — upstream lines 1040-1087):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use git2::RepositoryInitOptions;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("waku-gitids-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seeded_repo(dir: &Path, name: &str) -> PathBuf {
        let root = dir.join(name);
        fs::create_dir_all(&root).unwrap();
        Repository::init_opts(&root, RepositoryInitOptions::new().initial_head("main")).unwrap();
        root
    }

    fn repo_local(root: &Path) -> git2::Config {
        Repository::open(root).unwrap().config().unwrap().open_level(ConfigLevel::Local).unwrap()
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
        let identities = GitIdentities::at(&dir);
        let profile = identities.create_profile(&test_profile("work")).unwrap();

        let repo = Repository::open(&root).unwrap();
        apply_profile_config(&repo, &profile).unwrap();
        let cfg = repo_local(&root);
        assert_eq!(cfg.get_string("user.name").unwrap(), "Ada");
        assert_eq!(cfg.get_string("user.email").unwrap(), "ada@example.com");
        assert_eq!(cfg.get_string("core.sshCommand").unwrap(), "ssh -i '/keys/id_ed25519'");

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
        let identities = GitIdentities::at(&dir);
        let mut profile = test_profile("work");
        profile.ssh_key = None;
        profile.sign_commits = true;
        profile.signing_key = Some("ABC123".into());
        let profile = identities.create_profile(&profile).unwrap();

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
}
```

Add stubs so it compiles and the tests fail on behavior:

```rust
/// The keys an identity application owns; clear = unset exactly these.
const LOCAL_IDENTITY_KEYS: [&str; 5] =
    ["user.name", "user.email", "core.sshCommand", "commit.gpgsign", "user.signingkey"];

fn apply_profile_config(_repo: &Repository, _profile: &GitIdentityProfile) -> Result<(), String> {
    unimplemented!()
}

fn clear_profile_config(_repo: &Repository) -> Result<(), String> {
    unimplemented!()
}
```

**Step 2: Run — verify failure**

Run: `cargo test -p waku-core git_identities`
Expected: FAIL (panic `not implemented`).

**Step 3: Implement (verbatim upstream lines 185–243)**

```rust
fn local_config(repo: &Repository) -> Result<git2::Config, String> {
    repo.config()
        .and_then(|cfg| cfg.open_level(ConfigLevel::Local))
        .map_err(|e| format!("cannot open local git config: {e}"))
}

fn set_local(cfg: &mut git2::Config, key: &str, value: &str) -> Result<(), String> {
    cfg.set_str(key, value).map_err(|e| format!("git config {key}: {e}"))
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
                git_identities::escape_ssh_key_path(key).map_err(|e| e.to_string())?
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
```

**Step 4: Run — verify pass, then commit**

Run: `cargo test -p waku-core git_identities`
Expected: PASS (2 tests).

```bash
git add crates/waku-core/src/git_identities.rs crates/waku-core/src/lib.rs
git commit -m "feat(git): repo-local identity apply/clear via git2 — port of tide git_identities"
```

---

## Task 4: Service — CRUD + encrypted token storage

**Files:**
- Modify: `crates/waku-core/src/git_identities.rs`

**Step 1: Write the failing test (ports upstream `persist_github_account_stores_card_and_encrypted_token` shape for tokens)**

```rust
    #[test]
    fn identity_save_stores_profile_and_encrypted_token() {
        let dir = temp_dir("crud");
        let identities = GitIdentities::at(&dir);
        let mut profile = test_profile("tok");
        profile.auth_type = "token".into();
        profile.ssh_key = None;
        profile.host = Some("github.com".into());
        identities.save_profile(&profile, Some("ghp_secret".into())).unwrap();

        let stored = identities.profile("tok").unwrap();
        assert_eq!(stored.auth_type, "token");
        // The token round-trips through the encrypted secrets map and never
        // appears in git-identities.json.
        let identities_text = fs::read_to_string(dir.join("git-identities.json")).unwrap();
        assert!(!identities_text.contains("ghp_secret"));
        assert_eq!(identities.stored_token("tok").unwrap().as_deref(), Some("ghp_secret"));

        // Delete removes profile and secret.
        identities.delete_profile("tok").unwrap();
        assert!(identities.profile("tok").is_none());
        assert_eq!(identities.stored_token("tok").unwrap(), None);
        fs::remove_dir_all(&dir).unwrap();
    }
```

**Step 2: Run — verify failure** (`cargo test -p waku-core git_identities` — compile error on missing methods counts.)

**Step 3: Implement**

Conversion helpers + CRUD + secrets. Secret name convention from upstream: manual token profiles use `gitIdentityToken:<id>`, github-backed use `github:<login>`.

```rust
impl GitIdentities {
    pub fn profiles(&self) -> Vec<GitIdentityProfile> {
        git_identities::get_profiles(&self.data_dir)
    }

    pub fn profile(&self, id: &str) -> Option<GitIdentityProfile> {
        git_identities::get_profile(&self.data_dir, id)
    }

    /// Create when the id is new, update when it exists — the settings
    /// dialog's single save path.
    pub fn save_profile(
        &self,
        input: &GitIdentityProfile,
        token: Option<String>,
    ) -> Result<GitIdentityProfile, String> {
        let existing = git_identities::get_profile(&self.data_dir, &input.id);
        let profile = match existing {
            Some(_) => git_identities::update_profile(&self.data_dir, input),
            None => git_identities::create_profile(&self.data_dir, input),
        }
        .map_err(|e| e.to_string())?;
        if let Some(token) = token.filter(|t| !t.trim().is_empty()) {
            if profile.auth_type == "token" {
                self.store_secret(&format!("gitIdentityToken:{}", profile.id), &token)?;
            }
        }
        Ok(profile)
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        // The OS credential helper's copy (if any) is deliberately left
        // alone — never purge credentials we didn't store ourselves.
        git_identities::delete_profile(&self.data_dir, id).map_err(|e| e.to_string())?;
        self.update_config(|cfg| {
            if let Some(map) = cfg.secrets.as_mut() {
                map.remove(&format!("gitIdentityToken:{id}"));
            }
            Ok(())
        })
    }

    pub fn stored_token(&self, name: &str) -> Result<Option<String>, String> {
        let cfg = self.load_config()?;
        let stored = cfg
            .secrets
            .as_ref()
            .and_then(|m| m.get(name))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        match stored {
            None => Ok(None),
            Some(stored) => {
                tide_store::secrets::decrypt_stored(&stored).map(Some).map_err(|e| e.to_string())
            }
        }
    }

    pub fn store_secret(&self, name: &str, token: &str) -> Result<(), String> {
        self.update_config(|cfg| {
            let encrypted = tide_store::secrets::encrypt_stored(token).map_err(|e| e.to_string())?;
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

    fn load_config(&self) -> Result<tide_store::config::Config, String> {
        tide_store::config::load(&self.data_dir.join("config.json"))
            .map_err(|e| e.to_string())
    }

    fn update_config(
        &self,
        mutate: impl FnOnce(&mut tide_store::config::Config) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut cfg = self.load_config()?;
        mutate(&mut cfg)?;
        tide_store::config::save(&self.data_dir.join("config.json"), &cfg).map_err(|e| e.to_string())
    }
}
```

Note: `tide_store::secrets` must be reachable — verify `pub mod secrets;` exists in `crates/tide-store/src/lib.rs` (it does). `decrypt_stored`/`encrypt_stored` signatures: check `crates/tide-store/src/secrets.rs` and adapt the call if they take/return different types.

**Step 4: Run + commit**

Run: `cargo test -p waku-core git_identities` — PASS (3 tests).

```bash
git add crates/waku-core/src/git_identities.rs
git commit -m "feat(git): identity profile CRUD with encrypted token secrets"
```

---

## Task 5: Service — set/clear on a project + credential approve + statuses

**Files:**
- Modify: `crates/waku-core/src/git_identities.rs`

**Step 1: Write the failing tests (ports upstream `current_identity_matches_profile_and_reports_override` adapted to project rows)**

```rust
    fn project(project_id: &str, path: &Path) -> waku_protocol::model::Project {
        waku_protocol::model::Project {
            id: uuid::Uuid::parse_str(project_id).unwrap(),
            name: project_id.into(),
            path: path.to_path_buf(),
            // fill remaining fields with Default if Project implements it,
            // otherwise set each field — check crates/waku-protocol/src/model.rs:613
            ..Default::default()
        }
    }

    #[test]
    fn statuses_resolve_override_and_profile_match() {
        let dir = temp_dir("statuses");
        let root = seeded_repo(&dir, "repo");
        let identities = GitIdentities::at(&dir);
        let profile = identities.create_profile(&test_profile("work")).unwrap();
        apply_profile_config(&Repository::open(&root).unwrap(), &profile).unwrap();

        let projects = vec![project(
            "00000000-0000-0000-0000-000000000001",
            &root,
        )];
        let statuses = identities.statuses(&projects);
        assert_eq!(statuses.len(), 1);
        assert!(statuses[0].is_repo);
        assert!(statuses[0].has_override);
        assert_eq!(statuses[0].profile_id.as_deref(), Some("work"));
        assert_eq!(statuses[0].identity_name.as_deref(), Some("Ada"));

        clear_profile_config(&Repository::open(&root).unwrap()).unwrap();
        let statuses = identities.statuses(&projects);
        assert!(!statuses[0].has_override);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn set_identity_global_clears_and_unknown_profiles_error() {
        let dir = temp_dir("set");
        let root = seeded_repo(&dir, "repo");
        let identities = GitIdentities::at(&dir);
        let profile = identities.create_profile(&test_profile("work")).unwrap();

        let result = identities.set_identity(&root, "work").unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert!(repo_local(&root).get_string("user.email").is_ok());

        let result = identities.set_identity(&root, "global").unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert!(repo_local(&root).get_string("user.email").is_err());

        let result = identities.set_identity(&root, "nope").unwrap();
        assert!(!result.ok);
        fs::remove_dir_all(&dir).unwrap();
    }
```

(If `Project` does not implement `Default`, construct every field explicitly — read `crates/waku-protocol/src/model.rs:613-640` first and adjust the helper.)

**Step 2: Run — verify failure.**

**Step 3: Implement (upstream lines 246–280, 409–463, 489–538 adapted)**

```rust
use std::io::Write as _;
use std::process::Stdio;

use waku_protocol::git_settings::{GitOpResultWire, GitProjectStatusWire};

/// `git credential approve` — feeds the token to the user's configured
/// helper(s). Best-effort: config application already succeeded, so a
/// missing git binary or failing helper logs instead of failing the apply.
fn credential_approve(workdir: &Path, host: &str, username: &str, token: &str) {
    let mut command = crate::command_env::command("git");
    command
        .args(["-c", "credential.interactive=false", "credential", "approve"])
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        eprintln!("[waku] credential approve skipped: git CLI unavailable");
        return;
    };
    let request = format!("url=https://{host}\nusername={username}\npassword={token}\n\n");
    if let Some(stdin) = child.stdin.as_mut() {
        if stdin.write_all(request.as_bytes()).is_err() {
            let _ = child.kill();
            return;
        }
    }
    match child.wait() {
        Ok(status) if status.success() => {}
        other => eprintln!("[waku] credential approve failed: {other:?}"),
    }
}

impl GitIdentities {
    pub fn set_identity(&self, root: &Path, profile_id: &str) -> GitOpResultWire {
        // Applying "Global" clears the override — the repo falls back to
        // the user's global config.
        if profile_id == "global" {
            return match Repository::open(root)
                .map_err(|e| e.message().to_owned())
                .and_then(|repo| clear_profile_config(&repo))
            {
                Ok(()) => GitOpResultWire { ok: true, error: None },
                Err(e) => GitOpResultWire::err(e),
            };
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
                    profile.github_login.as_deref().map(|login| format!("github:{login}"))
                } else {
                    Some(format!("gitIdentityToken:{}", profile.id))
                };
                if let Some(secret_name) = secret_name {
                    if let Ok(Some(token)) = self.stored_token(&secret_name) {
                        let username = profile.github_login.as_deref().unwrap_or(&profile.user_name);
                        credential_approve(root, host, username, &token);
                    } else {
                        eprintln!("[waku] identity {} has no stored token; helper not updated", profile.id);
                    }
                }
            }
        }
        GitOpResultWire { ok: true, error: None }
    }

    pub fn clear_identity(&self, root: &Path) -> GitOpResultWire {
        match Repository::open(root)
            .map_err(|e| e.message().to_owned())
            .and_then(|repo| clear_profile_config(&repo))
        {
            Ok(()) => GitOpResultWire { ok: true, error: None },
            Err(e) => GitOpResultWire::err(e),
        }
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
    pub fn statuses(&self, projects: &[waku_protocol::model::Project]) -> Vec<GitProjectStatusWire> {
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
}

fn global_config_string(key: &str) -> Option<String> {
    git2::Config::open_default().ok().and_then(|cfg| cfg.get_string(key).ok())
}
```

The upstream tests pinned a workspace's global fallback by chance of the developer's machine — do NOT assert on `identity_name` when no override exists (machine-dependent); only assert the override-present path as above.

**Step 4: Run + commit**

Run: `cargo test -p waku-core git_identities` — PASS (5 tests).

```bash
git add crates/waku-core/src/git_identities.rs
git commit -m "feat(git): apply/clear identity per project, credential approve, status rows"
```

---

## Task 6: Service — `~/.git-credentials` discovery

**Files:**
- Modify: `crates/waku-core/src/git_identities.rs`

**Step 1: Write the failing test (verbatim upstream `parse_git_credentials_dedupes_and_drops_tokens`, lines 1128–1145)**

```rust
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
                GitDiscoveredCredentialWire { host: "github.com".into(), username: "ada".into() },
                GitDiscoveredCredentialWire { host: "gitlab.com".into(), username: "bob".into() },
                GitDiscoveredCredentialWire { host: "host.example".into(), username: "tokenonly".into() },
            ]
        );
    }
```

**Step 2: Run — verify failure.**

**Step 3: Implement (verbatim upstream lines 545–590)**

```rust
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
        let Some(after_scheme) = line.strip_prefix("https://").or(line.strip_prefix("http://"))
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
            out.push(GitDiscoveredCredentialWire { host: host.into(), username: username.into() });
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
```

**Step 4: Run + commit**

Run: `cargo test -p waku-core git_identities` — PASS (6 tests).

```bash
git add crates/waku-core/src/git_identities.rs
git commit -m "feat(git): ~/.git-credentials discovery parser"
```

---

## Task 7: Service — GitHub device flow

**Files:**
- Modify: `crates/waku-core/src/git_identities.rs`

**Step 1: Write the failing tests (verbatim upstream `device_flow_parsing_covers_every_reply`, lines 1176–1205, and `persist_github_account_stores_card_and_encrypted_token`, lines 1207–1236 — the latter already partially covered in Task 4's shape; port it for the account path with a plain-encrypt seam)**

```rust
    #[test]
    fn device_flow_parsing_covers_every_reply() {
        let start = parse_device_start(&serde_json::json!({
            "device_code": "dc", "user_code": "AB12-CD34",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900, "interval": 5
        }))
        .unwrap();
        assert_eq!(start.user_code, "AB12-CD34");

        assert_eq!(parse_token_reply(&serde_json::json!({"error": "authorization_pending"})), TokenReply::Pending);
        assert_eq!(parse_token_reply(&serde_json::json!({"error": "slow_down"})), TokenReply::SlowDown);
        assert_eq!(parse_token_reply(&serde_json::json!({"error": "access_denied"})), TokenReply::Denied);
        assert_eq!(parse_token_reply(&serde_json::json!({"error": "expired_token"})), TokenReply::Expired);
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
    fn persist_github_account_stores_card_and_token() {
        let dir = temp_dir("persist");
        let identities = GitIdentities::at(&dir);
        identities.persist_github_account(
            "octocat",
            Some("https://a".into()),
            Some("583231".into()),
            "gho_token",
        ).unwrap();
        let accounts = identities.github_accounts();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].login, "octocat");
        assert_eq!(
            identities.stored_token("github:octocat").unwrap().as_deref(),
            Some("gho_token")
        );
        fs::remove_dir_all(&dir).unwrap();
    }
```

**Step 2: Run — verify failure.**

**Step 3: Implement (upstream lines 594–790; pure halves verbatim, HTTP on reqwest blocking)**

```rust
use serde_json::Value;

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
        user_code: value.get("user_code").and_then(Value::as_str).unwrap_or_default().into(),
        verification_uri: value
            .get("verification_uri")
            .and_then(Value::as_str)
            .unwrap_or("https://github.com/login/device")
            .into(),
        expires_in: value.get("expires_in").and_then(Value::as_u64).unwrap_or(900),
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
        value.get("avatar_url").and_then(Value::as_str).map(str::to_owned),
        value.get("id").and_then(Value::as_i64).map(|id| id.to_string()),
    ))
}

fn http_client() -> anyhow::Result<reqwest::blocking::Client> {
    // Same builder as crates/waku-core/src/tide_providers.rs:265
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| anyhow::anyhow!("could not build an HTTP client: {error}"))
}

fn post_form_json(url: &str, form: &[(&str, String)]) -> anyhow::Result<Value> {
    let resp = http_client()?
        .post(url)
        .header("Accept", "application/json")
        .header("User-Agent", "tide")
        .form(form)
        .send()
        .and_then(|resp| resp.error_for_status())
        .map_err(|e| anyhow::anyhow!("github request failed: {e}"))?;
    resp.json::<Value>().await_free() // see note below — blocking, so plain .json()
}
```

Note: `reqwest::blocking` — `resp.json()` is a plain call, write it as `resp.json::<Value>().map_err(...)`. Match the exact style of `tide_providers.rs:329` (read that function first and copy its error mapping).

```rust
impl GitIdentities {
    pub fn github_accounts(&self) -> Vec<tide_store::git_identities::GitHubAccount> {
        git_identities::list_github_accounts(&self.data_dir)
    }

    pub fn persist_github_account(
        &self,
        login: &str,
        avatar_url: Option<String>,
        account_id: Option<String>,
        token: &str,
    ) -> Result<(), String> {
        let account = tide_store::git_identities::GitHubAccount {
            id: login.into(),
            login: login.into(),
            avatar_url,
            account_id,
        };
        git_identities::upsert_github_account(&self.data_dir, &account)
            .map_err(|e| e.to_string())?;
        self.store_secret(&format!("github:{login}"), token)
    }

    pub fn github_disconnect(&self, login: &str) -> Result<(), String> {
        git_identities::remove_github_account(&self.data_dir, login).map_err(|e| e.to_string())?;
        self.remove_secret(&format!("github:{login}"))
    }

    pub fn github_connect_start(&self) -> anyhow::Result<DeviceStart> {
        let form = [("client_id", client_id()), ("scope", GITHUB_SCOPE.into())];
        let reply = post_form_json(DEVICE_CODE_URL, &form)?;
        parse_device_start(&reply).map_err(anyhow::Error::from)
    }

    pub fn github_connect_poll(&self, device_code: &str) -> anyhow::Result<GithubConnectPollWire> {
        let form = [
            ("client_id", client_id()),
            ("device_code", device_code.to_owned()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code".into()),
        ];
        let reply = post_form_json(TOKEN_URL, &form)?;
        Ok(match parse_token_reply(&reply) {
            TokenReply::Pending | TokenReply::SlowDown => pending(),
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
                self.persist_github_account(&login, avatar_url.clone(), account_id, &token)?;
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
            return Ok(GithubConnectPollWire::err(format!(
                "gh auth token failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let token = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if token.is_empty() {
            return Ok(GithubConnectPollWire::err("gh auth token returned no token"));
        }
        let user = github_user(&token)?;
        let Some((login, avatar_url, account_id)) = parse_github_user(&user) else {
            anyhow::bail!("github user reply missing login");
        };
        self.persist_github_account(&login, avatar_url.clone(), account_id, &token)?;
        Ok(GithubConnectPollWire {
            status: "success".into(),
            login: Some(login),
            avatar_url,
            error: None,
        })
    }
}

fn pending() -> GithubConnectPollWire {
    GithubConnectPollWire { status: "pending".into(), login: None, avatar_url: None, error: None }
}

fn github_user(token: &str) -> anyhow::Result<Value> {
    let resp = http_client()?
        .get(GITHUB_USER_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "tide")
        .send()
        .and_then(|resp| resp.error_for_status())
        .map_err(|e| anyhow::anyhow!("github user lookup failed: {e}"))?;
    resp.json::<Value>()
        .map_err(|e| anyhow::anyhow!("github user reply was not json: {e}"))
}
```

**Step 4: Run + commit**

Run: `cargo test -p waku-core git_identities` — PASS (8 tests).

```bash
git add crates/waku-core/src/git_identities.rs
git commit -m "feat(git): github device flow, gh-cli connect, account persistence"
```

---

## Task 8: Service — gh CLI detection + snapshot assembler

**Files:**
- Modify: `crates/waku-core/src/git_identities.rs`

**Step 1: Write the failing test (verbatim upstream `parse_gh_auth_status_covers_single_multi_and_logged_out`, lines 1148–1174)**

```rust
    #[test]
    fn parse_gh_auth_status_covers_single_multi_and_logged_out() {
        let single = "github.com\n  ✓ Logged in to github.com account yodeput (keyring)\n  - Active account: true\n  - Token: gho_****\n";
        assert_eq!(
            parse_gh_auth_status(single),
            vec![GhAccount { login: "yodeput".into(), active: true }]
        );

        let lone = "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token scopes: 'repo'\n";
        assert_eq!(
            parse_gh_auth_status(lone),
            vec![GhAccount { login: "octocat".into(), active: true }]
        );

        let multi = "github.com\n  ✓ Logged in to github.com account yodeput (keyring)\n  - Active account: true\n  - Token: gho_****\n  ✓ Logged in to github.com account yodeput-work (keyring)\n  - Active account: false\n  - Token: gho_****\n";
        assert_eq!(
            parse_gh_auth_status(multi),
            vec![
                GhAccount { login: "yodeput".into(), active: true },
                GhAccount { login: "yodeput-work".into(), active: false },
            ]
        );

        assert!(parse_gh_auth_status("You are not logged into any GitHub hosts.").is_empty());
        let failed = "github.com\n  ✗ Logged in to github.com account bad (keyring)\n  - The token in keyring is invalid\n";
        assert!(parse_gh_auth_status(failed).is_empty());
    }
```

**Step 2: Run — verify failure.**

**Step 3: Implement (upstream lines 793–876 verbatim + snapshot)**

```rust
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
                    accounts.push(GhAccount { login: login.into(), active: false });
                }
            }
        } else if let Some(rest) = line.strip_prefix("- Active account:") {
            if rest.trim() == "true" {
                if let Some(index) = current {
                    accounts[index].active = true;
                }
            }
        } else if line.starts_with('✗') {
            current = None;
        }
    }
    if accounts.len() == 1 && !accounts[0].active {
        accounts[0].active = true;
    }
    accounts
}

pub fn gh_cli_status() -> GhCliStatusWire {
    let output = crate::command_env::command("gh")
        .args(["auth", "status", "--hostname", "github.com"])
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .output();
    match output {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push('\n');
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            GhCliStatusWire {
                installed: true,
                accounts: parse_gh_auth_status(&text)
                    .into_iter()
                    .map(|a| GhCliAccountWire { login: a.login, active: a.active })
                    .collect(),
            }
        }
        Err(_) => GhCliStatusWire { installed: false, accounts: Vec::new() },
    }
}

/// Everything the settings screen renders, in one payload.
pub fn git_snapshot(projects: &[waku_protocol::model::Project]) -> GitSnapshotWire {
    let identities = GitIdentities::shared();
    let general = tide_store::config::load(&tide_store::paths::config_path())
        .ok()
        .and_then(|cfg| cfg.general_settings.map(|g| g.effective()))
        .unwrap_or_default();
    let wire_profile = |p: &GitIdentityProfile| GitProfileWire {
        id: p.id.clone(),
        name: p.name.clone(),
        user_name: p.user_name.clone(),
        user_email: p.user_email.clone(),
        auth_type: p.auth_type.clone(),
        ssh_key: p.ssh_key.clone(),
        host: p.host.clone(),
        github_login: p.github_login.clone(),
        sign_commits: p.sign_commits,
        signing_key: p.signing_key.clone(),
        color: p.color.clone(),
        icon: p.icon.clone(),
        source: p.source.clone(),
    };
    let wire_account = |a: &tide_store::git_identities::GitHubAccount| GithubAccountWire {
        id: a.id.clone(),
        login: a.login.clone(),
        avatar_url: a.avatar_url.clone(),
        account_id: a.account_id.clone(),
    };
    GitSnapshotWire {
        profiles: identities.profiles().iter().map(wire_profile).collect(),
        accounts: identities.github_accounts().iter().map(wire_account).collect(),
        gh_cli: gh_cli_status(),
        statuses: identities.statuses(projects),
        attribution: GitAttributionWire {
            co_authored: general.git_co_authored,
            name: general.git_co_author_name.clone(),
            email: general.git_co_author_email.clone(),
            mode: general.git_attribution_mode.clone(),
        },
        global: identities.global_identity(),
    }
}

/// Per-key attribution update, mirroring tide's per-key settings merge:
/// absent keys keep their stored value, present keys overwrite.
pub fn update_attribution(
    git_co_authored: Option<bool>,
    git_attribution_mode: Option<String>,
) -> Result<(), String> {
    let path = tide_store::paths::config_path();
    let mut cfg = tide_store::config::load(&path).map_err(|e| e.to_string())?;
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
    tide_store::config::save(&path, &cfg).map_err(|e| e.to_string())
}
```

Check `EffectiveGeneralSettings` implements `Default` (it does — `crates/tide-store/src/config.rs:167`).

**Step 4: Run + commit**

Run: `cargo test -p waku-core git_identities` — PASS (9 tests).

```bash
git add crates/waku-core/src/git_identities.rs
git commit -m "feat(git): gh cli detection and the settings snapshot assembler"
```

---

## Task 9: Daemon arms

**Files:**
- Modify: `crates/waku-core/src/daemon.rs` (the `handle_request` match, after the `TideTestConnection` arm ~line 296; and the exhaustive command list at ~line 1636)

**Step 1: Implement the arms**

These follow the `TideProviders` arm pattern — synchronous in the request handler, which already runs off the UI thread (client threads block on `daemon.request`; see `tide_dispatch` in `src/app/runtime.rs:3737`):

```rust
            Command::GitSnapshot => {
                let projects = self.task_state.lock().projects.clone();
                Ok(ResponsePayload::GitSnapshot {
                    snapshot: crate::git_identities::git_snapshot(&projects),
                })
            }
            Command::GitIdentitySave { profile, token } => {
                let identities = crate::git_identities::GitIdentities::shared();
                let stored = tide_store::git_identities::GitIdentityProfile {
                    id: profile.id,
                    name: profile.name,
                    user_name: profile.user_name,
                    user_email: profile.user_email,
                    auth_type: profile.auth_type,
                    ssh_key: profile.ssh_key,
                    host: profile.host,
                    github_login: profile.github_login,
                    sign_commits: profile.sign_commits,
                    signing_key: profile.signing_key,
                    color: profile.color,
                    icon: profile.icon,
                    source: profile.source,
                };
                let result = identities
                    .save_profile(&stored, token)
                    .map(|_| ())
                    .map_err(|error| GitOpResultWire::err(error));
                let projects = self.task_state.lock().projects.clone();
                match result {
                    Ok(()) => Ok(ResponsePayload::GitSnapshot {
                        snapshot: crate::git_identities::git_snapshot(&projects),
                    }),
                    Err(result) => Ok(ResponsePayload::GitOp { result }),
                }
            }
            Command::GitIdentityDelete { profile_id } => {
                let result = crate::git_identities::GitIdentities::shared()
                    .delete_profile(&profile_id)
                    .map(|_| GitOpResultWire { ok: true, error: None })
                    .unwrap_or_else(GitOpResultWire::err);
                let projects = self.task_state.lock().projects.clone();
                let _ = result; // snapshot refresh carries the outcome; surface errors in Task 13 wiring if needed
                Ok(ResponsePayload::GitSnapshot {
                    snapshot: crate::git_identities::git_snapshot(&projects),
                })
            }
            Command::GitSetIdentity { project_path, profile_id } => {
                let result =
                    crate::git_identities::GitIdentities::shared().set_identity(&project_path, &profile_id);
                let projects = self.task_state.lock().projects.clone();
                let _ = result;
                Ok(ResponsePayload::GitSnapshot {
                    snapshot: crate::git_identities::git_snapshot(&projects),
                })
            }
            Command::GitClearIdentity { project_path } => {
                let result =
                    crate::git_identities::GitIdentities::shared().clear_identity(&project_path);
                let projects = self.task_state.lock().projects.clone();
                let _ = result;
                Ok(ResponsePayload::GitSnapshot {
                    snapshot: crate::git_identities::git_snapshot(&projects),
                })
            }
            Command::GitUpdateAttribution { git_co_authored, git_attribution_mode } => {
                let result = crate::git_identities::update_attribution(
                    git_co_authored,
                    git_attribution_mode,
                );
                let projects = self.task_state.lock().projects.clone();
                match result {
                    Ok(()) => Ok(ResponsePayload::GitSnapshot {
                        snapshot: crate::git_identities::git_snapshot(&projects),
                    }),
                    Err(error) => Ok(ResponsePayload::GitOp {
                        result: GitOpResultWire::err(error),
                    }),
                }
            }
            Command::GitDiscoverCredentials => Ok(ResponsePayload::GitCredentials {
                items: crate::git_identities::discover_credentials(),
            }),
            Command::GithubConnectStart => {
                let start = crate::git_identities::GitIdentities::shared().github_connect_start()?;
                Ok(ResponsePayload::GithubDeviceStart {
                    start: GithubDeviceStartWire {
                        device_code: start.device_code,
                        user_code: start.user_code,
                        verification_uri: start.verification_uri,
                        expires_in: start.expires_in,
                        interval: start.interval,
                    },
                })
            }
            Command::GithubConnectPoll { device_code } => {
                let poll = crate::git_identities::GitIdentities::shared()
                    .github_connect_poll(&device_code)?;
                Ok(ResponsePayload::GithubConnectPoll { poll })
            }
            Command::GithubConnectFromGhCli { login } => {
                let poll = crate::git_identities::GitIdentities::shared()
                    .github_connect_from_gh_cli(&login)?;
                Ok(ResponsePayload::GithubConnectPoll { poll })
            }
            Command::GithubDisconnect { login } => {
                let _ = crate::git_identities::GitIdentities::shared().github_disconnect(&login);
                let projects = self.task_state.lock().projects.clone();
                Ok(ResponsePayload::GitSnapshot {
                    snapshot: crate::git_identities::git_snapshot(&projects),
                })
            }
```

Refinement while implementing: rather than discarding op results (`let _ = result`), carry failures into the snapshot response path by returning `ResponsePayload::GitOp { result }` when `!result.ok` for Set/Clear/Delete — the UI (Task 13) shows `result.error` as a toast-style row error. Pick ONE behavior and use it consistently; the straightforward option: on failure return `GitOp{result}`, on success return the fresh `GitSnapshot`. Adjust the code above accordingly.

Add the imports the arms need (`waku_protocol::git_settings::{GithubDeviceStartWire, GitOpResultWire}` and the wire types already imported at the top of daemon.rs from waku_protocol — check its existing import list).

Also update the exhaustive `Command` listing at `daemon.rs:1636` (compiler will point at it — add each new variant).

**Step 2: Build and test**

Run: `cargo check -p waku-core && cargo test -p waku-core`
Expected: clean build, all tests pass.

**Step 3: Commit**

```bash
git add crates/waku-core/src/daemon.rs
git commit -m "feat(git): daemon command arms for git identities"
```

---

## Task 10: Hoist the shared attribution read into tide-store

**Files:**
- Modify: `crates/tide-store/src/config.rs` (new public fn at the bottom of the "commit attribution" section, ~line 373)
- Modify: `crates/tide-tools/src/tools/git.rs:681` (`tide_attribution` delegates)

**Step 1: Write the failing test** (in `config.rs` tests — note it needs the env-dir lock pattern; copy `TIDE_DIR_LOCK` style from `tide-tools/src/tools/git.rs:895`)

```rust
    static ATTRIBUTION_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn current_attribution_reads_the_data_dir_config_fresh() {
        let _guard = ATTRIBUTION_ENV_LOCK.lock().unwrap();
        let scratch = std::env::temp_dir().join(format!("tide-attr-{}", std::process::id()));
        std::fs::create_dir_all(&scratch).unwrap();
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

        std::env::remove_var(crate::paths::DATA_DIR_ENV);
        std::fs::remove_dir_all(&scratch).unwrap();
    }
```

**Step 2: Run — verify failure** (`cargo test -p tide-store current_attribution`).

**Step 3: Implement**

In `tide-store/src/config.rs`, after `append_trailer_once`:

```rust
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
```

Then retarget `crates/tide-tools/src/tools/git.rs:681` — replace the body of `tide_attribution` with:

```rust
fn tide_attribution() -> Option<tide_store::config::CommitAttribution> {
    tide_store::config::current_attribution()
}
```

(Keep the function and its doc comment; only the delegation changes. The tide-tools tests still pass because behavior is identical.)

**Step 4: Run + commit**

Run: `cargo test -p tide-store -p tide-tools`
Expected: PASS.

```bash
git add crates/tide-store/src/config.rs crates/tide-tools/src/tools/git.rs
git commit -m "refactor(git): hoist the shared attribution read into tide-store config"
```

---

## Task 11: Panel-commit attribution in `git_commit.rs`

**Files:**
- Modify: `crates/waku-core/src/git_commit.rs` (`commit` at line 142, new helpers near `git_capture` at line 561)

**Step 1: Write the failing tests**

Append to the existing test module (find it at the bottom of `git_commit.rs`; reuse its repo-seeding helpers — read them first):

```rust
    static ATTRIBUTION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_scratch_tide_dir(config_json: Option<&str>) -> tempfile::TempDir {
        let scratch = tempfile::tempdir().unwrap();
        if let Some(json) = config_json {
            std::fs::write(scratch.path().join("config.json"), json).unwrap();
        }
        std::env::set_var(tide_store::paths::DATA_DIR_ENV, scratch.path());
        scratch
    }

    #[test]
    fn commit_applies_attribution_in_both_modes_and_off() {
        let _guard = ATTRIBUTION_LOCK.lock().unwrap();
        let repo = seeded_git_repo(); // existing helper that creates a repo with an identity and a staged file — reuse whatever the module's tests already use
        let author_cfg = r#"{"generalSettings":{"gitCoAuthored":true,"gitAttributionMode":"author","gitCoAuthorName":"Tide","gitCoAuthorEmail":"314188112+tide-codes@users.noreply.github.com"}}"#;

        // Author mode: Tide authors, user trails.
        let _dir = with_scratch_tide_dir(Some(author_cfg));
        commit(repo.path(), "author mode", false).unwrap();
        assert_eq!(git_stdout(repo.path(), &["log", "-1", "--format=%an"]).unwrap(), "Tide");
        assert_eq!(
            git_stdout(repo.path(), &["log", "-1", "--format=%b"]).unwrap().trim(),
            "Co-authored-by: Tester <tester@example.com>"
        );

        // Co-author mode: user authors, Tide trails.
        let co_cfg = r#"{"generalSettings":{"gitCoAuthored":true,"gitAttributionMode":"co-author","gitCoAuthorName":"Tide","gitCoAuthorEmail":"314188112+tide-codes@users.noreply.github.com"}}"#;
        let _dir = with_scratch_tide_dir(Some(co_cfg));
        stage_new_file(repo.path()); // helper: write+stage a fresh file so there is something to commit
        commit(repo.path(), "co-author mode", false).unwrap();
        assert_eq!(git_stdout(repo.path(), &["log", "-1", "--format=%an"]).unwrap(), "Tester");
        assert!(
            git_stdout(repo.path(), &["log", "-1", "--format=%b"])
                .unwrap()
                .contains("Co-authored-by: Tide <314188112+tide-codes@users.noreply.github.com>")
        );

        // Off / unreadable: message untouched.
        let _dir = with_scratch_tide_dir(None);
        stage_new_file(repo.path());
        commit(repo.path(), "plain", false).unwrap();
        assert_eq!(git_stdout(repo.path(), &["log", "-1", "--format=%B"]).unwrap().trim(), "plain");

        std::env::remove_var(tide_store::paths::DATA_DIR_ENV);
    }
```

Adapt `seeded_git_repo` / `stage_new_file` to whatever the file's test module already provides (it has commit tests — reuse their fixtures; the repo must configure `user.name=Tester user.email=tester@example.com` locally).

**Step 2: Run — verify failure** (`cargo test -p waku-core commit_applies_attribution` — currently the author-name assertions fail: commits carry Tester, no trailers).

**Step 3: Implement**

Env-carrying capture variant next to `git_capture` (line 561):

```rust
fn git_capture_env(
    cwd: &Path,
    args: &[&str],
    envs: &[(&'static str, String)],
) -> anyhow::Result<CapturedOutput> {
    let mut command = crate::command_env::command("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true");
    for (key, value) in envs {
        command.env(key, value);
    }
    run_capture(&mut command, GIT_TIMEOUT)
}
```

Attribution resolution + rewrite, above `commit`:

```rust
/// The identity a commit here would use, per git's own resolution order
/// (repo-local then global config).
fn resolved_identity(cwd: &Path) -> Option<(String, String)> {
    let name = git_optional_stdout(cwd, &["config", "user.name"]).ok().flatten();
    let email = git_optional_stdout(cwd, &["config", "user.email"]).ok().flatten();
    match (name, email) {
        (Some(name), Some(email)) if !name.is_empty() && !email.is_empty() => {
            Some((name, email))
        }
        _ => None,
    }
}

/// The commit message + author env overrides the attribution setting calls
/// for — the same contract as the agent git tool (Co-author: repo identity
/// authors, Tide trails; Author: Tide authors, the applied identity trails).
fn attributed_commit(
    cwd: &Path,
    message: &str,
) -> anyhow::Result<(String, Vec<(&'static str, String)>)> {
    let Some(attribution) = tide_store::config::current_attribution() else {
        return Ok((message.to_owned(), Vec::new()));
    };
    let user = resolved_identity(cwd);
    let message = match &user {
        Some((name, email)) => {
            tide_store::config::append_trailer_once(message, &attribution.trailer(name, email))
        }
        None => message.to_owned(),
    };
    let mut envs = Vec::new();
    if let Some((name, email)) = attribution.author_override() {
        envs.push(("GIT_AUTHOR_NAME", name.to_owned()));
        envs.push(("GIT_AUTHOR_EMAIL", email.to_owned()));
    }
    Ok((message, envs))
}
```

And in `commit` (line 142), replace the final spawn:

```rust
    let (message, envs) = attributed_commit(cwd, &message)?;
    git_capture_env(cwd, &["commit", "-m", &message], &envs)?
        .status
        .success()
        .then_some(())
        .ok_or_else(|| anyhow!("Git commit failed"))?;
```

Match the module's actual success-check idiom (`git_success` uses `git_capture` + status check — mirror it, possibly by adding a `git_success_env` helper instead of inlining).

**Step 4: Run + commit**

Run: `cargo test -p waku-core git_commit`
Expected: PASS (existing tests + the new one).

```bash
git add crates/waku-core/src/git_commit.rs
git commit -m "feat(git): panel commits honor the attribution setting — same contract as the agent tool"
```

---

## Task 12: UI — `GitSettingsPanel` state, dispatch, event drain

**Files:**
- Create: `src/app/git_settings.rs`
- Modify: `src/app.rs` (field `pub(crate) git_settings: crate::app::git_settings::GitSettingsPanel`, constructed in `Waku::new`/wherever `tide` is constructed; add `mod git_settings;` to the app module list)
- Modify: `src/app/runtime.rs` (dispatch + drain; register the drain at line ~3494 next to `drain_tide_ops_events`)

Read `src/app/tide_providers.rs:272-300` (panel + channel) and `src/app/runtime.rs:3737-3790` (dispatch) and `runtime.rs:4145-4165` (drain) before writing — this task mirrors them exactly.

**Step 1: Create the panel module**

```rust
//! State for the Git settings page — port of tide's
//! `components/screens/settings/git.tsx` on the TideProviderPanel pattern:
//! a snapshot loaded via a spawned dispatch thread, dialog drafts, and the
//! GitHub device-flow state machine.

use super::*;
use waku_protocol::git_settings::{
    GitDiscoveredCredentialWire, GitProfileWire, GitSnapshotWire,
};

pub(crate) enum GitOpsEvent {
    Snapshot(Result<GitSnapshotWire, String>),
    DeviceStart(Result<waku_protocol::git_settings::GithubDeviceStartWire, String>),
    DevicePoll(Result<waku_protocol::git_settings::GithubConnectPollWire, String>),
    Credentials(Result<Vec<GitDiscoveredCredentialWire>, String>),
    /// A failed op (set/clear/save) — surfaced as a transient row error.
    OpFailed(String),
}

/// The device-flow dialog, mirroring tide's `DeviceFlowState`.
pub(crate) enum DeviceFlowPhase {
    Starting,
    Waiting {
        device_code: String,
        user_code: String,
        verification_uri: String,
        /// unix seconds when the code expires.
        expires_at: f64,
        /// poll interval seconds, from the start reply.
        interval: u64,
    },
    Denied,
    Expired,
    Error(String),
}

/// A profile-dialog draft, mirroring tide's `ProfileDraft`.
pub(crate) struct ProfileDraft {
    pub profile: GitProfileWire,
    pub token: String,
    /// Which GitHub account preselected a github-sourced draft.
    pub github_login: Option<String>,
    pub error: Option<String>,
    pub saving: bool,
}

impl ProfileDraft {
    pub(crate) fn empty() -> Self {
        Self {
            profile: GitProfileWire {
                id: uuid::Uuid::new_v4().to_string(),
                name: None,
                user_name: String::new(),
                user_email: String::new(),
                auth_type: "ssh".into(),
                ssh_key: Some(String::new()),
                host: Some("github.com".into()),
                github_login: None,
                sign_commits: false,
                signing_key: Some(String::new()),
                color: "keyword".into(),
                icon: "branch".into(),
                source: "manual".into(),
            },
            token: String::new(),
            github_login: None,
            error: None,
            saving: false,
        }
    }

    /// Port of tide's `validateDraft` (git.tsx:264-271).
    pub(crate) fn validate(&self) -> Option<&'static str> {
        if self.profile.user_name.trim().is_empty() {
            return Some("User name is required");
        }
        if self.profile.user_name.contains('\'') || self.profile.user_email.contains('\'') {
            return Some("Single quotes are not allowed");
        }
        let email = &self.profile.user_email;
        let local_at_domain = email.split_once('@');
        let valid = local_at_domain.is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        });
        if !valid {
            return Some("Enter a valid email (local@domain.tld)");
        }
        if self.profile.source == "github" && self.github_login.is_none() {
            return Some("Pick a GitHub account");
        }
        None
    }
}

pub(crate) struct GitSettingsPanel {
    pub snapshot: Option<GitSnapshotWire>,
    pub loaded: bool,
    /// Transient per-key save indicator, mirroring tide's `savingKey`.
    pub saving_attribution: bool,
    pub device_flow: Option<DeviceFlowPhase>,
    pub profile_dialog: Option<ProfileDraft>,
    pub import_list: Option<Vec<GitDiscoveredCredentialWire>>,
    /// Login with a gh-cli connect in flight.
    pub gh_connecting: Option<String>,
    pub error: Option<String>,
    pub ops_tx: Sender<GitOpsEvent>,
    pub ops_rx: Receiver<GitOpsEvent>,
}

impl GitSettingsPanel {
    pub(crate) fn new() -> Self {
        let (ops_tx, ops_rx) = unbounded();
        Self {
            snapshot: None,
            loaded: false,
            saving_attribution: false,
            device_flow: None,
            profile_dialog: None,
            import_list: None,
            gh_connecting: None,
            error: None,
            ops_tx,
            ops_rx,
        }
    }
}
```

(`unbounded`, `Sender`, `Receiver` come from the `super::*` glob the way `tide_providers.rs` gets them — check what it imports and match.)

**Step 2: Dispatch + drain in `runtime.rs`**

Model on `tide_dispatch` (runtime.rs:3737). One dispatcher for all git commands:

```rust
    pub(super) fn git_dispatch(&self, command: waku_client::Command) {
        let ops_tx = self.git_settings.ops_tx.clone();
        let event_wake = self.event_wake_tx.clone();
        let daemon = self.daemon.client();
        let _ = std::thread::Builder::new()
            .name("waku-git-settings".into())
            .spawn(move || {
                let event = match daemon.request(Uuid::nil(), Uuid::nil(), command) {
                    Ok(waku_client::ResponsePayload::GitSnapshot { snapshot }) => {
                        super::git_settings::GitOpsEvent::Snapshot(Ok(snapshot))
                    }
                    Ok(waku_client::ResponsePayload::GithubDeviceStart { start }) => {
                        super::git_settings::GitOpsEvent::DeviceStart(Ok(start))
                    }
                    Ok(waku_client::ResponsePayload::GithubConnectPoll { poll }) => {
                        super::git_settings::GitOpsEvent::DevicePoll(Ok(poll))
                    }
                    Ok(waku_client::ResponsePayload::GitCredentials { items }) => {
                        super::git_settings::GitOpsEvent::Credentials(Ok(items))
                    }
                    Ok(waku_client::ResponsePayload::GitOp { result }) if !result.ok => {
                        super::git_settings::GitOpsEvent::OpFailed(
                            result.error.unwrap_or_else(|| "the operation failed".into()),
                        )
                    }
                    Ok(_) => super::git_settings::GitOpsEvent::Snapshot(Err(
                        "the backend returned an unexpected response".into(),
                    )),
                    Err(error) => super::git_settings::GitOpsEvent::Snapshot(Err(error.to_string())),
                };
                if ops_tx.send(event).is_ok() {
                    signal_event_pump(&event_wake);
                }
            });
    }

    pub(super) fn git_load_snapshot(&mut self) {
        self.git_dispatch(waku_client::Command::GitSnapshot);
    }
```

Drain, modeled on `drain_tide_ops_events` (runtime.rs:4145), handling each event: `Snapshot` stores + `loaded = true`; `DeviceStart` moves `device_flow` from `Starting` to `Waiting`; `DevicePoll` maps pending → schedule re-poll (see Task 15 for the cadence mechanism — use the app's existing timer/`cx.spawn` pattern; do NOT poll from render); success/denied/expired/error map to phases, success also triggers `git_load_snapshot`; `Credentials` stores `import_list`; `OpFailed` stores `error`. Every branch ends in `cx.notify()`.

Register at runtime.rs:3494:

```rust
            | self.drain_git_ops_events(cx)
```

**Step 3: Build + commit**

Run: `cargo check` (workspace) — clean.

```bash
git add src/app/git_settings.rs src/app.rs src/app/runtime.rs
git commit -m "feat(git): git settings panel state, dispatch, and event drain"
```

---

## Task 13: UI — page registration and load hook

**Files:**
- Modify: `src/app.rs:206` (`SettingsPage` enum — add `Git,` after `Tide,`)
- Modify: `src/app/settings.rs:21` (`SETTINGS_PAGES` — array size 8 → 9; new tuple after the Tide entry)
- Modify: `src/app/settings.rs:364,375` (titlebar label + page dispatch)
- Modify: `src/app/usage_page.rs:55` (load hook)

**Step 1: Register the page**

```rust
// src/app.rs — SettingsPage
    Tide,
    /// Port of tide's Git settings screen — accounts, identities,
    /// attribution, per-project identity state.
    Git,
```

```rust
// src/app/settings.rs — SETTINGS_PAGES entry (after the Tide tuple)
    (
        SettingsPage::Git,
        "settings.git",
        "icons/git-branch.svg",
        "settings.git_keywords",
    ),
```

Titlebar (settings.rs:364, in the label match):

```rust
                        SettingsPage::Git => tr!("settings.git"),
```

Content dispatch (settings.rs:375):

```rust
                SettingsPage::Git => self.render_git_settings(theme, cx),
```

Load hook (usage_page.rs:55, next to the Tide one):

```rust
        if page == SettingsPage::Git && !self.git_settings.loaded {
            self.git_load_snapshot();
        }
```

**Step 2: Stub render so it compiles**

In `src/app/git_settings.rs`:

```rust
impl Waku {
    pub(super) fn render_git_settings(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .p(px(6.0))
            .when(!self.git_settings.loaded, |element| {
                element.child(
                    div()
                        .p(px(24.0))
                        .text_size(sp(13.0))
                        .text_color(theme.text_tertiary)
                        .child("Loading…"),
                )
            })
    }
}
```

(Check how `render_tide_settings` is declared — `fn render_tide_settings(&self, theme: Theme, cx: &mut Context<Self>) -> Div` at settings.rs:2573 — and whether the call site wraps it; mirror exactly.)

**Step 3: Locales (minimum to run)**

Add to `locales/app.yml`, `locales/ja.yml`, `locales/zh-CN.yml` (translate ja/zh; en shown):

```yaml
settings.git:
  en: Git
settings.git_keywords:
  en: git identity identities github commit attribution co-author signing ssh
git.caption:
  en: GitHub accounts and commit identities.
```

**Step 4: Validate in the debug app + commit**

Wait for the watcher rebuild; open Settings → Git: sidebar row with the branch icon, title "Git", loading state, then an empty page (snapshot fetched — verify via the daemon log or by temporarily logging). No visual test beyond smoke; the sections come next.

```bash
git add src/app.rs src/app/settings.rs src/app/usage_page.rs src/app/git_settings.rs locales
git commit -m "feat(git): settings page shell for the git identities screen"
```

---

## Task 14: UI — Attribution + Identities sections

**Files:**
- Modify: `src/app/git_settings.rs`

Read before writing: `git.tsx:632-1020` (the `GitSection` component), and the card/row idioms in `src/app/settings.rs` (`render_tide_settings` body, `render_general_settings` switches/rows).

**Step 1: Section scaffold + helper**

Follow `render_tide_settings`'s card pattern (rounded border container, rows with `border_color(theme.border)` dividers). Add a small private helper for a titled group so the four sections share it:

```rust
fn git_settings_group(title: &str, theme: Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .text_size(sp(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text)
                .child(title.to_string()),
        )
}
```

**Step 2: Attribution section (port of `git.tsx:908-946`)**

- Switch row "Attribute commits" — a toggle. Use the switch control the General page uses (find it in `render_general_settings`; if it's inline, extract or copy the idiom). Description text (locale key `git.attribution.description`): "Adds attribution to the commits Waku makes (panel and agent commits — terminal git is untouched)."
- When `snapshot.attribution.co_authored`: a second row "Tide's role" with a two-option segmented control (Author / Co-Author). GPUI has no Segmented primitive in-repo — render two adjacent toggle chips (selected = `theme.accent` border/fill), each a focusable div with `on_click` dispatching:

```rust
    pub(super) fn git_set_attribution(&mut self, co_authored: Option<bool>, mode: Option<String>) {
        if let Some(co_authored) = co_authored {
            self.git_settings.saving_attribution = true;
        }
        self.git_dispatch(waku_client::Command::GitUpdateAttribution {
            git_co_authored: co_authored,
            git_attribution_mode: mode,
        });
        cx.notify(); // via the listener context at the call site
    }
```

`saving_attribution` clears on the next `Snapshot` event (set `false` there; for the checkmark, keep a `saved_at: Option<Instant>` cleared after ~900ms via the app's existing transient-indicator pattern — check how the Tide page or General page shows save feedback and copy it; if none exists, keep `saving_attribution → saved` state until the next change, simpler and still clear).

- Mode-dependent description (port of `git.tsx:926-930`).

**Step 3: Identities section (port of `git.tsx:808-906`)**

Rows from `snapshot.profiles` plus a pinned "Global" first row:
- Global row: globe icon (`icons/globe.svg`), title "Global", `system` badge, mono line from `snapshot.global` (`name <email>` or the none-configured fallback).
- Profile rows: color dot (map the profile's `color` token to a theme color — define a small `fn dot_color(token: &str, theme: Theme) -> gpui::Rgba` with the palette tide's `identity-style.ts` uses: keyword/accent/success/warning/destructive → theme equivalents), display name, badges (`signed` when `sign_commits`, `github` + login when `source == "github"`, `token · host` / `SSH` otherwise), mono `name <email>` line, Edit + Delete buttons (visible on hover AND on row focus — `focus(within)` styling; both `tab_index(0)`).
- Edit opens the dialog draft from the profile; Delete needs a confirm popover — use the same confirm pattern the app uses elsewhere (search `src/app` for an existing confirm popover; the providers page has a delete flow — reuse it).
- "New" button dispatches an empty draft; "Import" button dispatches `Command::GitDiscoverCredentials` and renders the import list popover (port of `git.tsx:538-593`).
- Empty state: dashed-circle plus with the invite line (port of `git.tsx:888-903`).

New locale keys under `git.*` for every string (en/ja/zh-CN).

**Step 4: Actions in `runtime.rs`**

```rust
    pub(super) fn git_save_profile(&mut self) {
        let Some(draft) = self.git_settings.profile_dialog.clone() else { return };
        if let Some(error) = draft.validate() { /* store into draft.error; notify; return */ }
        // mark saving; dispatch GitIdentitySave { profile, token: non-empty or None }
    }
```

Also `git_edit_profile(id)`, `git_new_profile()`, `git_delete_profile(id)`, `git_open_import()`, `git_close_import()`, `git_import_prefill(cred)` (fills a draft with `user_name`, `host`, `auth_type: "token"`, name `"{username} · {host}"` — port of `git.tsx:289-303`).

**Step 5: Validate + commit**

Watcher rebuild → Settings → Git: toggle attribution (verify `~/.tide/config.json` gains `gitCoAuthored`), create an identity (verify `~/.tide/git-identities.json`), delete it, Global row shows your real git identity.

```bash
git add src/app/git_settings.rs src/app/runtime.rs locales
git commit -m "feat(git): identities and attribution sections"
```

---

## Task 15: UI — profile dialog + GitHub section

**Files:**
- Modify: `src/app/git_settings.rs` (dialog), `src/app/runtime.rs` (actions)

**Step 1: Profile dialog (port of `git.tsx:211-534`)**

Render as a modal overlay the same way the Tide add-provider wizard renders (find how `TideWizard` is mounted — likely a full-sheet or centered overlay in the settings content; copy that mounting). Content:
- Source segment (Manual / GitHub) only when `snapshot.accounts` is non-empty; picking a GitHub account prefills per `pickGitHubAccount` (`git.tsx:311-322`): `auth_type = "token"`, `host = "github.com"`, email defaults to `{accountId}+{login}@users.noreply.github.com`.
- Auth segment (SSH key / Token); SSH shows key path input, Token shows host + password input (placeholder "unchanged" when editing).
- Display name, User name *, Email * inputs (`TextInput::new(...).placeholder(...)` entities created when the draft opens — see `TideWizard::new` for the entity pattern; store the entities on the draft struct, add them: `pub name: Entity<TextInput>` etc., synced back on save).
- Commit-signing disclosure (chevron toggle → switch + signing-key input).
- Color dots + icon tiles row (port of `git.tsx:488-519`; icons from the `icons/` set that overlap tide's lucide names: `branch`, `server`, `globe`, `laptop`, `fork`, `terminal` — check what exists in `assets/icons/` and map).
- Inline `draft.error`, Cancel / Save buttons; Save disabled while invalid or saving; Enter submits, Escape cancels (bind in the overlay's key context, following the wizard).

**Step 2: GitHub section (port of `git.tsx:708-806`)**

- Connected account rows: avatar (round `img` — check how avatars render elsewhere in the app; if none, fall back to `icons/github.svg` tile), `@login`, mono accountId, Disconnect button with confirm → `Command::GithubDisconnect`.
- gh-CLI rows from `snapshot.gh_cli.accounts` minus already-connected logins: terminal icon, `@login` + `active` badge, Connect button → `Command::GithubConnectFromGhCli` (set `gh_connecting`, spinner while in flight — the app's loading idiom).
- Footer: "N connected" + "Add via browser…" → opens `device_flow = Some(DeviceFlowPhase::Starting)` and dispatches `Command::GithubConnectStart`.

**Step 3: Device-flow popover (port of `git.tsx:55-209`)**

Modal with the three numbered steps: verification URL + Open button (`crate::platform`/browser open — find the existing `openExternal` equivalent, e.g. how docs links open), big mono user code + Copy button (clipboard via the app's existing copy action), countdown minutes from `expires_at`. Polling: on `DeviceStart` → `Waiting`; schedule each poll with the app's deferred-task mechanism (`cx.spawn` + `cx.background_executor().timer(duration)` — this is UI-thread async, NOT render work; it matches the performance rules). `DevicePoll` pending → schedule the next poll at `interval` seconds; success → close + refresh snapshot; denied/expired/error → phase + Retry button (restarts the flow).

Cancellation: closing the dialog sets `device_flow = None`; the spawn chain checks a generation counter so a stale poll can't resurrect the dialog (the same guard pattern the perf rules require for background passes).

**Step 4: Validate + commit**

With a real browser: connect a GitHub account via device flow, verify the account card appears and `~/.tide/config.json` secrets gain `github:<login>`; disconnect. If `gh` is installed: one-click Connect path.

```bash
git add src/app/git_settings.rs src/app/runtime.rs locales
git commit -m "feat(git): profile dialog, github accounts, device-flow connect"
```

---

## Task 16: UI — Workspaces section with identity picker

**Files:**
- Modify: `src/app/git_settings.rs`, `src/app/runtime.rs`

**Step 1: Rows (port of `git.tsx:948-994`, plus the picker from the panel's `git-panel.tsx` apply UX)**

- One row per `snapshot.statuses`: name, badge (`not a repo` when `!is_repo` — red tint, `override` when `has_override`, else `global`), mono `path · Name <email>` (or `· no identity resolved`), colored left rail dot from the matched profile (destructive color when not a repo).
- Picker: a button on each repo row showing the current identity's display name (or "Global"), opening a popover menu listing `Global` + every profile (name + email, colored dot, checkmark on the active one). Selecting dispatches `Command::GitSetIdentity { project_path, profile_id }`; "Global" passes `"global"`.
- `Clear override` button when `has_override` (port of `git.tsx:976-988`) → `Command::GitClearIdentity`.

Popover: reuse the app's existing popover/menu primitive (check `src/app/components.rs` and how MenuChip popovers in the composer are built — copy that). Keyboard: the picker button is tabbable; the menu supports arrows + enter + escape like other menus in the app.

**Step 2: Actions**

```rust
    pub(super) fn git_apply_identity(&mut self, project_path: PathBuf, profile_id: String) {
        self.git_dispatch(waku_client::Command::GitSetIdentity { project_path, profile_id });
    }

    pub(super) fn git_clear_override(&mut self, project_path: PathBuf) {
        self.git_dispatch(waku_client::Command::GitClearIdentity { project_path });
    }
```

**Step 3: Validate + commit**

Create a scratch git repo, add it as a waku project, apply an identity from the row → run `git config --local user.email` in the repo and confirm; Clear override removes the keys; the badge flips `override` ↔ `global`.

```bash
git add src/app/git_settings.rs src/app/runtime.rs locales
git commit -m "feat(git): per-project identity apply from the workspaces section"
```

---

## Task 17: Final validation pass

**Step 1: Full test suite**

```bash
cargo test -p waku-protocol -p waku-core -p tide-store -p tide-tools
cargo clippy -p waku-core -p waku-protocol -p tide-store -- -D warnings
```

Expected: all pass (known flaky server/socket tests aside — see the dev-test quirks note; they pass in isolation).

**Step 2: End-to-end in the freshly relaunched debug app**

1. Settings → Git loads in one shot (no per-row spinner flicker).
2. Identity round-trip: create → apply to a project → verify local config → clear → badge updates.
3. Attribution parity: set Author mode → commit once from the commit dialog and once by asking the agent to commit → both carry Tide as author and the user in the trailer; Co-author mode flips it; off leaves messages untouched (`git log --format='%an|%b' -2`).
4. Device flow + gh CLI connect (if available), disconnect clears the card and secret.
5. Import from `~/.git-credentials` prefills a draft; tokens never render.
6. Both themes legibility; full keyboard pass: tab through every control, hover-only actions reachable by focus, escape closes each dialog/popover, arrows work in pickers.
7. Reduce-motion: no decorative animation ignores the system setting (only standard transitions used).

**Step 3: Commit any fixes, then the finished feature**

```bash
git add -A
git commit -m "feat(git): tide git settings port complete — accounts, identities, attribution"
```

---

## Appendix: port-mapping quick reference

| Tide upstream | Waku target |
|---|---|
| `git.tsx:29-34` `AttributionSettings` | `GitAttributionWire` (Task 1) |
| `git.tsx:55-209` `DeviceFlowDialog` | `DeviceFlowPhase` + popover (Task 15) |
| `git.tsx:211-534` `ProfileDialog` | `ProfileDraft` + dialog (Tasks 12, 15) |
| `git.tsx:538-593` `ImportCredentialsDialog` | import popover (Task 14) |
| `git.tsx:632-1020` `GitSection` | `render_git_settings` (Tasks 13-16) |
| `commands/git_identities.rs:121-177` CRUD | `GitIdentities::{save_profile,delete_profile}` (Task 4) |
| `:179-243` apply/clear | `apply_profile_config`/`clear_profile_config` (Task 3) |
| `:246-280` credential approve | `credential_approve` (Task 5) |
| `:409-463` set identity | `GitIdentities::set_identity` (Task 5) |
| `:483-538` workspace statuses | `GitIdentities::statuses` (Task 5) |
| `:545-590` credentials parse | `parse_git_credentials` (Task 6) |
| `:592-790` device flow | `github_connect_*` (Task 7) |
| `:793-876` gh CLI | `parse_gh_auth_status` (Task 8) |
| `:881-943` gh connect | `github_connect_from_gh_cli` (Task 7) |
