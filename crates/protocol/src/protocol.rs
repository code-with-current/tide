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
use crate::model::{
    AgentSession, BackgroundWorkItem, GoalOperation, Project, ProjectAction, ProjectIcon,
    ProviderKind, UserInputAnswer,
};
use crate::persistence::{ComposerDraftChange, ComposerDrafts, SessionMessageMatch};
use crate::settings::DaemonSettings;
use crate::skills::SkillsCatalog;
use crate::tide::{TideModelWire, TideProviderWire};
use crate::usage_history::UsageHistory;
use crate::usage_report::{UsageReport, UsageWindow};
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
    /// Global Memory & RAG configuration (the settings page's model
    /// picker / retrieval / advanced cards).
    RagConfigGet,
    /// Merge a partial settings update; the reply lists workspaces whose
    /// indexes no longer match (embedder or chunking changed) so the UI
    /// can offer a rebuild.
    RagConfigUpdate {
        patch: RagConfigPatchWire,
    },
    /// The local model catalog joined with on-disk download state.
    RagModelsList,
    RagModelDownload {
        model_id: String,
    },
    /// Returns affected indexes before/after deleting — vendored models
    /// are refused.
    RagModelDelete {
        model_id: String,
    },
    /// Probes the endpoint with one test embedding (measuring dims)
    /// BEFORE anything is persisted; upstream errors surface verbatim.
    RagEndpointAdd {
        name: String,
        base_url: String,
        model_id: String,
        api_key: String,
        max_tokens: Option<u64>,
    },
    RagEndpointSetKey {
        endpoint_id: String,
        api_key: String,
    },
    /// Returns affected indexes if any still use the endpoint.
    RagEndpointRemove {
        endpoint_id: String,
    },
    SourcesList,
    SourcesAdd {
        name: String,
        /// url | docs | crawl | repo
        kind: String,
        location: String,
        /// None = global knowledge; Some = scoped to one project id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
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
    /// Ensure the Knowledge Library source row and its `<data>/library`
    /// directory exist (idempotent — the settings card calls it on open,
    /// so the row is present before anything is clicked). The reply
    /// carries the source id, the registry's doc count, and the
    /// daemon-side root path so the card never guesses the location.
    LibraryEnsure,
    /// Install the `/kb-*` slash-command pack into the user's commands
    /// dir (idempotent, never overwrites existing bodies). The reply
    /// counts how many were written — 0 means everything was already
    /// present.
    KnowledgeInstallCommands,
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
        window: crate::usage_history::UsageWindow,
        project_roots: Vec<PathBuf>,
    },
    LoadUsageReport {
        window: UsageWindow,
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
    /// Drop a project from the app. With `delete_history`, its sessions and
    /// their messages/transcripts are removed too.
    RemoveProject {
        project_id: Uuid,
        delete_history: bool,
    },
    /// The session's action jobs (registry poll — events need a runtime).
    ListActionJobs {
        session_id: String,
    },
    /// Run a project action as a background job owned by the session:
    /// the orchestrator can list/probe it with job_list/job_output. Output
    /// is file-backed and the run record persists, so a restarted daemon
    /// re-adopts a still-running process into the same session.
    RunAction {
        session_id: String,
        project_id: String,
        project_path: String,
        action_name: String,
        command: String,
    },
    /// Stop a running action job: SIGINT the group, SIGKILL on timeout.
    StopAction {
        session_id: String,
        job_id: String,
    },
    /// Persist one project's settings. The daemon replies with a fresh
    /// task-state snapshot; clients stage edits optimistically and reconcile
    /// when it lands.
    UpdateProjectSettings {
        project_id: Uuid,
        name: String,
        icon: ProjectIcon,
        icon_color: Option<String>,
        default_provider: Option<ProviderKind>,
        default_model: Option<String>,
        actions: Vec<ProjectAction>,
    },
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
    /// Aggregate-byte percent while downloading (absent until the size
    /// HEAD pass finishes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_download_percent: Option<u32>,
    pub chunk_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ingested_at: Option<i64>,
    /// "never" | "running" | "done"
    pub init_state: String,
    /// The embedder the index is locked to (its embedding plan); the
    /// configured default when no index exists yet.
    pub embedder_id: String,
    /// The index's plan differs from the configured model/chunking —
    /// a rebuild is required to pick the configuration up.
    #[serde(default)]
    pub plan_stale: bool,
    /// Live indexing progress while init_state is running (and the last
    /// failed attempt, carrying its error, until the next run).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_progress: Option<InitProgressWire>,
}

/// The effective global RAG settings (no secrets).
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RagConfigWire {
    pub embedder_id: String,
    pub cloud_allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_model_id: Option<String>,
    pub top_k: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_similarity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_overlap: Option<u64>,
    pub rerank_enabled: bool,
    pub inline_knowledge_chars: u64,
    pub knowledge_block_flagged: bool,
    /// Reranker model files: "ready" | "downloading" | "failed" |
    /// "not-downloaded". Rides the config snapshot because the settings
    /// page re-reads config after every action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reranker_download: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reranker_download_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reranker_download_percent: Option<u32>,
}

/// A partial settings update — `None` fields keep their stored value.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RagConfigPatchWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedder_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_allowed: Option<bool>,
    /// Empty string clears the stored value; absent keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_similarity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_overlap: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerank_enabled: Option<bool>,
    /// 0 disables knowledge inlining.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_knowledge_chars: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge_block_flagged: Option<bool>,
}

/// A custom embeddings endpoint. The key never rides back — only whether
/// one is stored.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RagEndpointWire {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model_id: String,
    pub dims: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    pub has_key: bool,
}

/// One catalog local model joined with its on-disk state. `name` is the
/// original HuggingFace repo — the user-facing display string.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RagModelWire {
    pub id: String,
    pub name: String,
    pub dims: usize,
    pub max_tokens: u64,
    /// "en" | "multilingual"
    pub languages: String,
    pub vendored: bool,
    pub downloaded: bool,
    pub download_size: u64,
    /// "ready" | "downloading" | "not-downloaded" | "failed"
    pub download_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_error: Option<String>,
    /// Aggregate-byte percent while downloading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download_percent: Option<u32>,
}

/// An index left behind by a settings change (or a delete) — the rebuild
/// dialog's rows. `project_id` is `"*"` for the global knowledge index.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RagAffectedWorkspaceWire {
    pub project_id: String,
    /// The embedder the index is currently locked to.
    pub built_with: String,
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
    /// Injection screen verdict: "clean" | "flagged" (always present on
    /// post-screening rows; absent → never screened).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injection: Option<String>,
    /// First screen findings when flagged ("rule: snippet" lines).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injection_detail: Option<String>,
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
    RagConfig {
        config: RagConfigWire,
        endpoints: Vec<RagEndpointWire>,
        cloud_configured: bool,
    },
    RagAffected {
        workspaces: Vec<RagAffectedWorkspaceWire>,
    },
    RagModels {
        models: Vec<RagModelWire>,
    },
    RagEndpoint {
        endpoint: RagEndpointWire,
    },
    RagInit {
        ok: bool,
        started_at: Option<i64>,
        error: Option<String>,
    },
    Sources {
        sources: Vec<KnowledgeSourceWire>,
    },
    /// The Knowledge Library card state (the `LibraryEnsure` reply):
    /// which source row is the library, how many docs the registry
    /// holds, and where the library root lives on the daemon's disk.
    Library {
        source_id: String,
        doc_count: u32,
        root: PathBuf,
    },
    /// The `/kb-*` command pack install result: how many command bodies
    /// were written (0 = every command was already installed).
    KbCommands {
        installed: u32,
    },
    /// The session's background action jobs (client polls; registry events
    /// require an attached runtime). `runs` maps each job back to its
    /// project + action so a freshly started UI can seed its row state.
    ActionJobs {
        jobs: Vec<BackgroundWorkItem>,
        runs: Vec<crate::model::ActionRunWire>,
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
    UsageReport {
        report: UsageReport,
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
    fn remove_project_round_trips_with_history_flag() {
        let command = Command::RemoveProject {
            project_id: "0194883a-0000-7000-8000-000000000001"
                .parse::<Uuid>()
                .unwrap(),
            delete_history: true,
        };
        let json = serde_json::to_value(&command).unwrap();

        assert_eq!(json["type"], "removeProject");
        assert_eq!(json["projectId"], "0194883a-0000-7000-8000-000000000001");
        assert_eq!(json["deleteHistory"], true);

        let Command::RemoveProject {
            project_id,
            delete_history,
        } = serde_json::from_value(json).unwrap()
        else {
            panic!("unexpected command variant");
        };
        assert_eq!(
            project_id,
            "0194883a-0000-7000-8000-000000000001"
                .parse::<Uuid>()
                .unwrap()
        );
        assert!(delete_history);
    }

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
    fn library_commands_round_trip_with_camel_case_fields() {
        assert_eq!(
            serde_json::to_value(Command::LibraryEnsure).unwrap()["type"],
            "libraryEnsure"
        );
        assert_eq!(
            serde_json::to_value(Command::KnowledgeInstallCommands).unwrap()["type"],
            "knowledgeInstallCommands"
        );

        let payload = ResponsePayload::Library {
            source_id: "src-1".into(),
            doc_count: 3,
            root: PathBuf::from("/data/library"),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["type"], "library");
        assert_eq!(json["sourceId"], "src-1");
        assert_eq!(json["docCount"], 3);
        assert_eq!(json["root"], "/data/library");
        let ResponsePayload::Library {
            source_id,
            doc_count,
            root,
        } = serde_json::from_value(json).unwrap()
        else {
            panic!("unexpected payload variant");
        };
        assert_eq!(source_id, "src-1");
        assert_eq!(doc_count, 3);
        assert_eq!(root, PathBuf::from("/data/library"));

        let payload = ResponsePayload::KbCommands { installed: 2 };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["type"], "kbCommands");
        assert_eq!(json["installed"], 2);
        let ResponsePayload::KbCommands { installed } = serde_json::from_value(json).unwrap()
        else {
            panic!("unexpected payload variant");
        };
        assert_eq!(installed, 2);
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
