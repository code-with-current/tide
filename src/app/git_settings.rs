//! State for the Git settings page — port of tide's
//! `components/screens/settings/git.tsx` on the TideProviderPanel pattern:
//! a snapshot loaded via a spawned dispatch thread, dialog drafts, and the
//! GitHub device-flow state machine.

use crossbeam_channel::{Receiver, Sender, unbounded};
use gpui::Entity;
use protocol::git_settings::{
    GitDiscoveredCredentialWire, GitProfileWire, GitSnapshotWire, GithubConnectPollWire,
    GithubDeviceStartWire,
};

use crate::input::TextInput;

/// Results of backend git commands, pumped through the shared event wake.
pub(crate) enum GitOpsEvent {
    Snapshot(Result<GitSnapshotWire, String>),
    DeviceStart(Result<GithubDeviceStartWire, String>),
    DevicePoll(Result<GithubConnectPollWire, String>),
    /// The gh-CLI one-click connect; a distinct event because the backend
    /// reuses the device-poll payload for its reply.
    GhConnect(Result<GithubConnectPollWire, String>),
    Credentials(Result<Vec<GitDiscoveredCredentialWire>, String>),
    /// A failed op (set/clear/save) — surfaced as a transient error.
    OpFailed(String),
}

/// The device-flow dialog, mirroring tide's `DeviceFlowState`.
#[derive(Clone)]
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

/// A profile-dialog draft, mirroring tide's `ProfileDraft`. The text fields
/// live as `TextInput` entities — the TideWizard pattern — because the draft
/// persists across renders; `profile` stays the field-for-field source of
/// truth and is resynced from the entities before validation and save.
pub(crate) struct ProfileDraft {
    pub profile: GitProfileWire,
    /// Display name.
    pub name: Entity<TextInput>,
    /// Required git user name.
    pub user_name: Entity<TextInput>,
    /// Required git email.
    pub user_email: Entity<TextInput>,
    /// Manual + SSH only.
    pub ssh_key: Entity<TextInput>,
    /// Manual + token only.
    pub host: Entity<TextInput>,
    /// Pastable token; never round-trips from an edit.
    pub token: Entity<TextInput>,
    /// Commit-signing key.
    pub signing_key: Entity<TextInput>,
    /// True while editing an existing profile — drives the title, the save
    /// label, and the token field's "unchanged" placeholder.
    pub editing: bool,
    /// Commit-signing disclosure open.
    pub sign_open: bool,
    /// Which GitHub account preselected a github-sourced draft.
    pub github_login: Option<String>,
    pub error: Option<String>,
}

impl ProfileDraft {
    /// Port of tide's `validateDraft` (git.tsx:264-271), returning locale
    /// keys. `profile` must already be synced from the input entities.
    pub(crate) fn validate(&self) -> Option<&'static str> {
        if self.profile.user_name.trim().is_empty() {
            return Some("git.profile.error_user_name");
        }
        if self.profile.user_name.contains('\'') || self.profile.user_email.contains('\'') {
            return Some("git.profile.error_quotes");
        }
        let email = self.profile.user_email.trim();
        match email.split_once('@') {
            Some((local, domain))
                if !local.is_empty()
                    && domain.contains('.')
                    && !domain.starts_with('.')
                    && !domain.ends_with('.') =>
            {
                // A well-formed local@domain.tld — fall through to the
                // source check below.
            }
            _ => return Some("git.profile.error_email"),
        }
        if self.profile.source == "github" && self.github_login.is_none() {
            return Some("git.profile.error_pick_account");
        }
        None
    }
}

/// A deferred profile-dialog open. Building the draft needs a `Window` for
/// its `TextInput` entities, which the runtime actions do not carry — the
/// goal-dialog request pattern stages the open for the next frame.
pub(crate) struct GitProfileRequest {
    /// `None` → create.
    pub editing: Option<GitProfileWire>,
    /// Discovered `~/.git-credentials` pair to prefill a create with.
    pub prefill: Option<GitDiscoveredCredentialWire>,
}

pub(crate) struct GitSettingsPanel {
    pub snapshot: Option<GitSnapshotWire>,
    pub loaded: bool,
    /// One dropdown handle per Workspaces row (index-aligned with
    /// `snapshot.statuses`), driving the per-project identity picker. The
    /// menu primitive owns its open state; the handles are grown in the
    /// snapshot drain so render stays pure.
    pub project_menus: Vec<crate::ui::menu::ContextMenuHandle>,
    /// Transient save indicator for the attribution rows, mirroring tide's
    /// `savingKey`.
    pub saving_attribution: bool,
    /// Monotonic counter guarding the device-flow poll chain: a closed or
    /// restarted dialog must invalidate scheduled polls.
    pub device_flow_generation: u64,
    pub device_flow: Option<DeviceFlowPhase>,
    pub profile_request: Option<GitProfileRequest>,
    pub profile_dialog: Option<ProfileDraft>,
    /// The import popover's visibility. `import_list` stays `None` until the
    /// discovery reply lands, so `Some` list = loaded, `None` + open =
    /// fetching.
    pub import_open: bool,
    pub import_list: Option<Vec<GitDiscoveredCredentialWire>>,
    /// The identity row whose delete button is armed for confirmation,
    /// mirroring the skills page's one-click-arms, second-click-deletes flow.
    pub confirm_delete: Option<String>,
    /// The connected account whose disconnect button is armed.
    pub confirm_disconnect: Option<String>,
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
            device_flow_generation: 0,
            device_flow: None,
            profile_request: None,
            profile_dialog: None,
            import_open: false,
            import_list: None,
            project_menus: Vec::new(),
            confirm_delete: None,
            confirm_disconnect: None,
            gh_connecting: None,
            error: None,
            ops_tx,
            ops_rx,
        }
    }
}
