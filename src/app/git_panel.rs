//! State and data plumbing for the right-panel Git surface — the port of
//! tide's git panel. Rendering lives in `right_panel.rs`; this module owns
//! what the renderer reads: the per-section query states, the generation
//! that guards every async result, and the refresh cadence.
//!
//! Nothing here runs on the render path. `refresh_git_panel` spawns one
//! background pass over the daemon's git-panel operations, stores the
//! results on the entity, and notifies; a slow pass is discarded by the
//! generation counter if a newer refresh (or a session switch) started.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use gpui::{App, AppContext, Context, Entity, KeyBinding, Window, actions, px};
use protocol::git_panel::{
    PanelAheadBehind, PanelBranchInfo, PanelCommit, PanelConflict, PanelCurrentIdentity,
    PanelDiffHunk, PanelFileChange, PanelStash,
};

use crate::Tide;
use crate::input::TextInput;
use crate::query::Query;
use crate::review_diff::{self, Snapshot as ReviewDiffSnapshot, Source as ReviewDiffSource};

use super::git_history::{self, HistoryGraph};

/// The panel's two tabs, mirroring tide's git panel.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum GitPanelTab {
    #[default]
    Changes,
    History,
}

/// A section's read state. The app's [`Query`] is keyed by a cache key; the
/// git panel is push-refreshed rather than cache-read, so the key unit is
/// fixed and only `Pending`/`Ready` are ever constructed — a miss always
/// means "loading", never "you must fetch from render".
pub(crate) type GitQuery<V> = Query<(), V>;

/// The selected file's diff, loaded on demand for the Changes tab.
pub(crate) struct SelectedFileDiff {
    pub path: String,
    pub staged: bool,
    /// Where the current hunks came from on tide's context ladder. A gap
    /// click escalates to the next rung and refetches, rather than revealing
    /// rows retained client-side.
    pub context_lines: u32,
    pub hunks: GitQuery<Vec<PanelDiffHunk>>,
    /// The hunks converted to the render-ready model, rebuilt whenever hunks
    /// land. Kept while an escalation is Pending so the sub-view does not
    /// flash back to a skeleton.
    pub snapshot: Option<Arc<ReviewDiffSnapshot>>,
    /// The change line (old/new numbers) the escalated refetch should
    /// re-anchor to once it lands; set from the gap the user expanded.
    pub anchor: Option<(Option<u32>, Option<u32>)>,
}

/// The "last turn" agent-review mode: the transcript's per-turn diff entry
/// points land here. The snapshot comes from the same `CollectReviewDiff`
/// pass the retired Review surface used, guarded by its own generation.
pub(crate) struct LastTurnReview {
    /// Always the `LastTurn` variant of [`ReviewDiffSource`].
    pub source: ReviewDiffSource,
    pub generation: u64,
    pub snapshot: Option<Arc<ReviewDiffSnapshot>>,
    pub loading: bool,
    pub error: Option<String>,
}

/// tide's expand-context ladder: each gap click widens to the next rung.
const EXPAND_CONTEXT_LADDER: [u32; 6] = [3, 12, 24, 48, 96, 200];
/// Values at or above this are the full-file sentinel the service passes
/// through unclamped.
const FULL_FILE_CONTEXT: u32 = 1000;

fn next_expand_context(current: u32) -> u32 {
    for rung in EXPAND_CONTEXT_LADDER {
        if rung > current {
            return rung;
        }
    }
    FULL_FILE_CONTEXT
}

/// The diff of one file within the commit the details sub-view shows,
/// fetched on click and expanded inline.
pub(crate) struct CommitFileDiff {
    pub path: String,
    pub hunks: GitQuery<Vec<PanelDiffHunk>>,
    pub snapshot: Option<Arc<ReviewDiffSnapshot>>,
}

/// The History tab's commit-details sub-view — port of tide's
/// `CommitDetailsPanel`. The commit's own facts (subject, author, parents,
/// tags) come from the loaded log; the two queries enrich it with the full
/// message body and the changed-file list.
pub(crate) struct CommitDetailView {
    pub sha: String,
    /// The full message; the subject line is stripped when it lands.
    pub message: GitQuery<String>,
    pub files: GitQuery<Vec<PanelFileChange>>,
    /// The file whose diff is expanded inline, if any.
    pub file_diff: Option<CommitFileDiff>,
}

/// Which stage of the per-row actions popover is showing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HistoryActionStage {
    Menu,
    /// The armed revert confirmation.
    Revert,
    /// The branch-name entry ("Branch from here…").
    Branch,
}

/// The History row whose "…" actions popover is open.
#[derive(Clone)]
pub(crate) struct HistoryRowAction {
    pub sha: String,
    pub stage: HistoryActionStage,
    /// Materialized on entering the Branch stage; `TextInput::new` needs a
    /// window, so it cannot live in the popover content render path.
    pub branch_input: Option<Entity<TextInput>>,
}

/// The commit draft in the Changes tab footer — port of tide's per-workspace
/// `commitDrafts` store. The two fields are `TextInput` entities created
/// once per workspace (the profile-dialog materialize pattern) and kept for
/// the life of the app, so a draft survives tab switches, refreshes, and
/// navigating away; `amend` rides alongside because it belongs to the draft
/// upstream too.
pub(crate) struct CommitDraft {
    pub summary: Entity<TextInput>,
    pub description: Entity<TextInput>,
    pub amend: bool,
}

/// The attribution trailer the next commit would carry, computed in the
/// refresh pass — the client-side mirror of tide's `attributionTrailer`,
/// never read from config on the render path.
fn commit_trailer_preview(identity: Option<&PanelCurrentIdentity>) -> Option<String> {
    let cfg = store::config::load(&store::paths::config_path()).ok()?;
    let general = cfg.general_settings.map(|g| g.effective())?;
    if !general.git_co_authored {
        return None;
    }
    if general.git_attribution_mode == "author" {
        // Author mode trails with the committing identity; without one there
        // is no trailer to preview.
        let identity = identity?;
        let name = identity.name.as_deref()?;
        let email = identity.email.as_deref()?;
        return Some(format!("Co-authored-by: {name} <{email}>"));
    }
    let name = if general.git_co_author_name.trim().is_empty() {
        "Tide".to_owned()
    } else {
        general.git_co_author_name.clone()
    };
    Some(format!(
        "Co-authored-by: {name} <{}>",
        general.git_co_author_email
    ))
}

/// Which of the Changes tab's two file sections a row belongs to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GitFileSection {
    Staged,
    Unstaged,
}

impl GitFileSection {
    /// The closed-directory and row keys are namespaced per section so a
    /// path staged and unstaged keeps independent tree state.
    pub(crate) fn key(self) -> &'static str {
        match self {
            GitFileSection::Staged => "staged",
            GitFileSection::Unstaged => "unstaged",
        }
    }
}

/// One renderable row of the Changes tab — the flattened union of the
/// conflict band and the staged/unstaged sections, built off the render
/// path by [`Tide::sync_git_panel_changes_rows`] and painted through the
/// panel's virtualized list.
#[derive(Clone, Debug)]
pub(crate) enum GitChangesRow {
    /// The danger-tinted header of the conflict band.
    ConflictHeader { count: usize },
    /// One conflicted path, with its resolve actions.
    ConflictFile { index: usize },
    /// A "Staged" / "Changes" collapsible header with its bulk actions.
    SectionHeader {
        section: GitFileSection,
        count: usize,
    },
    /// A directory row in tree mode; `key` already carries the section
    /// namespace, so the row needs no section of its own.
    Directory {
        key: String,
        name: String,
        depth: u32,
        file_count: usize,
    },
    /// One changed file, flat or as a tree leaf; `index` addresses the
    /// status query's change vector.
    File {
        section: GitFileSection,
        index: usize,
        depth: u32,
        show_path: bool,
    },
}

/// A directory node of the Changes tab's tree mode — the Rust port of
/// tide's `buildFileTree`/`countFiles` helpers.
struct GitDirNode {
    name: String,
    file_count: usize,
    dirs: Vec<GitDirNode>,
    files: Vec<usize>,
}

/// Builds one section's directory tree from the flat change list. Nested
/// dir nodes sort dirs-first then alphabetically; files alphabetically;
/// `indices` keeps each leaf pointing at its `PanelFileChange`.
fn build_git_file_tree(changes: &[PanelFileChange], indexes: &[usize]) -> GitDirNode {
    // A path trie built with sorted Vec children — the per-section change
    // list is small (it fits one git status), so linear insertion is fine
    // for a pass that already owns the background slot's aftermath.
    fn insert(root: &mut GitDirNode, parts: &[&str], index: usize) {
        if let Some((first, rest)) = parts.split_first() {
            if rest.is_empty() {
                root.files.push(index);
                return;
            }
            let slot = match root.dirs.iter().position(|dir| dir.name == *first) {
                Some(position) => position,
                None => {
                    root.dirs.push(GitDirNode {
                        name: (*first).to_owned(),
                        file_count: 0,
                        dirs: Vec::new(),
                        files: Vec::new(),
                    });
                    root.dirs.len() - 1
                }
            };
            insert(&mut root.dirs[slot], rest, index);
        }
    }
    fn sort_tree(node: &mut GitDirNode, changes: &[PanelFileChange]) -> usize {
        node.dirs.sort_by(|a, b| a.name.cmp(&b.name));
        node.files.sort_by(|left, right| {
            let basename = |index: &usize| changes[*index].path.rsplit('/').next().unwrap_or("");
            basename(left).cmp(basename(right))
        });
        let mut count = node.files.len();
        for dir in &mut node.dirs {
            count += sort_tree(dir, changes);
        }
        node.file_count = count;
        count
    }

    let mut root = GitDirNode {
        name: String::new(),
        file_count: 0,
        dirs: Vec::new(),
        files: Vec::new(),
    };
    for &index in indexes {
        let parts: Vec<&str> = changes[index].path.split('/').collect();
        insert(&mut root, &parts, index);
    }
    sort_tree(&mut root, changes);
    root
}

/// Flattens a tree into rows, skipping collapsed directories' subtrees.
/// `prefix` carries the slash-joined path of `node` so directory keys stay
/// stable across rebuilds.
fn push_tree_rows(
    rows: &mut Vec<GitChangesRow>,
    node: &GitDirNode,
    section: GitFileSection,
    prefix: &str,
    depth: u32,
    closed_dirs: &HashSet<String>,
) {
    for dir in &node.dirs {
        let path = if prefix.is_empty() {
            dir.name.clone()
        } else {
            format!("{prefix}/{}", dir.name)
        };
        let key = format!("{}:{path}", section.key());
        rows.push(GitChangesRow::Directory {
            key: key.clone(),
            name: dir.name.clone(),
            depth,
            file_count: dir.file_count,
        });
        if !closed_dirs.contains(&key) {
            push_tree_rows(rows, dir, section, &path, depth + 1, closed_dirs);
        }
    }
    for &index in &node.files {
        rows.push(GitChangesRow::File {
            section,
            index,
            depth,
            show_path: false,
        });
    }
}

#[allow(dead_code)] // tree_mode/busy/commit_drafts/stash_dialog_open are read by the rendering tasks
pub(crate) struct GitPanelState {
    pub tab: GitPanelTab,
    /// Tree vs flat list for the Changes tab; persisted at the app level
    /// with the other panel preferences.
    pub tree_mode: bool,
    /// The Changes tab's two collapsible sections, both open by default.
    pub staged_open: bool,
    pub unstaged_open: bool,
    /// Tree-mode directories the user has collapsed, keyed by
    /// "section:path" — the inverted set keeps every new directory open.
    pub closed_dirs: HashSet<String>,
    /// The unstaged file whose discard button is armed for confirmation.
    pub confirm_discard_file: Option<String>,
    /// Whether the Discard All action is armed for confirmation.
    pub confirm_discard_all: bool,
    pub status: GitQuery<Vec<PanelFileChange>>,
    pub conflicts: GitQuery<Vec<PanelConflict>>,
    pub branch_info: GitQuery<PanelBranchInfo>,
    pub ahead_behind: Option<PanelAheadBehind>,
    pub stashes: GitQuery<Vec<PanelStash>>,
    pub log: GitQuery<Vec<PanelCommit>>,
    /// The identity the next commit would use, refreshed with the panel
    /// pass (local user.name/email with global fallback, plus profile id).
    pub current_identity: GitQuery<PanelCurrentIdentity>,
    /// The attribution trailer preview for the commit bar, refreshed with
    /// the panel pass so render never touches the config file.
    pub trailer: Option<String>,
    /// Bumped by every refresh pass; a result whose generation no longer
    /// matches is dropped.
    pub generation: u64,
    /// Set while a refresh pass is in flight so the 5s timer tick can skip
    /// instead of stacking requests.
    pub refresh_in_flight: bool,
    /// Which panel operation ("commit", "fetch", …) is running, for the
    /// busy treatment in the footer.
    pub busy: Option<&'static str>,
    pub error: Option<String>,
    pub selected_file_diff: Option<SelectedFileDiff>,
    /// Guards the selected-file diff request: a result from a superseded
    /// selection or a superseded context width is dropped.
    pub selected_file_diff_generation: u64,
    /// The active "last turn" agent review, when the transcript (or the
    /// panel's own chip) opened one.
    pub last_turn_review: Option<LastTurnReview>,
    /// Commit drafts keyed by workspace path — one per project, surviving
    /// session switches and surface closes like tide's ui store.
    pub commit_drafts: HashMap<String, CommitDraft>,
    /// True while the AI commit-message generation is in flight.
    pub generating_message: bool,
    /// The just-committed sha, flashed on the primary button for 1.5s.
    pub flash_sha: Option<String>,
    /// Guards the flash timer: a newer flash (or a new commit) cancels the
    /// older timer's clear.
    pub flash_generation: u64,
    /// Guards the amend-prefill request: a toggle-off (or a second toggle)
    /// must not land the older HEAD message into the fields.
    pub amend_generation: u64,
    pub stash_dialog_open: bool,
    /// The History tab's precomputed lane graph, rebuilt whenever the log
    /// lands — never on a frame.
    pub history_graph: Option<Arc<HistoryGraph>>,
    /// The History tab's open commit-details sub-view.
    pub commit_detail: Option<CommitDetailView>,
    /// Guards the commit-detail enrichment request: a result from a
    /// superseded commit is dropped.
    pub commit_detail_generation: u64,
    /// Guards the commit-detail file-diff request the same way.
    pub commit_file_diff_generation: u64,
    /// The History row whose "…" actions popover is open.
    pub history_action: Option<HistoryRowAction>,
    /// Whether the history log has been loaded once — the Changes tab does
    /// not re-request it until History is opened.
    pub log_loaded: bool,
    /// Bumped whenever a timer chain starts; an older chain sees the bump
    /// and stops itself.
    pub timer_generation: u64,
}

impl Default for GitPanelState {
    fn default() -> Self {
        Self {
            tab: GitPanelTab::default(),
            tree_mode: true,
            staged_open: true,
            unstaged_open: true,
            closed_dirs: HashSet::new(),
            confirm_discard_file: None,
            confirm_discard_all: false,
            status: Query::Pending,
            conflicts: Query::Pending,
            branch_info: Query::Pending,
            ahead_behind: None,
            stashes: Query::Pending,
            log: Query::Pending,
            current_identity: Query::Pending,
            trailer: None,
            generation: 0,
            refresh_in_flight: false,
            busy: None,
            error: None,
            selected_file_diff: None,
            selected_file_diff_generation: 0,
            last_turn_review: None,
            commit_drafts: HashMap::new(),
            generating_message: false,
            flash_sha: None,
            flash_generation: 0,
            amend_generation: 0,
            stash_dialog_open: false,
            history_graph: None,
            commit_detail: None,
            commit_detail_generation: 0,
            commit_file_diff_generation: 0,
            history_action: None,
            log_loaded: false,
            timer_generation: 0,
        }
    }
}

/// How often a visible Git surface re-reads the repository.
const GIT_PANEL_REFRESH_INTERVAL: Duration = Duration::from_secs(5);
/// Commits requested per history refresh; tide's panel page size.
const GIT_PANEL_LOG_LIMIT: u32 = 100;
/// How long a just-committed sha stays flashed on the primary button.
const GIT_PANEL_FLASH: Duration = Duration::from_millis(1500);

// Confirming the commit draft (Enter in the summary field) and dismissing
// the stash viewer (Escape).
actions!(tide_git_panel, [ConfirmGitPanelCommit, DismissGitStash]);

pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new(
            "enter",
            ConfirmGitPanelCommit,
            Some("GitPanelCommitSummary > TextInput"),
        ),
        KeyBinding::new("escape", DismissGitStash, Some("GitStashDialog")),
    ]);
}

/// tide's subject/body split for a full commit message: first line is the
/// summary, the blank line after it is dropped, the rest is the body.
fn split_commit_message(message: &str) -> (String, String) {
    let message = message.trim();
    match message.split_once('\n') {
        Some((subject, rest)) => (
            subject.trim().to_owned(),
            rest.trim_start_matches('\n').trim_end().to_owned(),
        ),
        None => (message.to_owned(), String::new()),
    }
}

impl Tide {
    /// True when the Git surface is the active right-panel surface and the
    /// panel is on screen — the gate for the refresh timer.
    pub(super) fn git_panel_visible(&self) -> bool {
        self.right_panel_visible
            && self
                .active_right_panel_surface()
                .is_some_and(|surface| matches!(surface, super::RightPanelSurface::Git))
    }

    /// Switches the panel's tab, refreshing when the freshly-shown tab has
    /// not loaded its data yet (History defers its first log request).
    pub(super) fn select_git_panel_tab(&mut self, tab: GitPanelTab, cx: &mut Context<Self>) {
        if self.git_panel.tab == tab {
            return;
        }
        let needs_log = tab == GitPanelTab::History && !self.git_panel.log_loaded;
        self.git_panel.tab = tab;
        if needs_log {
            self.refresh_git_panel(cx);
        }
        cx.notify();
    }

    /// Hook for panel operations (stage, commit, fetch, …): called when an
    /// op completes so the panel reflects the repository's new truth.
    ///
    /// The op-dispatch tasks call this; unused until then.
    #[allow(dead_code)]
    pub(super) fn git_panel_op_done(&mut self, cx: &mut Context<Self>) {
        self.git_panel.error = None;
        self.refresh_git_panel(cx);
    }

    /// Starts the 5s refresh loop for a freshly-(re)opened Git surface. The
    /// chain is single-flight per surface: `timer_generation` supersedes any
    /// older chain, each tick skips while the panel is hidden or a refresh
    /// is already in flight, and the chain stops itself once the Git surface
    /// is gone from the tab strip.
    pub(super) fn start_git_panel_timer(&mut self, cx: &mut Context<Self>) {
        self.git_panel.timer_generation = self.git_panel.timer_generation.wrapping_add(1);
        let generation = self.git_panel.timer_generation;
        cx.spawn(async move |tide, cx| {
            loop {
                cx.background_executor()
                    .timer(GIT_PANEL_REFRESH_INTERVAL)
                    .await;
                let tick = tide.update(cx, |tide, cx| {
                    if tide.git_panel.timer_generation != generation {
                        return None;
                    }
                    if !tide
                        .right_panel_surfaces
                        .iter()
                        .any(|surface| matches!(surface, super::RightPanelSurface::Git))
                    {
                        return None;
                    }
                    // Hidden means skip, not stop: the surface comes back
                    // with the tabs intact and the loop must still be alive.
                    if tide.git_panel_visible() && !tide.git_panel.refresh_in_flight {
                        tide.refresh_git_panel(cx);
                    }
                    Some(())
                });
                if tick.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// One background pass over the daemon's git-panel reads: status,
    /// conflicts, branch info, ahead/behind, stashes, and the log when the
    /// History tab (or a previous pass) has asked for it. Requests share a
    /// single spawn and a single generation; results land together.
    pub(super) fn refresh_git_panel(&mut self, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self
            .selected_session()
            .and_then(|session| self.workspace_path_for_session(session))
            .map(Path::to_path_buf)
        else {
            return;
        };

        if self.git_panel.refresh_in_flight {
            return;
        }
        self.git_panel.generation = self.git_panel.generation.wrapping_add(1);
        let generation = self.git_panel.generation;
        let want_log = self.git_panel.tab == GitPanelTab::History || self.git_panel.log_loaded;
        self.git_panel.refresh_in_flight = true;
        self.git_panel.error = None;
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    async move {
                        let mut error: Option<String> = None;
                        let mut note_failure = |err: anyhow::Error| {
                            if error.is_none() {
                                error = Some(err.to_string());
                            }
                        };

                        let status =
                            match workspace.request(client::WorkspaceOperation::InspectGitStatus {
                                cwd: cwd.clone(),
                            }) {
                                Ok(client::WorkspaceResult::GitStatus { changes }) => Some(changes),
                                Ok(_) => {
                                    note_failure(anyhow::anyhow!(
                                        "the daemon returned an invalid git status response"
                                    ));
                                    None
                                }
                                Err(err) => {
                                    note_failure(err);
                                    None
                                }
                            };
                        let conflicts =
                            match workspace.request(client::WorkspaceOperation::GitConflictFiles {
                                cwd: cwd.clone(),
                            }) {
                                Ok(client::WorkspaceResult::GitConflicts { conflicts }) => {
                                    Some(conflicts)
                                }
                                Ok(_) => None,
                                Err(err) => {
                                    note_failure(err);
                                    None
                                }
                            };
                        let branch_info = match workspace
                            .request(client::WorkspaceOperation::GitBranchInfo { cwd: cwd.clone() })
                        {
                            Ok(client::WorkspaceResult::GitBranchInfoDone { info }) => Some(info),
                            Ok(_) => None,
                            Err(err) => {
                                note_failure(err);
                                None
                            }
                        };
                        let ahead_behind =
                            match workspace.request(client::WorkspaceOperation::GitAheadBehind {
                                cwd: cwd.clone(),
                            }) {
                                Ok(client::WorkspaceResult::GitAheadBehind { ahead_behind }) => {
                                    ahead_behind
                                }
                                Ok(_) => None,
                                Err(_) => None,
                            };
                        let stashes = match workspace
                            .request(client::WorkspaceOperation::GitStashList { cwd: cwd.clone() })
                        {
                            Ok(client::WorkspaceResult::GitStashes { stashes }) => Some(stashes),
                            Ok(_) => None,
                            Err(err) => {
                                note_failure(err);
                                None
                            }
                        };
                        let log = if want_log {
                            match workspace.request(client::WorkspaceOperation::GitLog {
                                cwd: cwd.clone(),
                                limit: GIT_PANEL_LOG_LIMIT,
                            }) {
                                Ok(client::WorkspaceResult::GitLog { commits }) => Some(commits),
                                Ok(_) => None,
                                Err(err) => {
                                    note_failure(err);
                                    None
                                }
                            }
                        } else {
                            None
                        };
                        // The identity never hard-fails the pass — a missing
                        // one is itself the rendered state.
                        let identity = match workspace.request(
                            client::WorkspaceOperation::GitCurrentIdentity { cwd: cwd.clone() },
                        ) {
                            Ok(client::WorkspaceResult::GitCurrentIdentityDone { identity }) => {
                                Some(identity)
                            }
                            Ok(_) => None,
                            Err(_) => None,
                        };
                        // The trailer preview mirrors the daemon's decision
                        // from the same config file, resolved against the
                        // fresh identity for author mode.
                        let trailer = commit_trailer_preview(identity.as_ref());
                        // The lane graph is pure CPU over the log — built
                        // here, off the UI thread, so a frame only reads it.
                        let history_graph = log
                            .as_ref()
                            .map(|commits| git_history::build_history_graph(commits));

                        (
                            status,
                            conflicts,
                            branch_info,
                            ahead_behind,
                            stashes,
                            log,
                            history_graph,
                            identity,
                            trailer,
                            error,
                        )
                    }
                })
                .await;

            tide.update(cx, |tide, cx| {
                if tide.git_panel.generation != generation
                    || tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                tide.git_panel.refresh_in_flight = false;
                let (
                    status,
                    conflicts,
                    branch_info,
                    ahead_behind,
                    stashes,
                    log,
                    history_graph,
                    identity,
                    trailer,
                    error,
                ) = result;
                if let Some(changes) = status {
                    tide.git_panel.status = Query::Ready(Arc::new(changes));
                }
                if let Some(conflicts) = conflicts {
                    tide.git_panel.conflicts = Query::Ready(Arc::new(conflicts));
                }
                if let Some(info) = branch_info {
                    tide.git_panel.branch_info = Query::Ready(Arc::new(info));
                }
                tide.git_panel.ahead_behind = ahead_behind;
                if let Some(stashes) = stashes {
                    tide.git_panel.stashes = Query::Ready(Arc::new(stashes));
                }
                if let Some(identity) = identity {
                    tide.git_panel.current_identity = Query::Ready(Arc::new(identity));
                }
                tide.git_panel.trailer = trailer;
                if let Some(commits) = log {
                    tide.git_panel.log_loaded = true;
                    tide.git_panel.history_graph = history_graph;
                    tide.git_panel.log = Query::Ready(Arc::new(commits));
                    let count = match &tide.git_panel.log {
                        Query::Ready(log) => log.len(),
                        Query::Pending | Query::Missing(_) => 0,
                    };
                    tide.git_panel_history_list_state
                        .reset_with_uniform_height(count, px(git_history::HISTORY_ROW_H));
                }
                tide.git_panel.error = error;
                tide.sync_git_panel_changes_rows();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Rebuilds the Changes tab's flat row vector from the current queries
    /// and view state, and resizes the virtualized list to match. Called
    /// whenever an input moves — a refresh landing, a section or directory
    /// toggle, a tree/list switch — never from a frame.
    pub(super) fn sync_git_panel_changes_rows(&mut self) {
        let rows = self.git_panel_changes_rows();
        *self.git_panel_changes_rows.borrow_mut() = rows;
        let count = self.git_panel_changes_rows.borrow().len();
        self.git_panel_changes_list_state
            .reset_with_uniform_height(count, px(28.0));
    }

    /// The pure half of [`Self::sync_git_panel_changes_rows`]: partitions
    /// the status list around the conflict band, then flattens sections,
    /// trees, and files into renderable rows.
    fn git_panel_changes_rows(&self) -> Vec<GitChangesRow> {
        let changes: &Arc<Vec<PanelFileChange>> = match &self.git_panel.status {
            Query::Ready(changes) => changes,
            Query::Pending | Query::Missing(_) => return Vec::new(),
        };
        let conflicts: &[PanelConflict] = match &self.git_panel.conflicts {
            Query::Ready(conflicts) => conflicts,
            Query::Pending | Query::Missing(_) => &[],
        };
        let conflict_paths: HashSet<&str> = conflicts.iter().map(|c| c.path.as_str()).collect();
        // Conflict paths belong to the resolve band alone — mirroring tide,
        // they never double-render in the staged/unstaged lists.
        let staged: Vec<usize> = changes
            .iter()
            .enumerate()
            .filter(|(_, change)| change.staged && !conflict_paths.contains(change.path.as_str()))
            .map(|(index, _)| index)
            .collect();
        let unstaged: Vec<usize> = changes
            .iter()
            .enumerate()
            .filter(|(_, change)| !change.staged && !conflict_paths.contains(change.path.as_str()))
            .map(|(index, _)| index)
            .collect();

        let mut rows = Vec::new();
        if !conflicts.is_empty() {
            rows.push(GitChangesRow::ConflictHeader {
                count: conflicts.len(),
            });
            for index in 0..conflicts.len() {
                rows.push(GitChangesRow::ConflictFile { index });
            }
        }
        for (section, indexes, open) in [
            (GitFileSection::Staged, &staged, self.git_panel.staged_open),
            (
                GitFileSection::Unstaged,
                &unstaged,
                self.git_panel.unstaged_open,
            ),
        ] {
            if indexes.is_empty() {
                continue;
            }
            rows.push(GitChangesRow::SectionHeader {
                section,
                count: indexes.len(),
            });
            if !open {
                continue;
            }
            if self.git_panel.tree_mode {
                let tree = build_git_file_tree(changes, indexes);
                push_tree_rows(
                    &mut rows,
                    &tree,
                    section,
                    "",
                    0,
                    &self.git_panel.closed_dirs,
                );
            } else {
                for &index in indexes {
                    rows.push(GitChangesRow::File {
                        section,
                        index,
                        depth: 0,
                        show_path: true,
                    });
                }
            }
        }
        rows
    }

    pub(super) fn toggle_git_panel_section(
        &mut self,
        section: GitFileSection,
        cx: &mut Context<Self>,
    ) {
        match section {
            GitFileSection::Staged => self.git_panel.staged_open = !self.git_panel.staged_open,
            GitFileSection::Unstaged => {
                self.git_panel.unstaged_open = !self.git_panel.unstaged_open
            }
        }
        self.sync_git_panel_changes_rows();
        cx.notify();
    }

    pub(super) fn toggle_git_panel_directory(&mut self, key: String, cx: &mut Context<Self>) {
        if !self.git_panel.closed_dirs.remove(&key) {
            self.git_panel.closed_dirs.insert(key);
        }
        self.sync_git_panel_changes_rows();
        cx.notify();
    }

    pub(super) fn set_git_panel_tree_mode(&mut self, tree_mode: bool, cx: &mut Context<Self>) {
        if self.git_panel.tree_mode == tree_mode {
            return;
        }
        self.git_panel.tree_mode = tree_mode;
        self.sync_git_panel_changes_rows();
        cx.notify();
    }

    /// Runs one mutating git-panel operation off the UI thread: sets the
    /// busy treatment, dispatches through the workspace client, and lands
    /// via [`Self::git_panel_op_done`] — or as a stored error when the
    /// daemon reports failure. The session/cwd pair is the generation guard:
    /// a result from a different workspace than the one now selected is
    /// dropped.
    pub(super) fn run_git_panel_op(
        &mut self,
        label: &'static str,
        operation: client::WorkspaceOperation,
        cx: &mut Context<Self>,
    ) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        self.git_panel.busy = Some(label);
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match workspace.request(operation) {
                        Ok(client::WorkspaceResult::GitOp { result }) => Ok(result),
                        Ok(_) => Err(anyhow::anyhow!(
                            "the daemon returned an invalid git operation response"
                        )),
                        Err(err) => Err(err),
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                tide.git_panel.busy = None;
                match result {
                    Ok(panel_result) if panel_result.ok => tide.git_panel_op_done(cx),
                    Ok(panel_result) => {
                        tide.git_panel.error = Some(
                            panel_result
                                .error
                                .unwrap_or_else(|| tr!("git_panel.op_failed", op = label)),
                        );
                        cx.notify();
                    }
                    Err(err) => {
                        tide.git_panel.error = Some(err.to_string());
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Opens the per-file diff sub-view for a clicked change and requests
    /// its hunks at the base of the context ladder.
    pub(super) fn open_git_panel_file_diff(
        &mut self,
        path: String,
        staged: bool,
        cx: &mut Context<Self>,
    ) {
        self.git_panel.last_turn_review = None;
        self.git_panel.selected_file_diff = Some(SelectedFileDiff {
            path,
            staged,
            context_lines: EXPAND_CONTEXT_LADDER[0],
            hunks: Query::Pending,
            snapshot: None,
            anchor: None,
        });
        self.request_selected_file_diff(cx);
    }

    /// Leaves the per-file sub-view, restoring the Changes list.
    pub(super) fn close_git_panel_file_diff(&mut self, cx: &mut Context<Self>) {
        self.git_panel.selected_file_diff = None;
        cx.notify();
    }

    /// Escalates the selected file's diff context one ladder rung and
    /// refetches, mirroring tide's wider-context refetch on gap expand. The
    /// previous snapshot stays on screen until the wider one lands; the
    /// clicked gap's next change line becomes the scroll anchor.
    pub(super) fn expand_selected_file_diff_context(
        &mut self,
        gap_line_index: usize,
        cx: &mut Context<Self>,
    ) {
        let Some(selected) = self.git_panel.selected_file_diff.as_mut() else {
            return;
        };
        let next = next_expand_context(selected.context_lines);
        if next == selected.context_lines {
            return;
        }
        selected.anchor = selected
            .snapshot
            .as_ref()
            .map(|snapshot| anchor_change_line(snapshot, gap_line_index));
        selected.context_lines = next;
        selected.hunks = Query::Pending;
        cx.notify();
        self.request_selected_file_diff(cx);
    }

    /// The read behind the sub-view: fetches the selected file's hunks at
    /// the current context width, converts them to the render model off the
    /// UI thread, and lands both — resetting the virtualized list and, on an
    /// escalation, re-anchoring to the recorded change line's hunk header.
    fn request_selected_file_diff(&mut self, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        let Some(selected) = self.git_panel.selected_file_diff.as_ref() else {
            return;
        };
        let path = selected.path.clone();
        let staged = selected.staged;
        let context_lines = selected.context_lines;
        self.git_panel.selected_file_diff_generation =
            self.git_panel.selected_file_diff_generation.wrapping_add(1);
        let generation = self.git_panel.selected_file_diff_generation;
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    let path = path.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::GitFileDiff {
                            cwd,
                            path: path.clone(),
                            staged,
                            context_lines,
                        }) {
                            Ok(client::WorkspaceResult::GitDiff { hunks }) => Ok((
                                hunks.clone(),
                                Arc::new(review_diff::from_panel_hunks(&path, &hunks)),
                            )),
                            Ok(_) => Err(anyhow::anyhow!(
                                "the daemon returned an invalid file diff response"
                            )),
                            Err(err) => Err(err),
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                    || tide.git_panel.selected_file_diff_generation != generation
                {
                    return;
                }
                let Some(selected) = tide.git_panel.selected_file_diff.as_mut() else {
                    return;
                };
                if selected.path != path || selected.staged != staged {
                    return;
                }
                match result {
                    Ok((hunks, snapshot)) => {
                        selected.hunks = Query::Ready(Arc::new(hunks));
                        let anchor_header = selected
                            .anchor
                            .and_then(|anchor| anchor_hunk_header(&snapshot, anchor));
                        selected.anchor = None;
                        selected.snapshot = Some(snapshot.clone());
                        tide.git_panel_diff_selection.clear();
                        tide.git_panel_diff_list_state.reset(snapshot.lines.len());
                        if let Some(line) = anchor_header {
                            tide.git_panel_diff_list_state.scroll_to(gpui::ListOffset {
                                item_ix: line,
                                offset_in_item: px(0.0),
                            });
                        }
                    }
                    Err(err) => {
                        tide.show_toast(tr!("git_panel.diff_failed", error = err.to_string()))
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Opens (or reuses) the "last turn" agent review over the Git surface.
    pub(super) fn open_last_turn_review(
        &mut self,
        source: ReviewDiffSource,
        cx: &mut Context<Self>,
    ) {
        let reuse = self
            .git_panel
            .last_turn_review
            .as_ref()
            .is_some_and(|review| review.source == source && review.snapshot.is_some());
        if !reuse {
            self.git_panel.last_turn_review = Some(LastTurnReview {
                source,
                generation: 0,
                snapshot: None,
                loading: false,
                error: None,
            });
            self.git_panel.selected_file_diff = None;
        }
        self.open_right_panel_surface(super::RightPanelSurface::Git, cx);
        if !reuse {
            self.refresh_last_turn_review(cx);
        }
    }

    /// Leaves the review mode, restoring the Changes list.
    pub(super) fn close_last_turn_review(&mut self, cx: &mut Context<Self>) {
        self.git_panel.last_turn_review = None;
        cx.notify();
    }

    /// The same generation-guarded collection pass the retired Review
    /// surface ran, scoped to the review's `LastTurn` source.
    pub(super) fn refresh_last_turn_review(&mut self, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        let Some(review) = self.git_panel.last_turn_review.as_mut() else {
            return;
        };
        review.generation = review.generation.wrapping_add(1);
        let generation = review.generation;
        let source = review.source;
        review.loading = true;
        review.error = None;
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::CollectReviewDiff {
                            cwd,
                            source: review_diff::wire_source(source),
                        })? {
                            client::WorkspaceResult::ReviewDiff { data } => {
                                Ok(crate::review_diff::parse_collected(
                                    source,
                                    &data.numstat,
                                    &data.patch,
                                    data.complete_context,
                                ))
                            }
                            _ => anyhow::bail!("the daemon returned an invalid diff response"),
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                let still_current = tide.state.selected_session == Some(session_id)
                    && tide
                        .git_panel
                        .last_turn_review
                        .as_ref()
                        .is_some_and(|review| {
                            review.generation == generation && review.source == source
                        })
                    && tide
                        .selected_workspace_path()
                        .is_some_and(|path| path == cwd);
                if !still_current {
                    return;
                }
                let Some(review) = tide.git_panel.last_turn_review.as_mut() else {
                    return;
                };
                review.loading = false;
                match result {
                    Ok(snapshot) => {
                        let line_count = snapshot.lines.len();
                        review.snapshot = Some(Arc::new(snapshot));
                        review.error = None;
                        tide.git_panel_diff_selection.clear();
                        tide.git_panel_diff_list_state.reset(line_count);
                    }
                    Err(error) => review.error = Some(error.to_string()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Reveals retained context in the review snapshot without touching
    /// Git; the list splice keeps the viewport anchored.
    pub(super) fn expand_last_turn_review_gap(
        &mut self,
        line_index: usize,
        direction: review_diff::ExpansionDirection,
        cx: &mut Context<Self>,
    ) {
        let expansion = self
            .git_panel
            .last_turn_review
            .as_mut()
            .and_then(|review| review.snapshot.as_mut())
            .and_then(|snapshot| Arc::make_mut(snapshot).expand_gap(line_index, direction));
        let Some(expansion) = expansion else {
            return;
        };
        self.git_panel_diff_list_state
            .splice(line_index..line_index + 1, expansion.replacement_count);
        cx.notify();
    }

    // ── commit bar + identity bar ─────────────────────────────────────────

    /// The commit draft of the selected workspace, creating it on first use
    /// (the profile-dialog materialize step — `TextInput::new` needs a
    /// window, which is why the draft cannot be built in `Default`). Drafts
    /// are keyed by workspace path and live for the app's lifetime, so they
    /// survive tab switches, refreshes, and session switches.
    pub(super) fn ensure_git_panel_commit_draft(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        let key = cwd.display().to_string();
        if !self.git_panel.commit_drafts.contains_key(&key) {
            let summary = cx.new(|cx| {
                TextInput::new(window, cx).placeholder(tr!("git_panel.summary_placeholder"))
            });
            let description = cx.new(|cx| {
                TextInput::new(window, cx)
                    .multi_line()
                    .auto_height()
                    // Ten visible lines at the auto-height line metric
                    // (22px); the rest scrolls under the overlay scrollbar.
                    .auto_height_max(px(220.0))
                    .placeholder(tr!("git_panel.description_placeholder"))
            });
            self.git_panel.commit_drafts.insert(
                key,
                CommitDraft {
                    summary,
                    description,
                    amend: false,
                },
            );
        }
    }

    /// The commit draft of the selected workspace, when it exists.
    pub(super) fn git_panel_commit_draft(&self) -> Option<&CommitDraft> {
        let key = self.selected_workspace_path()?.display().to_string();
        self.git_panel.commit_drafts.get(&key)
    }

    /// Applies an identity pick from the panel's dropdown through the same
    /// GitSetIdentity dispatch the settings page uses. The settings drain
    /// refreshes the snapshot; it also refreshes the panel's queries, which
    /// re-reads the freshly applied identity.
    pub(super) fn set_git_panel_identity(&mut self, profile_id: String) {
        let Some(cwd) = self.selected_workspace_path() else {
            return;
        };
        self.git_set_project_identity(cwd.display().to_string(), profile_id);
    }

    /// Toggles the amend mode; enabling requests HEAD's full message and
    /// prefills the draft with it, mirroring tide's amend effect.
    pub(super) fn toggle_git_panel_amend(&mut self, cx: &mut Context<Self>) {
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        let key = cwd.display().to_string();
        let Some(draft) = self.git_panel.commit_drafts.get_mut(&key) else {
            return;
        };
        draft.amend = !draft.amend;
        let amend = draft.amend;
        self.git_panel.amend_generation = self.git_panel.amend_generation.wrapping_add(1);
        let generation = self.git_panel.amend_generation;
        cx.notify();
        if !amend {
            return;
        }
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::GitCommitMessage {
                            cwd,
                            sha: "HEAD".to_owned(),
                        }) {
                            Ok(client::WorkspaceResult::GitText { text }) => Ok(text),
                            Ok(_) => Err(anyhow::anyhow!(
                                "the daemon returned an invalid commit message response"
                            )),
                            Err(err) => Err(err),
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.git_panel.amend_generation != generation
                    || tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                let (summary, description) = match result {
                    Ok(text) if !text.trim().is_empty() => split_commit_message(&text),
                    _ => return,
                };
                let key = cwd.display().to_string();
                if let Some(draft) = tide.git_panel.commit_drafts.get_mut(&key) {
                    draft
                        .summary
                        .update(cx, |input, cx| input.set_content(summary, cx));
                    draft
                        .description
                        .update(cx, |input, cx| input.set_content(description, cx));
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Resolve the commit-message generation invocation: the background-model
    /// override when set (CLI provider → its binary + model; Tide → engine
    /// path with no binary, the daemon resolves the model from the override),
    /// else the session's own provider. `None` means a CLI provider has no
    /// installed binary — the "agent unavailable" case.
    pub(super) fn commit_invocation(&self) -> Option<crate::git_commit::AgentInvocation> {
        self.background_invocation(
            self.git_settings
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.background_commit_model.as_ref()),
        )
    }

    /// The background-model invocation for a one-shot task: its settings
    /// override when set (CLI provider → its binary + model; Tide → engine
    /// path with no binary, the daemon resolves the model from the override),
    /// else the session's own provider. `None` means a CLI provider has no
    /// installed binary — the "agent unavailable" case.
    pub(super) fn background_invocation(
        &self,
        reference: Option<&protocol::git_settings::ModelRefWire>,
    ) -> Option<crate::git_commit::AgentInvocation> {
        let tide_provider_ids = self
            .tide
            .providers
            .iter()
            .map(|provider| provider.id.as_str());
        match resolve_commit_model_source(reference, tide_provider_ids) {
            CommitModelSource::Tide => Some(crate::git_commit::AgentInvocation {
                provider: protocol::model::ProviderKind::Tide,
                binary: PathBuf::new(),
                model: None,
                reasoning_effort: None,
            }),
            // No usable override: the session's own model rides the engine as
            // the daemon-side fallback.
            CommitModelSource::Session => {
                let (model, reasoning_effort) = self.selected_session().map(|session| {
                    (
                        self.model_for_session(session).map(str::to_owned),
                        session.reasoning_effort.clone(),
                    )
                })?;
                Some(crate::git_commit::AgentInvocation {
                    provider: protocol::model::ProviderKind::Tide,
                    binary: PathBuf::new(),
                    model,
                    reasoning_effort,
                })
            }
        }
    }

    /// The ✨ button: generates a commit message from the staged diff with
    /// the same one-shot agent invocation the commit dialog uses, then
    /// replaces the draft's fields with it.
    pub(super) fn generate_git_panel_commit_message(&mut self, cx: &mut Context<Self>) {
        if self.git_panel.generating_message || self.git_panel.busy.is_some() {
            return;
        }
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        let Some(invocation) = self.commit_invocation() else {
            self.show_toast(tr!("commit.agent_unavailable"));
            cx.notify();
            return;
        };
        self.git_panel.generating_message = true;
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::GenerateCommitMessage {
                            cwd,
                            include_unstaged: false,
                            invocation,
                        }) {
                            Ok(client::WorkspaceResult::CommitMessage { message }) => Ok(message),
                            Ok(_) => Err(anyhow::anyhow!(
                                "the daemon returned an invalid commit message response"
                            )),
                            Err(err) => Err(err),
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                tide.git_panel.generating_message = false;
                match result {
                    Ok(message) => {
                        let key = cwd.display().to_string();
                        let (summary, description) = split_commit_message(&message);
                        if let Some(draft) = tide.git_panel.commit_drafts.get_mut(&key) {
                            draft
                                .summary
                                .update(cx, |input, cx| input.set_content(summary, cx));
                            draft
                                .description
                                .update(cx, |input, cx| input.set_content(description, cx));
                        }
                    }
                    Err(err) => tide.git_panel.error = Some(err.to_string()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The primary action: amend HEAD or commit the index, staging all first
    /// when nothing is staged yet (tide's "Stage all & commit"). Conflicts
    /// block the call; the caller renders the hint.
    pub(super) fn confirm_git_panel_commit(&mut self, cx: &mut Context<Self>) {
        let has_conflicts =
            matches!(&self.git_panel.conflicts, Query::Ready(conflicts) if !conflicts.is_empty());
        if has_conflicts || self.git_panel.busy.is_some() || self.git_panel.generating_message {
            return;
        }
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        let Some(draft) = self.git_panel.commit_drafts.get(&cwd.display().to_string()) else {
            return;
        };
        let summary = draft.summary.read(cx).content().trim().to_owned();
        if summary.is_empty() {
            return;
        }
        let description = draft.description.read(cx).content().trim().to_owned();
        let amend = draft.amend;
        let message = if description.is_empty() {
            summary
        } else {
            format!("{summary}\n\n{description}")
        };
        // Upstream stages everything first when nothing is staged but the
        // worktree is dirty; an empty worktree is left to the daemon to
        // reject.
        let staged_empty = matches!(&self.git_panel.status, Query::Ready(changes) if !changes.iter().any(|c| c.staged));
        let has_unstaged = matches!(&self.git_panel.status, Query::Ready(changes) if changes.iter().any(|c| !c.staged));
        let stage_first = !amend && staged_empty && has_unstaged;
        self.spawn_git_panel_commit(amend, stage_first, message, cx);
    }

    /// One background task for the whole commit sequence: the optional
    /// stage-all, the commit/amend itself, and — for a plain commit, whose
    /// wire reply carries no sha — a branch-info read to flash the new HEAD.
    fn spawn_git_panel_commit(
        &mut self,
        amend: bool,
        stage_first: bool,
        message: String,
        cx: &mut Context<Self>,
    ) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        self.git_panel.busy = Some("commit");
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    async move {
                        if stage_first {
                            match workspace.request(client::WorkspaceOperation::GitBulk {
                                cwd: cwd.clone(),
                                op: "stage-all".to_owned(),
                                message: None,
                            }) {
                                Ok(client::WorkspaceResult::GitOp { result }) if result.ok => {}
                                Ok(client::WorkspaceResult::GitOp { result }) => {
                                    return Err(result.error.unwrap_or_else(|| {
                                        tr!("git_panel.op_failed", op = "stage-all")
                                    }));
                                }
                                Ok(_) => {
                                    return Err(anyhow::anyhow!(
                                        "the daemon returned an invalid git operation response"
                                    )
                                    .to_string());
                                }
                                Err(err) => return Err(err.to_string()),
                            }
                        }
                        if amend {
                            match workspace.request(client::WorkspaceOperation::GitAmend {
                                cwd: cwd.clone(),
                                message: Some(message),
                            }) {
                                Ok(client::WorkspaceResult::GitCommitDone { result }) => {
                                    if result.ok {
                                        Ok(result.sha)
                                    } else {
                                        Err(result.error.unwrap_or_else(|| {
                                            tr!("git_panel.op_failed", op = "commit")
                                        }))
                                    }
                                }
                                Ok(_) => Err(anyhow::anyhow!(
                                    "the daemon returned an invalid amend response"
                                )
                                .to_string()),
                                Err(err) => Err(err.to_string()),
                            }
                        } else {
                            match workspace.request(client::WorkspaceOperation::Commit {
                                cwd: cwd.clone(),
                                message,
                                include_unstaged: false,
                                push: false,
                            }) {
                                Ok(client::WorkspaceResult::Ack) => {
                                    // The Ack carries no sha; the new HEAD comes
                                    // from the branch-info read the panel already
                                    // uses (short form, ready to flash).
                                    match workspace.request(
                                        client::WorkspaceOperation::GitBranchInfo {
                                            cwd: cwd.clone(),
                                        },
                                    ) {
                                        Ok(client::WorkspaceResult::GitBranchInfoDone { info }) => {
                                            Ok(info.head_commit)
                                        }
                                        _ => Ok(None),
                                    }
                                }
                                Ok(_) => Err(anyhow::anyhow!(
                                    "the daemon returned an invalid commit response"
                                )
                                .to_string()),
                                Err(err) => Err(err.to_string()),
                            }
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                tide.git_panel.busy = None;
                match result {
                    Ok(sha) => {
                        let key = cwd.display().to_string();
                        if let Some(draft) = tide.git_panel.commit_drafts.get_mut(&key) {
                            draft.amend = false;
                            draft
                                .summary
                                .update(cx, |input, cx| input.set_content("", cx));
                            draft
                                .description
                                .update(cx, |input, cx| input.set_content("", cx));
                        }
                        if let Some(sha) = sha.filter(|sha| !sha.is_empty()) {
                            tide.flash_git_panel_sha(sha, cx);
                        }
                        tide.git_panel_op_done(cx);
                    }
                    Err(err) => {
                        tide.git_panel.error = Some(err);
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    // ── History tab ─────────────────────────────────────────────────────────

    /// Opens the commit-details sub-view for `sha` and fetches its
    /// enrichment (full message + changed files) in one background pass.
    pub(super) fn open_git_commit_detail(&mut self, sha: String, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        self.git_panel.commit_detail = Some(CommitDetailView {
            sha: sha.clone(),
            message: Query::Pending,
            files: Query::Pending,
            file_diff: None,
        });
        self.git_panel.commit_detail_generation =
            self.git_panel.commit_detail_generation.wrapping_add(1);
        let generation = self.git_panel.commit_detail_generation;
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    let sha = sha.clone();
                    async move {
                        let message =
                            match workspace.request(client::WorkspaceOperation::GitCommitMessage {
                                cwd: cwd.clone(),
                                sha: sha.clone(),
                            }) {
                                Ok(client::WorkspaceResult::GitText { text }) => Some(text),
                                _ => None,
                            };
                        let files =
                            match workspace.request(client::WorkspaceOperation::GitCommitFiles {
                                cwd: cwd.clone(),
                                sha: sha.clone(),
                            }) {
                                Ok(client::WorkspaceResult::GitStatus { changes }) => Some(changes),
                                _ => None,
                            };
                        (message, files)
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.git_panel.commit_detail_generation != generation
                    || tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                let Some(detail) = tide.git_panel.commit_detail.as_mut() else {
                    return;
                };
                if detail.sha != sha {
                    return;
                }
                if let Some(message) = result.0 {
                    detail.message = Query::Ready(Arc::new(message));
                }
                if let Some(files) = result.1 {
                    detail.files = Query::Ready(Arc::new(files));
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Leaves the commit-details sub-view, restoring the History list.
    pub(super) fn close_git_commit_detail(&mut self, cx: &mut Context<Self>) {
        self.git_panel.commit_detail = None;
        cx.notify();
    }

    /// Navigates the details sub-view to a parent sha; parents outside the
    /// loaded window are disabled upstream, so this always has an entry.
    pub(super) fn select_git_commit(&mut self, sha: String, cx: &mut Context<Self>) {
        let known =
            matches!(&self.git_panel.log, Query::Ready(log) if log.iter().any(|c| c.sha == sha));
        if known {
            self.open_git_commit_detail(sha, cx);
        }
    }

    /// Expands (or collapses) a changed file's diff inside the details
    /// sub-view, fetching it at the viewed commit.
    pub(super) fn toggle_git_commit_file_diff(&mut self, path: String, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        let Some(sha) = self
            .git_panel
            .commit_detail
            .as_mut()
            .and_then(|detail| toggle_commit_file_diff(detail, &path))
        else {
            cx.notify();
            return;
        };
        cx.notify();

        self.git_panel.commit_file_diff_generation =
            self.git_panel.commit_file_diff_generation.wrapping_add(1);
        let generation = self.git_panel.commit_file_diff_generation;
        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    let path = path.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::GitCommitFileDiff {
                            cwd,
                            sha: sha.clone(),
                            path: path.clone(),
                        }) {
                            Ok(client::WorkspaceResult::GitDiff { hunks }) => Ok((
                                hunks.clone(),
                                Arc::new(review_diff::from_panel_hunks(&path, &hunks)),
                            )),
                            Ok(_) => Err(anyhow::anyhow!(
                                "the daemon returned an invalid commit diff response"
                            )),
                            Err(err) => Err(err),
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.git_panel.commit_file_diff_generation != generation
                    || tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                let Some(detail) = tide.git_panel.commit_detail.as_mut() else {
                    return;
                };
                let Some(file_diff) = detail.file_diff.as_mut() else {
                    return;
                };
                match result {
                    Ok((hunks, snapshot)) => {
                        file_diff.hunks = Query::Ready(Arc::new(hunks));
                        tide.git_panel_diff_selection.clear();
                        tide.git_panel_diff_list_state.reset(snapshot.lines.len());
                        file_diff.snapshot = Some(snapshot);
                    }
                    Err(err) => {
                        tide.show_toast(tr!("git_panel.diff_failed", error = err.to_string()))
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Moves the open actions popover to a new stage, materializing the
    /// branch input on demand.
    pub(super) fn set_history_action_stage(
        &mut self,
        stage: super::git_panel::HistoryActionStage,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(action) = self.git_panel.history_action.as_mut() else {
            return;
        };
        if stage == super::git_panel::HistoryActionStage::Branch && action.branch_input.is_none() {
            action.branch_input = Some(cx.new(|cx| {
                TextInput::new(window, cx).placeholder(tr!("git_panel.branch_name_placeholder"))
            }));
        }
        action.stage = stage;
        cx.notify();
    }

    /// Closes the actions popover (and its stage state).
    pub(super) fn close_history_row_action(&mut self, cx: &mut Context<Self>) {
        self.git_panel.history_action = None;
        cx.notify();
    }

    /// "Branch from here…": creates a branch at the row's sha and switches
    /// to it (`git switch -c <name> <sha>`).
    pub(super) fn submit_history_branch(&mut self, cx: &mut Context<Self>) {
        let Some(action) = self.git_panel.history_action.as_ref() else {
            return;
        };
        let name = action
            .branch_input
            .as_ref()
            .map(|input| input.read(cx).content().trim().to_owned())
            .unwrap_or_default();
        if name.is_empty() {
            return;
        }
        let sha = action.sha.clone();
        self.close_history_row_action(cx);
        self.run_git_history_checkout(true, name, Some(sha), cx);
    }

    /// Checks out by branch name, creates a branch at a start point, or
    /// checks a sha out detached — the extended `CheckoutBranch` op. The
    /// result is a `BranchChanged`, not a `GitOp`, so this runs its own
    /// dispatch instead of `run_git_panel_op`.
    pub(super) fn run_git_history_checkout(
        &mut self,
        create: bool,
        branch: String,
        start_point: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        self.git_panel.busy = Some("checkout");
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::CheckoutBranch {
                            cwd,
                            branch,
                            create,
                            start_point,
                        }) {
                            Ok(client::WorkspaceResult::BranchChanged { snapshot: _ }) => Ok(()),
                            Ok(_) => Err(anyhow::anyhow!(
                                "the daemon returned an invalid branch response"
                            )),
                            Err(err) => Err(err),
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                tide.git_panel.busy = None;
                match result {
                    Ok(()) => {
                        tide.show_toast(tr!("git_panel.checked_out"));
                        tide.git_panel_op_done(cx);
                        // The sidebar's cached branch label rides the same
                        // checkout; invalidate its snapshot so it refetches.
                        tide.refresh_selected_branch_snapshot(cx);
                    }
                    Err(err) => {
                        tide.git_panel.error = Some(err.to_string());
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Reverts a commit through `GitRevert` (its reply is a
    /// `GitRevertDone`, not a `GitOp`), then refreshes and toasts.
    pub(super) fn run_git_panel_revert(&mut self, sha: String, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        self.git_panel.busy = Some("revert");
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn({
                    let cwd = cwd.clone();
                    async move {
                        match workspace.request(client::WorkspaceOperation::GitRevert { cwd, sha })
                        {
                            Ok(client::WorkspaceResult::GitRevertDone { result }) => Ok(result),
                            Ok(_) => Err(anyhow::anyhow!(
                                "the daemon returned an invalid revert response"
                            )),
                            Err(err) => Err(err),
                        }
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                tide.git_panel.busy = None;
                match result {
                    Ok(panel_result) if panel_result.ok => {
                        tide.show_toast(tr!("git_panel.revert_done"));
                        tide.git_panel_op_done(cx);
                    }
                    Ok(panel_result) => {
                        tide.git_panel.error = Some(
                            panel_result
                                .error
                                .unwrap_or_else(|| tr!("git_panel.op_failed", op = "revert")),
                        );
                        cx.notify();
                    }
                    Err(err) => {
                        tide.git_panel.error = Some(err.to_string());
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Flashes the just-committed sha on the primary button for 1.5s; a
    /// newer flash supersedes the older timer.
    fn flash_git_panel_sha(&mut self, sha: String, cx: &mut Context<Self>) {
        self.git_panel.flash_generation = self.git_panel.flash_generation.wrapping_add(1);
        let generation = self.git_panel.flash_generation;
        self.git_panel.flash_sha = Some(sha);
        cx.notify();
        cx.spawn(async move |tide, cx| {
            cx.background_executor().timer(GIT_PANEL_FLASH).await;
            tide.update(cx, |tide, cx| {
                if tide.git_panel.flash_generation == generation {
                    tide.git_panel.flash_sha = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    // ── stash viewer ────────────────────────────────────────────────────────

    /// The stash viewer's Pop row action: closes the dialog and pops the top
    /// stash through the bulk op. Note the service's git2 behavior — a
    /// conflicting pop applies with conflict markers and reports `ok` — so
    /// the error toast only covers real failures.
    pub(super) fn pop_git_panel_stash(&mut self, cx: &mut Context<Self>) {
        if self.git_panel.busy.is_some() {
            return;
        }
        self.git_panel.stash_dialog_open = false;
        self.run_git_panel_bulk_op("stash-pop", cx);
    }

    /// Fetch or Pull from the branch menu footer: the same dispatch as the
    /// panel's bulk ops, but with toast reporting instead of the stored
    /// error row (a failed sync must not blank the Changes tab).
    pub(super) fn run_git_panel_remote(
        &mut self,
        label: &'static str,
        fetch: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        let operation = if fetch {
            client::WorkspaceOperation::GitFetch { cwd: cwd.clone() }
        } else {
            client::WorkspaceOperation::GitPull { cwd: cwd.clone() }
        };
        self.git_panel.busy = Some(label);
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        let success = if fetch {
            tr!("git_panel.fetched")
        } else {
            tr!("git_panel.pulled")
        };
        let failed = if fetch {
            tr!("git_panel.fetch_failed")
        } else {
            tr!("git_panel.pull_failed")
        };
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match workspace.request(operation) {
                        Ok(client::WorkspaceResult::GitOp { result }) => Ok(result),
                        Ok(_) => Err(anyhow::anyhow!(
                            "the daemon returned an invalid git operation response"
                        )),
                        Err(err) => Err(err),
                    }
                })
                .await;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                tide.git_panel.busy = None;
                match result {
                    Ok(panel_result) if panel_result.ok => {
                        tide.show_toast(success);
                        tide.git_panel_op_done(cx);
                    }
                    Ok(panel_result) => {
                        tide.show_toast(format!(
                            "{failed}: {}",
                            panel_result
                                .error
                                .unwrap_or_else(|| tr!("git_panel.op_failed", op = label))
                        ));
                        cx.notify();
                    }
                    Err(err) => {
                        tide.show_toast(format!("{failed}: {err}"));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// Push from the branch menu footer: `WorkspaceOperation::Push` replies
    /// `Ack`, not `GitOp`, so it runs its own dispatch — busy treatment,
    /// toast reporting, and the full panel refresh (ahead/behind rides the
    /// base pass) on success.
    pub(super) fn run_git_panel_push(&mut self, cx: &mut Context<Self>) {
        let Some(session_id) = self.state.selected_session else {
            return;
        };
        let Some(cwd) = self.selected_workspace_path().map(Path::to_path_buf) else {
            return;
        };
        self.git_panel.busy = Some("push");
        cx.notify();

        let workspace = client::WorkspaceClient::new(self.daemon.client());
        let guard_cwd = cwd.clone();
        cx.spawn(async move |tide, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match workspace.request(client::WorkspaceOperation::Push { cwd }) {
                        Ok(client::WorkspaceResult::Ack) => Ok(()),
                        Ok(_) => Err(anyhow::anyhow!(
                            "the daemon returned an invalid push response"
                        )),
                        Err(err) => Err(err),
                    }
                })
                .await;
            let cwd = guard_cwd;
            tide.update(cx, |tide, cx| {
                if tide.state.selected_session != Some(session_id)
                    || tide
                        .selected_workspace_path()
                        .is_some_and(|path| path != cwd)
                {
                    return;
                }
                tide.git_panel.busy = None;
                match result {
                    Ok(()) => {
                        tide.show_toast(tr!("git_panel.pushed"));
                        tide.git_panel_op_done(cx);
                    }
                    Err(err) => {
                        tide.show_toast(tr!("git_panel.push_failed", error = err.to_string()));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }
}

/// Toggles the commit-detail file diff: clicking the expanded path
/// collapses it; any other path replaces it with a Pending entry. Returns
/// the commit sha when a fetch is needed.
fn toggle_commit_file_diff(detail: &mut CommitDetailView, path: &str) -> Option<String> {
    if detail
        .file_diff
        .as_ref()
        .is_some_and(|diff| diff.path == path)
    {
        detail.file_diff = None;
        return None;
    }
    detail.file_diff = Some(CommitFileDiff {
        path: path.to_owned(),
        hunks: Query::Pending,
        snapshot: None,
    });
    Some(detail.sha.clone())
}

/// The first changed row at or after the gap the user expanded — the
/// landmark the wider refetch must scroll back to.
fn anchor_change_line(
    snapshot: &ReviewDiffSnapshot,
    from_index: usize,
) -> (Option<u32>, Option<u32>) {
    let fallback = (None, None);
    snapshot
        .lines
        .iter()
        .skip(from_index)
        .find(|line| {
            matches!(
                line.kind,
                review_diff::LineKind::Addition | review_diff::LineKind::Deletion
            )
        })
        .map_or(fallback, |line| (line.old_line, line.new_line))
}

/// The index of the hunk header owning the landmark change line, so the
/// wider snapshot top-anchors the hunk the user was reading.
fn anchor_hunk_header(
    snapshot: &ReviewDiffSnapshot,
    anchor: (Option<u32>, Option<u32>),
) -> Option<usize> {
    let index = snapshot.lines.iter().position(|line| {
        matches!(
            line.kind,
            review_diff::LineKind::Addition | review_diff::LineKind::Deletion
        ) && (line.old_line.is_some_and(|old| anchor.0 == Some(old))
            || line.new_line.is_some_and(|new| anchor.1 == Some(new)))
    })?;
    snapshot.lines[..index]
        .iter()
        .rposition(|line| line.kind == review_diff::LineKind::HunkHeader)
}

/// The commit-message model world resolved from the background override.
#[derive(Debug, PartialEq)]
pub(super) enum CommitModelSource {
    /// A configured tide sub-provider — engine one-shot; the daemon resolves
    /// the model from the stored override itself.
    Tide,
    /// No override, or its provider is not configured — use the session's
    /// model.
    Session,
}

/// Tolerant client-side resolution of the commit-message background-model
/// override: a ref whose provider matches a configured tide provider resolves
/// to the engine; anything else falls back to the session's model.
pub(super) fn resolve_commit_model_source(
    reference: Option<&protocol::git_settings::ModelRefWire>,
    tide_provider_ids: impl IntoIterator<Item = impl AsRef<str>>,
) -> CommitModelSource {
    let Some(reference) = reference else {
        return CommitModelSource::Session;
    };
    if tide_provider_ids
        .into_iter()
        .any(|id| id.as_ref() == reference.provider_id)
    {
        return CommitModelSource::Tide;
    }
    CommitModelSource::Session
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::git_settings::ModelRefWire;

    fn reference(provider_id: &str, model_id: &str) -> ModelRefWire {
        ModelRefWire {
            provider_id: provider_id.to_owned(),
            model_id: model_id.to_owned(),
        }
    }

    fn tide_ids() -> Vec<&'static str> {
        vec!["openrouter", "github-models"]
    }

    #[test]
    fn tide_override_resolves_to_the_engine_path() {
        assert_eq!(
            resolve_commit_model_source(Some(&reference("openrouter", "gpt-5.6")), tide_ids(),),
            CommitModelSource::Tide
        );
    }

    #[test]
    fn an_unconfigured_override_falls_back_to_the_session() {
        assert_eq!(
            resolve_commit_model_source(Some(&reference("unknown-provider", "m")), tide_ids(),),
            CommitModelSource::Session
        );
    }

    #[test]
    fn unset_override_uses_the_session() {
        assert_eq!(
            resolve_commit_model_source(None, tide_ids()),
            CommitModelSource::Session
        );
    }
}
