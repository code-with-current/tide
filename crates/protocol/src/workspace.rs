use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::composer::{FileEntry, SlashCommand};
use crate::git::{AgentInvocation, BranchSnapshot, CommitSnapshot, CreatedWorktree};
use crate::git_panel::{
    PanelAheadBehind, PanelBranchInfo, PanelCommit, PanelCommitResult, PanelConflict,
    PanelCurrentIdentity, PanelDiffHunk, PanelFileChange, PanelMergeResult, PanelOpResult,
    PanelRevertResult, PanelStash,
};
use crate::model::{Checkpoint, ProviderKind};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ReviewDiffSource {
    LastTurn {
        session_id: Uuid,
        turn_id: Uuid,
        turn_count: usize,
    },
    Uncommitted,
    Unstaged,
    Staged,
    Committed,
    Branch,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffData {
    pub source: ReviewDiffSource,
    pub numstat: String,
    pub patch: String,
    pub complete_context: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeEntry {
    pub relative_path: String,
    #[ts(type = "string")]
    pub absolute_path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    pub expanded: bool,
    pub depth: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkspaceOperation {
    ListTree {
        #[ts(type = "string")]
        root: PathBuf,
        #[ts(type = "string[]")]
        expanded_paths: Vec<PathBuf>,
    },
    BrowseDirectory {
        #[ts(type = "string | null")]
        path: Option<PathBuf>,
    },
    ReadTextFile {
        #[ts(type = "string")]
        root: PathBuf,
        #[ts(type = "string")]
        relative_path: PathBuf,
    },
    WriteTextFile {
        #[ts(type = "string")]
        root: PathBuf,
        #[ts(type = "string")]
        relative_path: PathBuf,
        content: String,
    },
    ListProjectFiles {
        #[ts(type = "string")]
        root: PathBuf,
        cap: usize,
    },
    DiscoverSlashCommands {
        provider: ProviderKind,
        #[ts(type = "string")]
        project_root: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binary_override: Option<String>,
    },
    CreateProjectlessWorkspace {
        prompt: Option<String>,
    },
    MigrateProjectlessWorkspace {
        #[ts(type = "string")]
        path: PathBuf,
    },
    InspectBranches {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    CheckoutBranch {
        #[ts(type = "string")]
        cwd: PathBuf,
        branch: String,
        create: bool,
        /// Where to branch from / check out instead of the current HEAD:
        /// with `create` it is `git switch -c <branch> <start_point>`;
        /// without it, a detached `git switch --detach <start_point>`.
        /// `None` keeps the plain branch-name behavior.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_point: Option<String>,
    },
    CreateWorktree {
        #[ts(type = "string")]
        project_path: PathBuf,
        project_id: Uuid,
        session_id: Uuid,
        prompt: String,
        base_branch: Option<String>,
    },
    InspectCommit {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    GenerateCommitMessage {
        #[ts(type = "string")]
        cwd: PathBuf,
        include_unstaged: bool,
        invocation: AgentInvocation,
    },
    /// Generates a session title from the first user message using the
    /// background-model invocation.
    GenerateSessionTitle {
        #[ts(type = "string")]
        cwd: PathBuf,
        first_message: String,
        invocation: AgentInvocation,
    },
    Commit {
        #[ts(type = "string")]
        cwd: PathBuf,
        message: String,
        include_unstaged: bool,
        push: bool,
    },
    Push {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    CaptureTurnStart {
        #[ts(type = "string")]
        cwd: PathBuf,
        session_id: Uuid,
        turn_count: usize,
    },
    CaptureTurn {
        #[ts(type = "string")]
        cwd: PathBuf,
        session_id: Uuid,
        turn_count: usize,
    },
    CaptureRef {
        #[ts(type = "string")]
        cwd: PathBuf,
        git_ref: String,
    },
    RestoreRef {
        #[ts(type = "string")]
        cwd: PathBuf,
        git_ref: String,
    },
    HasRef {
        #[ts(type = "string")]
        cwd: PathBuf,
        git_ref: String,
    },
    SessionTurnRefs {
        #[ts(type = "string")]
        cwd: PathBuf,
        session_id: Uuid,
    },
    DeleteRef {
        #[ts(type = "string")]
        cwd: PathBuf,
        git_ref: String,
    },
    DeleteTurnRefsAfter {
        #[ts(type = "string")]
        cwd: PathBuf,
        session_id: Uuid,
        retained_turn_count: usize,
        previous_turn_count: usize,
    },
    DeleteSessionRefs {
        #[ts(type = "string")]
        cwd: PathBuf,
        session_id: Uuid,
    },
    CopySessionRefs {
        #[ts(type = "string")]
        cwd: PathBuf,
        source_session_id: Uuid,
        target_session_id: Uuid,
        through_turn_count: usize,
    },
    CollectReviewDiff {
        #[ts(type = "string")]
        cwd: PathBuf,
        source: ReviewDiffSource,
    },
    /// Lists the working-tree status of the repository at `cwd`.
    InspectGitStatus {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    /// Computes the diff of a single file, staged or unstaged.
    GitFileDiff {
        #[ts(type = "string")]
        cwd: PathBuf,
        path: String,
        staged: bool,
        context_lines: u32,
    },
    /// Lists recent commits from the repository at `cwd`.
    GitLog {
        #[ts(type = "string")]
        cwd: PathBuf,
        limit: u32,
    },
    /// Lists the files changed by a specific commit.
    GitCommitFiles {
        #[ts(type = "string")]
        cwd: PathBuf,
        sha: String,
    },
    /// Computes the diff of a single file within a specific commit.
    GitCommitFileDiff {
        #[ts(type = "string")]
        cwd: PathBuf,
        sha: String,
        path: String,
    },
    /// Returns the full commit message of a specific commit.
    GitCommitMessage {
        #[ts(type = "string")]
        cwd: PathBuf,
        sha: String,
    },
    /// Runs a bulk working-tree operation; `op` is one of
    /// `stage-all`, `unstage-all`, `restore-all`, `stash`, or `stash-pop`.
    GitBulk {
        #[ts(type = "string")]
        cwd: PathBuf,
        op: String,
        message: Option<String>,
    },
    /// Lists the stash entries of the repository at `cwd`.
    GitStashList {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    /// Stages or unstages a single file.
    GitStageFile {
        #[ts(type = "string")]
        cwd: PathBuf,
        path: String,
        stage: bool,
    },
    /// Discards the working-tree changes of a single file.
    GitDiscardFile {
        #[ts(type = "string")]
        cwd: PathBuf,
        path: String,
    },
    /// Restores a single file to its contents in a specific commit.
    GitRestoreFileFrom {
        #[ts(type = "string")]
        cwd: PathBuf,
        path: String,
        sha: String,
    },
    /// Amends the current commit, optionally with a new message.
    GitAmend {
        #[ts(type = "string")]
        cwd: PathBuf,
        message: Option<String>,
    },
    /// Reverts a specific commit.
    GitRevert {
        #[ts(type = "string")]
        cwd: PathBuf,
        sha: String,
    },
    /// Reports how far the current branch is ahead/behind its upstream.
    GitAheadBehind {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    /// Reports the current branch, HEAD commit, and upstream of `cwd`.
    GitBranchInfo {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    /// Lists recently checked-out branches, most recent first.
    GitRecentBranches {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    /// Merges the named branch into the current branch.
    GitMerge {
        #[ts(type = "string")]
        cwd: PathBuf,
        name: String,
    },
    /// Lists the unmerged conflict paths of the repository at `cwd`.
    GitConflictFiles {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    /// Resolves a conflicted file by taking one side; `side` is `ours` or `theirs`.
    GitResolveFile {
        #[ts(type = "string")]
        cwd: PathBuf,
        path: String,
        side: String,
    },
    /// Fetches from the remote of the repository at `cwd`.
    GitFetch {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    /// Pulls from the upstream of the current branch.
    GitPull {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    /// Resolves the identity the next commit at `cwd` would use, with the
    /// matching profile id when the resolved pair equals a stored profile.
    GitCurrentIdentity {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkspaceResult {
    Ack,
    WorkingTree {
        entries: Vec<WorkingTreeEntry>,
    },
    Directory {
        #[ts(type = "string")]
        path: PathBuf,
        #[ts(type = "string | null")]
        parent: Option<PathBuf>,
        #[ts(type = "string")]
        home: PathBuf,
        #[ts(type = "string")]
        filesystem_root: PathBuf,
        entries: Vec<WorkingTreeEntry>,
    },
    TextFile {
        content: String,
    },
    ProjectFiles {
        entries: Vec<FileEntry>,
    },
    SlashCommands {
        commands: Vec<SlashCommand>,
    },
    ProjectlessWorkspace {
        #[ts(type = "string")]
        cwd: PathBuf,
    },
    Branches {
        snapshot: Option<BranchSnapshot>,
    },
    BranchChanged {
        snapshot: BranchSnapshot,
    },
    WorktreeCreated {
        worktree: CreatedWorktree,
    },
    CommitSnapshot {
        snapshot: CommitSnapshot,
    },
    CommitMessage {
        message: String,
    },
    Checkpoint {
        checkpoint: Checkpoint,
    },
    Bool {
        value: bool,
    },
    TurnRefs {
        turn_counts: Vec<usize>,
    },
    ReviewDiff {
        data: ReviewDiffData,
    },
    /// Working-tree status for the git panel.
    GitStatus {
        changes: Vec<PanelFileChange>,
    },
    /// Diff hunks for a single file, working tree or a specific commit.
    GitDiff {
        hunks: Vec<PanelDiffHunk>,
    },
    /// Recent commits for the git panel.
    GitLog {
        commits: Vec<PanelCommit>,
    },
    /// Free-form text payload for the git panel (e.g. a commit message).
    GitText {
        text: String,
    },
    /// Outcome of a fire-and-forget git panel operation.
    GitOp {
        result: PanelOpResult,
    },
    /// Stash entries for the git panel.
    GitStashes {
        stashes: Vec<PanelStash>,
    },
    /// Outcome of an amend or commit.
    GitCommitDone {
        result: PanelCommitResult,
    },
    /// Outcome of a revert.
    GitRevertDone {
        result: PanelRevertResult,
    },
    /// Ahead/behind counts versus upstream, if an upstream exists.
    GitAheadBehind {
        ahead_behind: Option<PanelAheadBehind>,
    },
    /// Current branch information for the git panel.
    GitBranchInfoDone {
        info: PanelBranchInfo,
    },
    /// Recently used branch names.
    GitBranches {
        branches: Vec<String>,
    },
    /// Outcome of a merge.
    GitMergeDone {
        result: PanelMergeResult,
    },
    /// Unmerged conflict entries for the git panel.
    GitConflicts {
        conflicts: Vec<PanelConflict>,
    },
    /// The identity the next commit at the requested path would use.
    GitCurrentIdentityDone {
        identity: PanelCurrentIdentity,
    },
}
