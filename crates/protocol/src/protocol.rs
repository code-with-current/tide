use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use uuid::Uuid;

use crate::attachments::{AttachmentUpload, StoredAttachment};
use crate::computer_use::ComputerPermissions;
use crate::git_settings::{
    GitDiscoveredCredentialWire, GitOpResultWire, GitProfileWire, GitSnapshotWire,
    GithubConnectPollWire, GithubDeviceStartWire,
};
use crate::model::{AgentSession, GoalOperation, Project, UserInputAnswer};
use crate::persistence::{ComposerDraftChange, ComposerDrafts, SessionMessageMatch};
use crate::settings::DaemonSettings;
use crate::skills::SkillsCatalog;
use crate::tide::{TideModelWire, TideProviderWire};
use crate::usage_history::{UsageHistory, UsageWindow};
use crate::workspace::{WorkspaceOperation, WorkspaceResult};

pub const PROTOCOL_VERSION: u32 = 7;
pub const MAX_WIRE_MESSAGE_BYTES: usize = 48 * 1024 * 1024;
pub const DAEMON_TOKEN_ENV: &str = "TIDE_DAEMON_TOKEN";
pub const DAEMON_ADDRESS_ENV: &str = "TIDE_DAEMON_ADDRESS";
pub const APP_EXECUTABLE_ENV: &str = "TIDE_APP_EXECUTABLE";

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DaemonReady {
    pub address: String,
    pub protocol_version: u32,
    pub pid: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    Hello {
        protocol_version: u32,
        token: String,
        client_id: Uuid,
        #[serde(default)]
        resume_from: Vec<ReplayCursor>,
    },
    Request(Request),
    Shutdown,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub runtime_id: Uuid,
    pub command: Command,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCursor {
    pub session_id: Uuid,
    pub runtime_id: Uuid,
    /// Identifies the daemon process that assigned `sequence`.
    pub epoch: Uuid,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    /// Resolve the daemon-owned provider runtime for an existing task.
    ///
    /// Clients use this after reconnecting or opening the same daemon from a
    /// second app. It observes the session actor without starting, replacing,
    /// or otherwise mutating the provider process.
    AttachSession,
    Start {
        options: WireDriverStartOptions,
    },
    Prompt {
        prompt: String,
    },
    Steer {
        prompt: String,
    },
    Cancel,
    CancelComputerUse,
    RefreshBackgroundWork,
    StopBackgroundWork {
        key: Value,
        control_id: String,
    },
    Respond {
        request_id: String,
        option_id: String,
    },
    RespondUserInput {
        request_id: String,
        answers: Vec<UserInputAnswer>,
    },
    /// Ask the live provider runtime to read or mutate its persisted thread
    /// goal. Fire-and-forget: the outcome arrives as a `goalUpdated` driver
    /// event, or an `error` event when the provider refuses.
    Goal {
        operation: GoalOperation,
    },
    RunComputerTool {
        request: WireComputerToolRequest,
    },
    RejectComputerTool {
        request: WireComputerToolRequest,
        reason: String,
    },
    ApplyOptions {
        options: WireSessionOptions,
    },
    Rollback {
        turns: usize,
    },
    Fork {
        turns_to_remove: usize,
    },
    GetSettings,
    UpdateSettings {
        settings: DaemonSettings,
    },
    /// Tide provider management. The embedded Tide provider reads its
    /// catalog from the user's tide config; these commands are the only
    /// sanctioned way to edit it, mirroring tide's own provider screens.
    TideProviders,
    TideAddProvider {
        name: String,
        api_style: String,
        base_url: String,
        api_key: Option<String>,
        models: Vec<TideModelWire>,
    },
    TideUpdateProvider {
        provider_id: String,
        name: Option<String>,
        api_style: Option<String>,
        base_url: Option<String>,
        enabled: Option<bool>,
        /// `Some` replaces the stored key (empty string clears it).
        api_key: Option<String>,
        models: Option<Vec<TideModelWire>>,
    },
    TideDeleteProvider {
        provider_id: String,
    },
    /// Fetch the live model list from a provider's `/models` endpoint using
    /// the given credentials, exactly like tide's add-provider wizard.
    TideProbeModels {
        api_style: String,
        base_url: String,
        api_key: String,
    },
    /// Race OpenAI-style and Anthropic-style `/models` probes against a base
    /// URL; OpenAI wins ties. This is both the wizard's Continue gate and
    /// its Auto-Detect Protocol button.
    TideDetectProtocol {
        base_url: String,
        api_key: String,
    },
    /// POST a minimal completion to prove the credentials work end to end.
    TideTestConnection {
        api_style: String,
        base_url: String,
        api_key: String,
        model_id: String,
    },
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
    /// Per-task background-model override ("title" | "commit-message").
    /// Both ids present sets the override; both absent clears it (fall back
    /// to the session's model). The provider id names a tide provider.
    UpdateBackgroundModel {
        task: String,
        provider_id: Option<String>,
        model_id: Option<String>,
    },
    /// Memory & RAG (the vendored rag crate behind the memory tool).
    /// Projects are the workspace identity: ids are app.db project ids.
    RagStatus {
        project_id: String,
    },
    RagEnableWorkspace {
        project_id: String,
    },
    RagDisableWorkspace {
        project_id: String,
    },
    RagInitWorkspace {
        project_id: String,
    },
    SourcesList,
    SourcesAdd {
        name: String,
        /// url | docs | crawl | repo
        kind: String,
        location: String,
    },
    SourcesRemove {
        source_id: String,
    },
    SourcesReindex {
        source_id: String,
    },
    SourcesSetEnabled {
        source_id: String,
        /// ["*"] = every workspace/project
        enabled: Vec<String>,
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
    ProbeComputerPermissions {
        prompt: bool,
    },
    LoadUsageHistory {
        window: UsageWindow,
        project_roots: Vec<PathBuf>,
    },
    LoadSkills {
        projects: Vec<(String, PathBuf)>,
    },
    SetSkillsEnabled {
        dirs: Vec<PathBuf>,
        enabled: bool,
    },
    TrashSkills {
        dirs: Vec<PathBuf>,
    },
    LoadTaskState,
    SaveTaskState {
        projects: Vec<Project>,
        live_session_ids: Vec<Uuid>,
        sessions: Vec<AgentSession>,
    },
    /// Explicitly remove one daemon-owned task. Ordinary state saves are
    /// merge-only so a stale client snapshot cannot delete tasks another
    /// client just created.
    RemoveSession,
    HydrateSession {
        session_id: Uuid,
    },
    SearchSessionMessages {
        query: String,
        limit: usize,
    },
    LoadComposerDrafts,
    SaveComposerDrafts {
        drafts: ComposerDrafts,
        generation: u64,
    },
    ApplyComposerDraftChanges {
        changes: Vec<ComposerDraftChange>,
    },
    StoreBlob {
        mime_type: String,
        #[serde(with = "base64_bytes")]
        #[ts(type = "string")]
        bytes: Vec<u8>,
    },
    ImportAttachment {
        name: String,
        upload: AttachmentUpload,
    },
    ImportPathAttachment {
        #[ts(type = "string")]
        path: PathBuf,
    },
    ReadBlob {
        reference: String,
    },
    ReadAttachment {
        reference: String,
        path: PathBuf,
    },
    SweepBlobs,
    /// Fork a persisted task through one completed provider turn.
    ///
    /// This is intentionally a daemon-owned operation: provider-native
    /// conversation state, Git checkpoint refs, and SQLite all live on the
    /// daemon host and must move together for remote clients.
    ForkSessionFromResponse {
        turn_count: usize,
    },
    /// Restore a task and its provider conversation to immediately before a
    /// prior user message. The client can then submit the edited replacement
    /// as an ordinary new turn.
    RewindSessionToMessage {
        turn_count: usize,
    },
    Workspace {
        operation: WorkspaceOperation,
    },
    OpenTerminal {
        #[ts(type = "string")]
        cwd: PathBuf,
        cols: u16,
        rows: u16,
    },
    WriteTerminal {
        #[serde(with = "base64_bytes")]
        #[ts(type = "string")]
        data: Vec<u8>,
    },
    ResizeTerminal {
        cols: u16,
        rows: u16,
    },
    CloseTerminal,
    CloseSession,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WireDriverStartOptions {
    pub provider: String,
    pub binary: PathBuf,
    pub cwd: PathBuf,
    pub mode: String,
    pub interaction_mode: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub context_window: Option<String>,
    pub agent_preset: Option<String>,
    pub computer_use_enabled: bool,
    pub provider_cursor: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WireSessionOptions {
    pub mode: String,
    pub interaction_mode: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub context_window: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WireComputerToolRequest {
    pub call_id: String,
    pub tool: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WireDriverEvent {
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

impl WireDriverEvent {
    pub fn new(kind: impl Into<String>, payload: Value) -> Self {
        Self {
            kind: kind.into(),
            payload,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SequencedEvent {
    pub session_id: Uuid,
    pub runtime_id: Uuid,
    /// Changes whenever the daemon restarts, so a reused runtime id can begin
    /// again at sequence one without being mistaken for an old event.
    pub epoch: Uuid,
    pub sequence: u64,
    pub event: WireDriverEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    Hello {
        protocol_version: u32,
        daemon_version: String,
    },
    Rejected {
        message: String,
    },
    Response {
        request_id: Uuid,
        outcome: ResponseOutcome,
    },
    Event(SequencedEvent),
    /// The daemon-owned project/task catalog changed through another client.
    /// Clients should invalidate their lightweight task-state snapshot; live
    /// runtime events continue through [`Self::Event`].
    TaskStateChanged {
        revision: u64,
    },
    ShuttingDown,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResponseOutcome {
    Ok { payload: ResponsePayload },
    Error { error: RpcError },
}

/// Everything the Memory & RAG settings card shows for one project.
/// The daemon's rag service produces it; the app only renders.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RagStatusWire {
    pub project_id: String,
    pub enabled: bool,
    pub local_model_available: bool,
    pub cloud_configured: bool,
    /// "ready" | "downloading" | "not-downloaded" | "failed"
    pub model_download: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_download_error: Option<String>,
    pub chunk_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ingested_at: Option<i64>,
    /// "never" | "running" | "done"
    pub init_state: String,
    pub embedder_id: String,
    /// Live indexing progress while init_state is running (and the last
    /// failed attempt, carrying its error, until the next run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_progress: Option<InitProgressWire>,
}

/// Live workspace-indexing progress riding the status (the poll's payload):
/// phase-labeled, determinate during embedding.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InitProgressWire {
    /// "walking" | "chunking" | "embedding" | "done" | "failed"
    pub phase: String,
    pub files_seen: u64,
    pub chunks_total: u64,
    pub chunks_embedded: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Live ingestion progress for one knowledge source.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceProgressWire {
    /// "fetching" | "chunking" | "embedding" | "done" | "failed"
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunks_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunks_embedded: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One knowledge source row (url / docs / crawl / repo — plus the
/// agent-memory pseudo-source) as the settings list renders it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSourceWire {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub location: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_indexed_at: Option<i64>,
    /// "idle" | "queued" | "indexing" | "error"
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub chunk_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedder_id: Option<String>,
    pub enabled_workspace_ids: Vec<String>,
    /// Live ingestion progress while status is queued/indexing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<SourceProgressWire>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResponsePayload {
    Ack,
    SessionRuntime {
        runtime_id: Option<Uuid>,
        supports_steer: bool,
    },
    Started {
        supports_steer: bool,
    },
    OptionsApplied {
        applied: bool,
    },
    Cursor {
        cursor: Option<Value>,
    },
    Settings {
        settings: DaemonSettings,
    },
    TideProviders {
        providers: Vec<TideProviderWire>,
    },
    TideModels {
        models: Vec<TideModelWire>,
    },
    TideProtocol {
        /// `"openai"` or `"anthropic"` on success.
        api_style: Option<String>,
        error: Option<String>,
    },
    TideConnection {
        ok: bool,
        error: Option<String>,
    },
    GitSnapshot {
        snapshot: GitSnapshotWire,
    },
    RagStatus {
        status: RagStatusWire,
    },
    RagInit {
        ok: bool,
        started_at: Option<i64>,
        error: Option<String>,
    },
    Sources {
        sources: Vec<KnowledgeSourceWire>,
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
    ComputerPermissions {
        permissions: ComputerPermissions,
    },
    UsageHistory {
        history: UsageHistory,
    },
    SkillsCatalog {
        catalog: SkillsCatalog,
    },
    TaskState {
        projects: Vec<Project>,
        sessions: Vec<AgentSession>,
        default_cwd: PathBuf,
        projectless_root: Option<PathBuf>,
    },
    TaskStateSaved {
        sessions: Vec<AgentSession>,
    },
    Session {
        session: Option<AgentSession>,
    },
    SessionMessageMatches {
        matches: Vec<SessionMessageMatch>,
    },
    ComposerDrafts {
        drafts: ComposerDrafts,
    },
    BlobStored {
        reference: String,
        path: PathBuf,
    },
    AttachmentStored {
        attachment: StoredAttachment,
    },
    BlobData {
        #[serde(with = "base64_bytes")]
        #[ts(type = "string")]
        bytes: Vec<u8>,
    },
    SessionForked {
        session: AgentSession,
        checkpoint_warning: Option<String>,
    },
    SessionRewound {
        session: AgentSession,
        cleanup_warning: Option<String>,
    },
    Workspace {
        result: WorkspaceResult,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct RpcError {
    pub message: String,
}

impl From<anyhow::Error> for RpcError {
    fn from(error: anyhow::Error) -> Self {
        Self {
            message: error.to_string(),
        }
    }
}

mod base64_bytes {
    use base64::Engine as _;
    use serde::{Deserialize as _, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_payloads_use_base64_json_strings() {
        let payload = ResponsePayload::BlobData {
            bytes: vec![0, 1, 2, 255],
        };
        let json = serde_json::to_value(&payload).unwrap();

        assert_eq!(json["bytes"], "AAEC/w==");
        let ResponsePayload::BlobData { bytes } = serde_json::from_value(json).unwrap() else {
            panic!("unexpected payload variant");
        };
        assert_eq!(bytes, vec![0, 1, 2, 255]);

        let command = Command::WriteTerminal {
            data: vec![0, 1, 2, 255],
        };
        let json = serde_json::to_value(&command).unwrap();
        assert_eq!(json["type"], "writeTerminal");
        assert_eq!(json["data"], "AAEC/w==");
        let Command::WriteTerminal { data } = serde_json::from_value(json).unwrap() else {
            panic!("unexpected command variant");
        };
        assert_eq!(data, vec![0, 1, 2, 255]);
    }

    #[test]
    fn response_fork_command_uses_stable_camel_case_fields() {
        let json =
            serde_json::to_value(Command::ForkSessionFromResponse { turn_count: 7 }).unwrap();

        assert_eq!(json["type"], "forkSessionFromResponse");
        assert_eq!(json["turnCount"], 7);
        assert_eq!(PROTOCOL_VERSION, 7);
    }

    #[test]
    fn message_rewind_command_uses_stable_camel_case_fields() {
        let json = serde_json::to_value(Command::RewindSessionToMessage { turn_count: 4 }).unwrap();

        assert_eq!(json["type"], "rewindSessionToMessage");
        assert_eq!(json["turnCount"], 4);
        assert_eq!(PROTOCOL_VERSION, 7);
    }

    #[test]
    fn handshake_and_replay_field_names_are_stable() {
        let session_id = Uuid::nil();
        let runtime_id = Uuid::from_u128(1);
        let message = ClientMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            token: "secret".into(),
            client_id: Uuid::from_u128(2),
            resume_from: vec![ReplayCursor {
                session_id,
                runtime_id,
                epoch: Uuid::from_u128(3),
                sequence: 9,
            }],
        };
        let json = serde_json::to_value(message).unwrap();

        assert_eq!(json["type"], "hello");
        assert_eq!(json["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(json["resumeFrom"][0]["sessionId"], session_id.to_string());
        assert_eq!(json["resumeFrom"][0]["runtimeId"], runtime_id.to_string());
        assert_eq!(
            json["resumeFrom"][0]["epoch"],
            Uuid::from_u128(3).to_string()
        );
        assert!(json.get("protocol_version").is_none());
    }

    #[test]
    fn composer_draft_changes_have_stable_wire_keys() {
        let project_id = Uuid::from_u128(7);
        let command = Command::ApplyComposerDraftChanges {
            changes: vec![ComposerDraftChange {
                target: crate::persistence::ComposerDraftTarget::NewSession { project_id },
                draft: Some(crate::persistence::ComposerDraft {
                    text: "unfinished".into(),
                    attachments: Vec::new(),
                }),
            }],
        };
        let json = serde_json::to_value(command).unwrap();

        assert_eq!(json["type"], "applyComposerDraftChanges");
        assert_eq!(json["changes"][0]["target"]["type"], "newSession");
        assert_eq!(
            json["changes"][0]["target"]["projectId"],
            project_id.to_string()
        );
        assert_eq!(json["changes"][0]["draft"]["text"], "unfinished");
    }
}
