//! Wire shapes for Git identity management — the settings-screen half of
//! tide's git-identities feature. Mirrors the wire structs in tide's
//! `commands/git_identities.rs`; tokens never cross the wire.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// One commit identity profile, mirroring
/// `store::git_identities::GitIdentityProfile` without the storage
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

/// Identity state for one tide project, mirroring tide's
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

/// A stored background-model override, mirroring
/// `store::config::ModelRef` without importing store here. The
/// provider id names either a tide sub-provider or a tide `ProviderKind`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelRefWire {
    pub provider_id: String,
    pub model_id: String,
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
    /// Background-task model overrides; `None` means "use the session's
    /// model". Rides the git snapshot because the General page already loads
    /// it eagerly at startup.
    pub background_title_model: Option<ModelRefWire>,
    pub background_commit_model: Option<ModelRefWire>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResultWire {
    pub ok: bool,
    pub error: Option<String>,
}

impl GitOpResultWire {
    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
        }
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
            gh_cli: GhCliStatusWire {
                installed: false,
                accounts: Vec::new(),
            },
            statuses: Vec::new(),
            attribution: GitAttributionWire {
                co_authored: true,
                name: "Tide".into(),
                email: "314188112+tide-codes@users.noreply.github.com".into(),
                mode: "author".into(),
            },
            global: GitGlobalIdentityWire {
                name: None,
                email: None,
                ssh_command: None,
            },
            background_title_model: Some(ModelRefWire {
                provider_id: "p1".into(),
                model_id: "model-a".into(),
            }),
            background_commit_model: None,
        };
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("\"userEmail\""), "{json}");
        assert!(json.contains("\"coAuthored\""), "{json}");
        assert!(json.contains("\"backgroundTitleModel\""), "{json}");
        let back: GitSnapshotWire = serde_json::from_str(&json).unwrap();
        assert_eq!(back.profiles[0].id, "work");
    }
}
