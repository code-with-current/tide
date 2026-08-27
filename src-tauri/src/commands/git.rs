//! Git panel commands (M4 T3) — the port of `app/rpc/git.ts` +
//! `app/core/ipc-adjacent/git.ts` (+ `git-conflicts.ts` + `detectGit`) @
//! 91ec558. The TS shelled out to the git CLI for every op; here everything
//! runs on git2 in-process. Wire shapes are the shared/rpc.ts git types
//! byte-compatible; list-shaped commands swallow git errors and answer their
//! empty default exactly like the TS's try/catch, op-shaped ones return
//! `{ok: false, error}` instead of rejecting.
//!
//! Scope resolution is the TS chain: the active session's worktree path
//! first (the v2 `session_worktree` side table — the TS read the legacy
//! JSON row's `worktree.path`), then the workspace's main checkout.
//!
//! Deviations from the 91ec558 CLI behavior, all structural to libgit2:
//! - No hooks ever run (no prepare-commit-msg co-author trailer on
//!   gitCommit/gitAmend — the settings.rs M-port decision).
//! - Error strings are libgit2 messages, not `git exit N: <stderr>`; the
//!   ok flag is the contract the renderer consumes.
//! - Short shas are a fixed 7 chars (`--short`'s auto-scaling needs an
//!   object-db uniqueness scan; 7 matches every repo small enough to test).
//! - Network auth: the CLI inherited the login-shell env and used
//!   credential helpers + ssh-agent implicitly. git2 gets the same stack
//!   explicitly: `ssh_key_from_agent` (SSH_AUTH_SOCK) for SSH remotes and
//!   one `git credential fill` subprocess per HTTPS op for the configured
//!   helpers (osxkeychain & co) — the only `git` CLI subprocess this
//!   domain spawns, run non-interactively (GIT_TERMINAL_PROMPT=0).
//! - The watcher push (`gitChanged` messages debounced off fs events)
//!   stays dormant — the bridge has no git push channel yet; the panel
//!   re-polls on its existing triggers.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};

use git2::{
    build::CheckoutBuilder, BranchType, Cred, CredentialType, Delta, Diff, DiffDelta, DiffFormat,
    DiffLine, DiffOptions, FetchOptions, IndexAddOption, MergeOptions, Oid, PushOptions,
    RemoteCallbacks, Repository, ResetType, Sort, StashFlags, Status, StatusOptions,
};
use serde::{Deserialize, Serialize};
use tide_store::sessions_v2::SessionsV2;

use crate::state::AppState;

use super::worktree;

// ── wire shapes (shared/rpc.ts git domain + DiffHunk/DiffLine) ───────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GitFileChangeWire {
    pub path: String,
    pub status: &'static str,
    pub staged: bool,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GitCommitWire {
    pub sha: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub parents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_head: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_heads: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchDetailedWire {
    pub name: String,
    pub is_remote: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub short_sha: String,
    pub subject: String,
    pub last_commit_unix: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GitConflictEntryWire {
    pub path: String,
    pub state: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GitStashWire {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfoResultWire {
    pub branch: Option<String>,
    pub head_commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GitAheadBehindResultWire {
    pub ahead: usize,
    pub behind: usize,
}

/// `DiffHunk` in src/types — the renderer diff viewer's exact shape.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DiffHunkWire {
    pub header: String,
    pub lines: Vec<DiffLineWire>,
}

/// `DiffLine` in src/types — `type` keeps the TS literal spelling, absent
/// side numbers are omitted like the TS parser left them undefined.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DiffLineWire {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_no: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_no: Option<u32>,
    pub text: String,
}

/// `GitOpResult` — `{ok}` or `{ok: false, error}`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GitOpResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Fold a git error into an op result (each type keeps its `ok` shape with
/// the error string attached).
trait WithGitError: Clone {
    fn with_error(self, error: String) -> Self;
}

impl WithGitError for GitOpResultWire {
    fn with_error(self, error: String) -> Self {
        GitOpResultWire { ok: false, error: Some(error) }
    }
}

impl WithGitError for GitCommitResultWire {
    fn with_error(self, error: String) -> Self {
        GitCommitResultWire { ok: false, sha: None, error: Some(error) }
    }
}

impl WithGitError for GitRevertResultWire {
    fn with_error(self, error: String) -> Self {
        GitRevertResultWire { ok: false, new_sha: None, error: Some(error) }
    }
}

impl WithGitError for GitMergeResultWire {
    fn with_error(self, error: String) -> Self {
        GitMergeResultWire { ok: false, conflicts: None, error: Some(error) }
    }
}

impl GitOpResultWire {
    pub fn ok() -> Self {
        Self { ok: true, error: None }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self { ok: false, error: Some(message.into()) }
    }
}

/// `GitCommitResult`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `GitRevertResult`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRevertResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `GitMergeResult`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GitMergeResultWire {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<Vec<GitConflictEntryWire>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `GitRepoInfo` — `{...detectGit(), isRepo: true}` or null.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfoWire {
    pub branch: String,
    pub head_commit: String,
    pub file_count: usize,
    pub is_repo: bool,
}

/// `gitBulk` params' `opts?: { message?: string }`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct GitBulkOptsWire {
    pub message: Option<String>,
}

// ── scope resolution (the TS resolveGitCwd chain) ───────────────────────

fn resolve_git_cwd(
    state: &AppState,
    workspace_id: &str,
    session_id: Option<&str>,
) -> Result<Option<PathBuf>, super::CommandError> {
    if let Some(session_id) = session_id.filter(|s| !s.is_empty()) {
        if let Some(path) = session_worktree_path(state, session_id)? {
            return Ok(Some(path));
        }
    }
    let path = state.read_config(|cfg| {
        cfg.workspaces
            .iter()
            .find(|ws| ws.id == workspace_id)
            .map(|ws| ws.path.clone())
    })?;
    // The TS passed the stored path straight to spawn's cwd (a `~/` path
    // errored into the empty-default branch); expanding it is strictly more
    // useful and the wire behavior for real paths is identical.
    Ok(path.map(|p| PathBuf::from(worktree::expand_home(&p))))
}

fn session_worktree_path(
    state: &AppState,
    session_id: &str,
) -> Result<Option<PathBuf>, super::CommandError> {
    let db = state.sessions_db_path();
    if !db.is_file() {
        return Ok(None);
    }
    let store = match SessionsV2::open(&db) {
        Ok(store) => store,
        Err(_) => return Ok(None),
    };
    let worktree = store.session_worktree_of(session_id).ok().flatten();
    Ok(worktree
        .and_then(|value| {
            value
                .get("path")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .map(|p| PathBuf::from(worktree::expand_home(&p))))
}

// ── shared helpers ──────────────────────────────────────────────────────

/// `rev-parse --short HEAD` parity: 7 hex chars.
fn short_sha(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

/// Strict ISO-8601 like git's `%aI`, from a unix timestamp + signature UTC
/// offset in minutes (e.g. `2026-08-27T09:41:00+02:00`).
fn iso_time(secs: i64, offset_minutes: i32) -> String {
    let local = secs + i64::from(offset_minutes) * 60;
    let days = local.div_euclid(86_400);
    let rem = local.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let om = offset_minutes.unsigned_abs();
    format!(
        "{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}{sign}{:02}:{:02}",
        om / 60,
        om % 60
    )
}

/// days-since-epoch → (y, m, d) — Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `resolveInsideWorkspace(root, rel)` — the lexical containment the TS
/// enforced before letting a panel-supplied path near git.
fn contained_rel_path(root: &Path, rel: &str) -> Result<String, String> {
    let full = worktree::lexical_join(root, rel);
    match full.strip_prefix(root).ok() {
        Some(rest) if !rest.as_os_str().is_empty() => {
            Ok(rest.to_string_lossy().replace('\\', "/"))
        }
        _ => Err(format!("Path \"{rel}\" escapes the repository root")),
    }
}

/// clampContextLines (src/lib/diff/expand-context.ts): absent → git default;
/// ladder values clamp to 1..200; >= 1000 is the full-file sentinel.
fn clamp_context_lines(n: Option<u32>) -> Option<u32> {
    let n = n?;
    if n >= 1000 {
        return Some(n);
    }
    Some(n.clamp(1, 200))
}

/// The (x, y) porcelain code pair for a git2 status — the TS status mapper
/// keyed off these characters directly.
fn porcelain_xy(s: Status) -> (char, char) {
    if s.is_wt_new() && !s.is_index_new() {
        return ('?', '?');
    }
    let x = if s.is_conflicted() {
        'U'
    } else if s.is_index_new() {
        'A'
    } else if s.is_index_modified() {
        'M'
    } else if s.is_index_deleted() {
        'D'
    } else if s.is_index_renamed() {
        'R'
    } else if s.is_index_typechange() {
        'T'
    } else {
        ' '
    };
    let y = if s.is_conflicted() {
        'U'
    } else if s.is_wt_modified() {
        'M'
    } else if s.is_wt_deleted() {
        'D'
    } else if s.is_wt_renamed() {
        'R'
    } else if s.is_wt_typechange() {
        'T'
    } else {
        ' '
    };
    (x, y)
}

/// The TS status mapping, verbatim: untracked/added/deleted/renamed/modified
/// with the staged flag from the x column.
fn status_word_and_staged(x: char, y: char) -> (&'static str, bool) {
    if x == '?' && y == '?' {
        ("untracked", false)
    } else if x == 'A' {
        ("added", true)
    } else if x == 'D' || y == 'D' {
        ("deleted", x == 'D')
    } else if x == 'R' {
        ("renamed", true)
    } else if x == 'M' || y == 'M' {
        ("modified", x == 'M')
    } else {
        ("modified", x != ' ' && x != '?')
    }
}

fn open_repo(root: &Path) -> Result<Repository, String> {
    Repository::open(root).map_err(|e| format!("not a git repository ({}): {e}", root.display()))
}

/// Resolve the scope → open the repo → run. Any failure (no scope, no repo,
/// git error) answers the command's empty default, exactly like the TS
/// wrapper's try/catch.
fn with_root<T: Clone>(
    state: &AppState,
    workspace_id: &str,
    session_id: Option<&str>,
    default: T,
    run: impl FnOnce(&Path, &Repository) -> Result<T, String>,
) -> Result<T, super::CommandError> {
    let Some(root) = resolve_git_cwd(state, workspace_id, session_id)? else {
        return Ok(default);
    };
    match open_repo(&root) {
        Ok(repo) => Ok(run(&root, &repo).unwrap_or(default)),
        Err(_) => Ok(default),
    }
}

/// Resolve the scope → open the repo → run an op. No scope → the caller's
/// `no workspace` result; open/git errors become `{ok: false, error}`.
fn with_root_op<T: WithGitError>(
    state: &AppState,
    workspace_id: &str,
    session_id: Option<&str>,
    no_workspace: T,
    run: impl FnOnce(&Path, &Repository) -> Result<T, String>,
) -> Result<T, super::CommandError> {
    let Some(root) = resolve_git_cwd(state, workspace_id, session_id)? else {
        return Ok(no_workspace);
    };
    Ok(open_repo(&root).and_then(|repo| run(&root, &repo)).unwrap_or_else(|error| {
        no_workspace.clone().with_error(error)
    }))
}

// ── gitStatus ───────────────────────────────────────────────────────────

fn status_entries(repo: &Repository) -> Result<Vec<GitFileChangeWire>, String> {
    // numstat came from `git diff HEAD` — tracked changes (staged + unstaged)
    // vs HEAD; untracked files read 0/0. Unborn HEAD → the TS call failed and
    // every entry stayed 0/0.
    let mut stats: HashMap<String, (u32, u32)> = HashMap::new();
    if let Some(head_tree) = repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        if let Ok(diff) = repo.diff_tree_to_workdir_with_index(Some(&head_tree), None) {
            let current: RefCell<Option<String>> = RefCell::new(None);
            let mut file_cb = |delta: DiffDelta<'_>, _f: f32| -> bool {
                *current.borrow_mut() = delta_path(&delta);
                true
            };
            let mut line_cb =
                |_delta: DiffDelta<'_>, _hunk: Option<git2::DiffHunk<'_>>, line: DiffLine<'_>| -> bool {
                    if let Some(path) = current.borrow().as_ref() {
                        let entry = stats.entry(path.clone()).or_insert((0, 0));
                        match line.origin() {
                            '+' => entry.0 += 1,
                            '-' => entry.1 += 1,
                            _ => {}
                        }
                    }
                    true
                };
            let _ = diff.foreach(&mut file_cb, None, None, Some(&mut line_cb));
        }
    }

    let mut opts = StatusOptions::new();
    // -uall (untracked dirs expanded to files) + rename detection, like
    // porcelain.
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for entry in statuses.iter() {
        let mut path = String::from_utf8_lossy(entry.path_bytes()).into_owned();
        // libgit2 keys rename entries by the OLD path; porcelain (and the TS
        // `old -> new` split) reports the new one.
        if entry.status().is_index_renamed() || entry.status().is_wt_renamed() {
            if let Some(new_path) = entry
                .head_to_index()
                .or_else(|| entry.index_to_workdir())
                .and_then(|d| d.new_file().path().map(|p| p.to_string_lossy().into_owned()))
            {
                path = new_path;
            }
        }
        let base_name = path.rsplit('/').next().unwrap_or_default();
        // macOS metadata noise and dir-shaped entries never render (and must
        // not be discardable) — the TS skip.
        if base_name.is_empty() || base_name == ".DS_Store" {
            continue;
        }
        let (x, y) = porcelain_xy(entry.status());
        let (status, staged) = status_word_and_staged(x, y);
        let (additions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
        out.push(GitFileChangeWire { path, status, staged, additions, deletions });
    }
    Ok(out)
}

fn delta_path(delta: &DiffDelta<'_>) -> Option<String> {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|p| p.to_string_lossy().into_owned())
}

// ── diff machinery (DiffHunk parity with parseUnifiedDiff) ───────────────

/// Walk libgit2's Patch printer: 'H' lines open hunks (header = the raw
/// `@@ ... @@` text), '+'/'-'/' ' lines carry the TS's prefix-included
/// `text` and libgit2's own old/new line numbers. EOFNL markers ('=' '>' '<')
/// are skipped like the parser's `\\` skip.
fn diff_hunks(diff: &Diff<'_>) -> Vec<DiffHunkWire> {
    let mut hunks: Vec<DiffHunkWire> = Vec::new();
    let mut cb =
        |_d: git2::DiffDelta<'_>, _h: Option<git2::DiffHunk<'_>>, line: DiffLine<'_>| -> bool {
            match line.origin() {
                'H' => hunks.push(DiffHunkWire {
                    header: strip_eol(&String::from_utf8_lossy(line.content())).to_owned(),
                    lines: Vec::new(),
                }),
                '+' | '-' | ' ' => {
                    let kind = match line.origin() {
                        '+' => "add",
                        '-' => "del",
                        _ => "context",
                    };
                    if let Some(hunk) = hunks.last_mut() {
                        hunk.lines.push(DiffLineWire {
                            kind,
                            old_no: line.old_lineno(),
                            new_no: line.new_lineno(),
                            text: format!(
                                "{}{}",
                                line.origin(),
                                strip_eol(&String::from_utf8_lossy(line.content()))
                            ),
                        });
                    }
                }
                _ => {}
            }
            true
        };
    let _ = diff.print(DiffFormat::Patch, &mut cb);
    hunks
}

/// Raw unified patch text — `git diff --cached`'s exact surface (file
/// headers, hunks, EOFNL markers) for the commit-writer prompt.
fn diff_patch_text(diff: &Diff<'_>) -> String {
    let mut out = String::new();
    let mut cb =
        |_d: git2::DiffDelta<'_>, _h: Option<git2::DiffHunk<'_>>, line: DiffLine<'_>| -> bool {
            match line.origin() {
                '+' | '-' | ' ' => out.push(line.origin()),
                _ => {}
            }
            out.push_str(&String::from_utf8_lossy(line.content()));
            true
        };
    let _ = diff.print(DiffFormat::Patch, &mut cb);
    out
}

fn strip_eol(s: &str) -> &str {
    s.strip_suffix('\n').unwrap_or(s)
}

fn single_file_diff<'r>(
    repo: &'r Repository,
    rel: &str,
    staged: bool,
    context_lines: Option<u32>,
) -> Result<Diff<'r>, String> {
    let mut opts = DiffOptions::new();
    opts.pathspec(rel);
    if let Some(n) = clamp_context_lines(context_lines) {
        opts.context_lines(n);
    }
    let diff = if staged {
        // `git diff --cached`: vs HEAD, or vs the empty tree when unborn
        // (the CLI shows staged files as added pre-first-commit).
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let index = repo.index().map_err(|e| e.to_string())?;
        repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
    };
    diff.map_err(|e| e.to_string())
}

// ── gitLog ──────────────────────────────────────────────────────────────

fn log_entries(repo: &Repository, limit: Option<u32>) -> Vec<GitCommitWire> {
    let Some(head) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) else {
        return Vec::new();
    };
    let limit = limit.unwrap_or(100) as usize;

    let mut walk = match repo.revwalk() {
        Ok(walk) => walk,
        Err(_) => return Vec::new(),
    };
    if walk.set_sorting(Sort::TIME).is_err() || walk.push(head.id()).is_err() {
        return Vec::new();
    }

    // Decorations: branch tips and tags keyed by the ref TARGET's short sha.
    // The TS's annotated-tag peel pass was dead code (its format string had
    // no field separator), so annotated tags key on the tag object's sha and
    // land on no commit row — reproduced by never peeling.
    let mut head_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut tag_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(refs) = repo.references() {
        for reference in refs.flatten() {
            let Some(name) = reference.name().ok().map(str::to_owned) else {
                continue;
            };
            let (map, short_name) = if let Some(short) = name.strip_prefix("refs/heads/") {
                (&mut head_map, short.to_owned())
            } else if let Some(short) = name.strip_prefix("refs/tags/") {
                (&mut tag_map, short.to_owned())
            } else {
                continue;
            };
            if let Some(target) = reference.target() {
                map.entry(short_sha(target)).or_default().push(short_name);
            }
        }
    }
    let head_short = short_sha(head.id());

    let mut out = Vec::new();
    for oid in walk.take(limit).map_while(Result::ok) {
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let author = commit.author();
        let short = short_sha(commit.id());
        let parents: Vec<String> = (0..commit.parent_count())
            .map(|i| commit.parent_id(i).map(short_sha).unwrap_or_default())
            .collect();
        out.push(GitCommitWire {
            sha: short.clone(),
            author: author.name().map(str::to_owned).unwrap_or_default(),
            date: iso_time(author.when().seconds(), author.when().offset_minutes()),
            subject: commit.summary().ok().flatten().map(str::to_owned).unwrap_or_default(),
            parents,
            is_head: Some(short == head_short),
            branch_heads: head_map.get(&short).cloned(),
            tags: tag_map.get(&short).cloned(),
        });
    }
    out
}

// ── commit inspection ───────────────────────────────────────────────────

/// `git diff-tree --root -r <sha>` — the commit vs its first parent (empty
/// tree for root commits). No rename detection, like the plumbing call.
fn commit_tree_diff<'r>(repo: &'r Repository, sha: &str) -> Result<Diff<'r>, String> {
    let commit = repo
        .revparse_single(sha)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| format!("unknown revision {sha}: {e}"))?;
    let this_tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&this_tree), None)
        .map_err(|e| e.to_string())
}

/// numstat per delta — '+'/'-' line counts (binary files count 0/0).
fn diff_numstat(diff: &Diff<'_>) -> HashMap<String, (u32, u32)> {
    let stats: RefCell<HashMap<String, (u32, u32)>> = RefCell::new(HashMap::new());
    let current: RefCell<Option<String>> = RefCell::new(None);
    let mut file_cb = |delta: DiffDelta<'_>, _f: f32| -> bool {
        *current.borrow_mut() = delta_path(&delta);
        true
    };
    let mut line_cb =
        |_delta: DiffDelta<'_>, _hunk: Option<git2::DiffHunk<'_>>, line: DiffLine<'_>| -> bool {
            if let Some(path) = current.borrow().as_ref() {
                let mut stats = stats.borrow_mut();
                let entry = stats.entry(path.clone()).or_insert((0, 0));
                match line.origin() {
                    '+' => entry.0 += 1,
                    '-' => entry.1 += 1,
                    _ => {}
                }
            }
            true
        };
    let _ = diff.foreach(&mut file_cb, None, None, Some(&mut line_cb));
    stats.into_inner()
}

fn delta_status_word(status: Delta) -> &'static str {
    match status {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Renamed => "renamed",
        _ => "modified",
    }
}

fn commit_files(repo: &Repository, sha: &str) -> Result<Vec<GitFileChangeWire>, String> {
    let diff = commit_tree_diff(repo, sha)?;
    let numstat = diff_numstat(&diff);
    let mut out = Vec::new();
    for delta in diff.deltas() {
        // Renames/copies report the new path last — everything else has a
        // single path.
        let Some(path) = delta_path(&delta) else {
            continue;
        };
        let (additions, deletions) = numstat.get(&path).copied().unwrap_or((0, 0));
        out.push(GitFileChangeWire {
            path,
            status: delta_status_word(delta.status()),
            staged: true,
            additions,
            deletions,
        });
    }
    Ok(out)
}

// ── index / worktree mutations ──────────────────────────────────────────

fn stage_or_unstage_file(repo: &Repository, rel: &str, stage: bool) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    if stage {
        // `git add -- <path>`: stage the workdir state, deletions included.
        let exists = repo.workdir().map(|w| w.join(rel).exists()).unwrap_or(false);
        if exists {
            index.add_path(Path::new(rel)).map_err(|e| e.to_string())?;
        } else {
            index.remove_path(Path::new(rel)).map_err(|e| e.to_string())?;
        }
        index.write().map_err(|e| e.to_string())?;
    } else {
        // `git restore --staged -- <path>`: reset the index entry to HEAD
        // (empty tree when HEAD is unborn → the path untracks).
        let target = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.as_object().to_owned());
        repo.reset_default(target.as_ref(), [rel])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn stage_all(repo: &Repository) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    // `git add -A`: new/untracked files + updates (and deletions) of tracked
    // files; ignored files left alone.
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.update_all(["*"], None).map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

fn unstage_all(repo: &Repository) -> Result<(), String> {
    // `git restore --staged .`: the index becomes HEAD's tree; unborn HEAD →
    // an empty index (everything untracks).
    let tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut index = repo.index().map_err(|e| e.to_string())?;
    match tree {
        Some(tree) => index.read_tree(&tree).map_err(|e| e.to_string())?,
        None => index.clear().map_err(|e| e.to_string())?,
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

/// `git restore --staged --worktree .` + `git clean -fd`.
fn restore_all(repo: &Repository) -> Result<(), String> {
    let head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .ok_or_else(|| "could not resolve HEAD".to_string())?;
    repo.reset(head.as_object(), ResetType::Hard, None)
        .map_err(|e| e.to_string())?;
    clean_untracked(repo);
    Ok(())
}

/// `clean -fd` — remove untracked files and directories (ignored files
/// stay). Untracked dirs surface as a single trailing-slash entry when
/// recursion is off, which is exactly the unit clean removes.
fn clean_untracked(repo: &Repository) {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    let Ok(statuses) = repo.statuses(Some(&mut opts)) else {
        return;
    };
    let Some(workdir) = repo.workdir().map(|p| p.to_path_buf()) else {
        return;
    };
    for entry in statuses.iter() {
        let s = entry.status();
        if !(s.is_wt_new() && !s.is_index_new()) {
            continue;
        }
        let path = String::from_utf8_lossy(entry.path_bytes()).into_owned();
        let target = workdir.join(path.trim_end_matches('/'));
        if target.is_dir() {
            let _ = std::fs::remove_dir_all(target);
        } else {
            let _ = std::fs::remove_file(target);
        }
    }
}

fn discard_file(repo: &Repository, root: &Path, file_path: &str) -> Result<(), String> {
    let rel = contained_rel_path(root, file_path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    if index.get_path(Path::new(&rel), 0).is_some() {
        // Tracked: `git restore --worktree -- <path>` — reset the workdir
        // file from the index, staged content untouched.
        let mut opts = CheckoutBuilder::new();
        opts.force().path(rel.clone());
        repo.checkout_index(Some(&mut index), Some(&mut opts))
            .map_err(|e| e.to_string())?;
    } else {
        // Untracked: rm -rf the path.
        let abs = root.join(&rel);
        if abs.is_dir() {
            std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
        } else if abs.exists() {
            std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// `git checkout <sha> -- <path>`: restore content + index entry from the
/// commit; if the file did not exist there, it was created during the turn —
/// delete it from the worktree only (no index touch, the TS unlink).
fn restore_file(repo: &Repository, root: &Path, file_path: &str, sha: &str) -> Result<(), String> {
    let rel = contained_rel_path(root, file_path)?;
    let spec = format!("{sha}:{rel}");
    let blob = repo
        .revparse_single(&spec)
        .and_then(|o| o.peel_to_blob().map(|b| b.content().to_vec()));
    match blob {
        Ok(content) => {
            let mode = repo
                .revparse_single(sha)
                .and_then(|o| o.peel_to_commit())
                .and_then(|c| c.tree())
                .ok()
                .and_then(|tree| tree.get_path(Path::new(&rel)).ok())
                .map(|entry| entry.filemode())
                .unwrap_or(0o100644);
            write_workdir_file(repo, &rel, &content, mode as u32)?;
            let mut index = repo.index().map_err(|e| e.to_string())?;
            index.add_path(Path::new(&rel)).map_err(|e| e.to_string())?;
            index.write().map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(_) => {
            let abs = root.join(&rel);
            if abs.exists() {
                std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

/// Write blob content at a workdir path honoring the git file mode (exec
/// bit; symlinks materialize as links).
fn write_workdir_file(repo: &Repository, rel: &str, content: &[u8], mode: u32) -> Result<(), String> {
    let Some(workdir) = repo.workdir() else {
        return Err("bare repository".into());
    };
    let abs = workdir.join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if mode == 0o120000 {
        let target = String::from_utf8_lossy(content).into_owned();
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&abs);
            std::os::unix::fs::symlink(target, &abs).map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        {
            std::fs::write(&abs, content).map_err(|e| e.to_string())?;
        }
    } else {
        std::fs::write(&abs, content).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
            let _ = std::fs::set_permissions(&abs, std::fs::Permissions::from_mode(perms));
        }
    }
    Ok(())
}

// ── commit / amend / revert ─────────────────────────────────────────────

fn commit_staged(repo: &Repository, message: &str) -> Result<String, String> {
    let index = repo.index().map_err(|e| e.to_string())?;
    // `git commit` refuses an empty commit — mirror the check so the panel
    // surfaces ok:false instead of minting an empty commit git2 would allow.
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let dirty = match &head_tree {
        Some(tree) => repo
            .diff_tree_to_index(Some(tree), Some(&index), None)
            .map(|d| d.deltas().len() > 0)
            .unwrap_or(true),
        None => !index.is_empty(),
    };
    if !dirty {
        return Err("nothing to commit, working tree clean".into());
    }
    let parents: Vec<git2::Commit<'_>> =
        repo.head().ok().and_then(|h| h.peel_to_commit().ok()).into_iter().collect();
    let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
    commit_with_tree(repo, message, &parent_refs)
}

fn commit_with_tree(
    repo: &Repository,
    message: &str,
    parents: &[&git2::Commit<'_>],
) -> Result<String, String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = repo.signature().map_err(|e| e.to_string())?;
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, parents)
        .map_err(|e| e.to_string())?;
    Ok(short_sha(oid))
}

fn amend_head(repo: &Repository, message: Option<&str>) -> Result<String, String> {
    let head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .ok_or_else(|| "cannot amend: no HEAD".to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    // `--amend` keeps the original author (and parents); the committer is
    // "now". Without a (non-blank) message the original stays.
    let author = head.author();
    let committer = repo.signature().map_err(|e| e.to_string())?;
    let text = match message.map(str::trim) {
        Some(m) if !m.is_empty() => Some(m),
        _ => None,
    };
    let oid = head
        .amend(Some("HEAD"), Some(&author), Some(&committer), None, text, Some(&tree))
        .map_err(|e| e.to_string())?;
    Ok(short_sha(oid))
}

fn revert_commit(repo: &Repository, sha: &str) -> Result<String, String> {
    let commit = repo
        .revparse_single(sha)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| format!("unknown revision {sha}: {e}"))?;
    if commit.parent_count() > 1 {
        return Err(format!("revert {sha} is a merge commit, mainline required"));
    }
    // Applies the inverse to the index + workdir; conflicts surface as an
    // error here and leave the repo mid-revert for the resolve flow.
    repo.revert(&commit, None)
        .map_err(|e| format!("revert failed: {e}"))?;
    let subject = commit.summary().ok().flatten().unwrap_or("");
    let message = format!(
        "Revert \"{subject}\"\n\nThis reverts commit {}.",
        commit.id()
    );
    let head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .ok_or_else(|| "revert: no HEAD".to_string())?;
    let oid = commit_with_tree(repo, &message, &[&head])?;
    // The CLI clears MERGE_MSG/REVERT_HEAD once the commit lands.
    let _ = repo.cleanup_state();
    Ok(oid)
}

// ── branch ops ──────────────────────────────────────────────────────────

fn head_branch_name(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    head.shorthand().ok().map(String::from)
}

fn create_branch(repo: &Repository, branch_name: &str, sha: Option<&str>) -> Result<(), String> {
    let from = head_branch_name(repo);
    let commit = match sha {
        Some(sha) => repo
            .revparse_single(sha)
            .and_then(|o| o.peel_to_commit())
            .map_err(|e| format!("unknown revision {sha}: {e}"))?,
        None => repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .ok_or_else(|| "cannot create branch: no HEAD".to_string())?,
    };
    repo.branch(branch_name, &commit, false)
        .map_err(|e| format!("branch {branch_name}: {e}"))?;
    // `checkout -b`: move HEAD then check out the (identical) tree — SAFE
    // checkout keeps uncommitted changes like the CLI carries them.
    repo.set_head(&format!("refs/heads/{branch_name}"))
        .map_err(|e| e.to_string())?;
    repo.checkout_head(None).map_err(|e| e.to_string())?;
    log_checkout(repo, from.as_deref(), branch_name);
    Ok(())
}

fn delete_branch(repo: &Repository, name: &str, force: bool) -> Result<(), String> {
    let mut branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|e| format!("branch '{name}' not found: {e}"))?;
    if !force {
        // `-d` refuses unmerged branches — merged means an ancestor of HEAD.
        let branch_id = branch
            .get()
            .peel_to_commit()
            .map_err(|e| e.to_string())?
            .id();
        let merged = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .and_then(|head| repo.merge_base(head.id(), branch_id).ok())
            .map(|base| base == branch_id)
            .unwrap_or(false);
        if !merged {
            return Err(format!(
                "The branch '{name}' is not fully merged. If you are sure you want to delete it, run again with force."
            ));
        }
    }
    branch.delete().map_err(|e| e.to_string())?;
    Ok(())
}

fn checkout_branch(repo: &Repository, branch: &str) -> Result<(), String> {
    let from = head_branch_name(repo);
    let refname = format!("refs/heads/{branch}");
    let reference = repo
        .find_reference(&refname)
        .map_err(|_| format!("pathspec '{branch}' did not match any file(s) known to git"))?;
    let commit = reference.peel_to_commit().map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    // SAFE checkout refuses to clobber uncommitted changes — the CLI's
    // dirty-tree refusal — while carrying non-conflicting ones over.
    repo.checkout_tree(tree.as_object(), None)
        .map_err(|e| format!("checkout '{branch}': {e}"))?;
    repo.set_head(reference.name().unwrap_or(&refname))
        .map_err(|e| e.to_string())?;
    log_checkout(repo, from.as_deref(), branch);
    Ok(())
}

/// The CLI writes "checkout: moving from A to B" into HEAD's reflog on every
/// branch switch (what gitRecentBranches parses) — libgit2 does not, so the
/// port maintains it itself.
fn log_checkout(repo: &Repository, from: Option<&str>, to: &str) {
    let Some(from) = from else { return };
    let Ok(mut reflog) = repo.reflog("HEAD") else {
        return;
    };
    let Some(id) = repo.head().ok().and_then(|h| h.target()) else {
        return;
    };
    if let Ok(signature) = repo.signature() {
        let _ = reflog.append(
            id,
            &signature,
            Some(&format!("checkout: moving from {from} to {to}")),
        );
    }
}

fn recent_branches(repo: &Repository) -> Vec<String> {
    let current = head_branch_name(repo).unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut ordered: Vec<String> = Vec::new();
    // `git reflog show` lists newest first — the reflog iterates in file
    // order, which is newest-first.
    if let Ok(reflog) = repo.reflog("HEAD") {
        for entry in reflog.iter() {
            let Some(message) = entry.message().ok().flatten() else {
                continue;
            };
            let Some(rest) = message.split("moving from ").nth(1) else {
                continue;
            };
            let mut parts = rest.splitn(2, " to ");
            let from = parts.next().unwrap_or_default();
            let to = parts.next();
            // "to" first — the most recently visited branch.
            for candidate in to.into_iter().chain(std::iter::once(from)) {
                if !candidate.is_empty() && candidate != current && seen.insert(candidate.to_owned())
                {
                    ordered.push(candidate.to_owned());
                }
            }
        }
        if !ordered.is_empty() {
            ordered.truncate(5);
            return ordered;
        }
    }
    // Fallback: local branches by latest commit date.
    let mut branches: Vec<(String, i64)> = Vec::new();
    if let Ok(iter) = repo.branches(Some(BranchType::Local)) {
        for (branch, _) in iter.flatten() {
            if let Some(name) = branch.name().ok().flatten() {
                let name = name.to_owned();
                if name == current {
                    continue;
                }
                let date = branch
                    .get()
                    .peel_to_commit()
                    .map(|c| c.time().seconds())
                    .unwrap_or(0);
                branches.push((name, date));
            }
        }
    }
    branches.sort_by_key(|(_, date)| std::cmp::Reverse(*date));
    branches.into_iter().take(5).map(|(name, _)| name).collect()
}

fn branches_detailed(repo: &Repository) -> Vec<GitBranchDetailedWire> {
    let mut out = Vec::new();
    for branch_type in [BranchType::Local, BranchType::Remote] {
        let is_remote = branch_type == BranchType::Remote;
        let Ok(iter) = repo.branches(Some(branch_type)) else {
            continue;
        };
        for (branch, _) in iter.flatten() {
            let Some(name) = branch.name().ok().flatten().map(str::to_owned) else {
                continue;
            };
            // The origin/HEAD symref is excluded from the panel list.
            if is_remote && name == "origin/HEAD" {
                continue;
            }
            let Ok(commit) = branch.get().peel_to_commit() else {
                continue;
            };
            let upstream = if is_remote {
                None
            } else {
                branch
                    .upstream()
                    .ok()
                    .and_then(|u| u.name().ok().flatten().map(String::from))
            };
            let (ahead, behind) = match &upstream {
                Some(upstream_name) => repo
                    .find_branch(upstream_name, BranchType::Remote)
                    .or_else(|_| repo.find_branch(upstream_name, BranchType::Local))
                    .and_then(|u| u.get().peel_to_commit())
                    .ok()
                    .and_then(|upstream_tip| repo.graph_ahead_behind(commit.id(), upstream_tip.id()).ok())
                    .map(|(ahead, behind)| (Some(ahead), Some(behind)))
                    .unwrap_or((None, None)),
                None => (None, None),
            };
            out.push(GitBranchDetailedWire {
                name,
                is_remote,
                upstream,
                short_sha: short_sha(commit.id()),
                subject: commit.summary().ok().flatten().map(str::to_owned).unwrap_or_default(),
                last_commit_unix: commit.time().seconds(),
                ahead,
                behind,
            });
        }
    }
    out
}

// ── merge / conflicts / resolve ─────────────────────────────────────────

/// The seven porcelain conflict codes, derived from which index stages
/// survive: (ancestor=1, ours=2, theirs=3).
fn conflict_state_of(conflict: &git2::IndexConflict) -> Option<&'static str> {
    match (
        conflict.ancestor.is_some(),
        conflict.our.is_some(),
        conflict.their.is_some(),
    ) {
        (true, true, true) => Some("both-modified"),
        (false, true, true) => Some("both-added"),
        (true, false, false) => Some("both-deleted"),
        (false, true, false) => Some("added-by-us"),
        (false, false, true) => Some("added-by-them"),
        (true, false, true) => Some("deleted-by-us"),
        (true, true, false) => Some("deleted-by-them"),
        (false, false, false) => None,
    }
}

fn conflict_entries(repo: &Repository) -> Vec<GitConflictEntryWire> {
    let Ok(index) = repo.index() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Ok(conflicts) = index.conflicts() else {
        return Vec::new();
    };
    for conflict in conflicts.flatten() {
        let Some(entry) = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
        else {
            continue;
        };
        let path = String::from_utf8_lossy(&entry.path).into_owned();
        if let Some(state) = conflict_state_of(&conflict) {
            out.push(GitConflictEntryWire { path, state });
        }
    }
    out
}

fn merge_branch(repo: &Repository, name: &str) -> Result<GitMergeResultWire, String> {
    let reference = repo
        .find_reference(&format!("refs/heads/{name}"))
        .map_err(|e| format!("merge: {name} — {e}"))?;
    let commit = reference.peel_to_commit().map_err(|e| e.to_string())?;
    let annotated = repo
        .reference_to_annotated_commit(&reference)
        .map_err(|e| e.to_string())?;
    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    let (analysis, _) = repo.merge_analysis(&[&annotated]).map_err(|e| e.to_string())?;
    if analysis.is_up_to_date() {
        return Ok(GitMergeResultWire { ok: true, conflicts: None, error: None });
    }
    if analysis.is_fast_forward() || analysis.is_unborn() {
        fast_forward_to(repo, &commit, "merge: Fast-forward").map_err(|e| e.to_string())?;
        return Ok(GitMergeResultWire { ok: true, conflicts: None, error: None });
    }
    let Some(head) = head else {
        return Err("merge: no HEAD".into());
    };

    let mut checkout = CheckoutBuilder::new();
    checkout
        .allow_conflicts(true)
        .conflict_style_merge(true)
        .force();
    if let Err(error) = repo.merge(&[&annotated], Some(&mut MergeOptions::new()), Some(&mut checkout))
    {
        // A failed merge may still have left conflicts staged — surface them
        // for the resolve flow like the TS's error-path re-list.
        let conflicts = conflict_entries(repo);
        if !conflicts.is_empty() {
            return Ok(GitMergeResultWire {
                ok: false,
                conflicts: Some(conflicts),
                error: None,
            });
        }
        return Ok(GitMergeResultWire {
            ok: false,
            conflicts: None,
            error: Some(error.to_string()),
        });
    }
    let index = repo.index().map_err(|e| e.to_string())?;
    if index.has_conflicts() {
        return Ok(GitMergeResultWire {
            ok: false,
            conflicts: Some(conflict_entries(repo)),
            error: None,
        });
    }

    // The CLI's `--no-edit` message: "Merge branch 'x'" (no "into" on the
    // default branch names), parents HEAD + theirs.
    let current = head_branch_name(repo).unwrap_or_default();
    let message = if current.is_empty() || current == "master" || current == "main" {
        format!("Merge branch '{name}'")
    } else {
        format!("Merge branch '{name}' into {current}")
    };
    commit_with_tree(repo, &message, &[&head, &commit]).map_err(|e| e.to_string())?;
    let _ = repo.cleanup_state();
    Ok(GitMergeResultWire { ok: true, conflicts: None, error: None })
}

/// Move HEAD's branch (or detached HEAD) to the target and check out its
/// tree — the `git merge` / `git pull --ff-only` fast-forward.
fn fast_forward_to(
    repo: &Repository,
    target: &git2::Commit<'_>,
    reflog: &str,
) -> Result<(), git2::Error> {
    let mut checkout = CheckoutBuilder::new();
    checkout.force();
    repo.checkout_tree(target.as_object(), Some(&mut checkout))?;
    match repo.head() {
        Ok(head) if head.is_branch() => {
            let name = head.name().unwrap_or("HEAD").to_owned();
            repo.reference(&name, target.id(), true, reflog).map(|_| ())
        }
        _ => repo.set_head_detached(target.id()),
    }
}

/// `gitResolveFile`: pick a side for one conflicted path and stage the
/// resolution. A side that deleted the file → `git rm` semantics (drop the
/// workdir file + index entries, recording the deletion); otherwise the
/// side's blob is materialized in the worktree and staged.
fn resolve_file(repo: &Repository, root: &Path, file_path: &str, side: &str) -> Result<GitOpResultWire, String> {
    let rel = contained_rel_path(root, file_path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let Some(conflict) = index.conflict_get(Path::new(&rel)).ok() else {
        return Ok(GitOpResultWire::err(format!("{rel} is not unmerged")));
    };
    let chosen = if side == "theirs" {
        &conflict.their
    } else {
        &conflict.our
    };
    match chosen {
        None => {
            // The chosen side deleted the file — record the deletion.
            if let Some(workdir) = repo.workdir() {
                let _ = std::fs::remove_file(workdir.join(&rel));
            }
            index.conflict_remove(Path::new(&rel)).map_err(|e| e.to_string())?;
            // A stage-0 entry shouldn't coexist with conflicts, but a stale
            // one must not survive as a ghost.
            let _ = index.remove_path(Path::new(&rel));
        }
        Some(entry) => {
            let blob = repo.find_blob(entry.id).map_err(|e| e.to_string())?;
            write_workdir_file(repo, &rel, blob.content(), entry.mode)?;
            index.conflict_remove(Path::new(&rel)).map_err(|e| e.to_string())?;
            index.add_path(Path::new(&rel)).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(GitOpResultWire::ok())
}

// ── stash ───────────────────────────────────────────────────────────────

fn stash_save(repo: &mut Repository, message: Option<&str>) -> Result<(), String> {
    // `git stash push` with nothing to stash exits 0 — libgit2 errors, so
    // gate it on real changes first.
    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    let has_changes = repo
        .statuses(Some(&mut opts))
        .map(|statuses| statuses.iter().any(|e| !e.status().is_empty() && !e.status().is_ignored()))
        .unwrap_or(false);
    if !has_changes {
        return Ok(());
    }
    let stasher = repo.signature().map_err(|e| e.to_string())?;
    repo.stash_save2(&stasher, message, Some(StashFlags::INCLUDE_UNTRACKED))
        .map_err(|e| format!("stash: {e}"))?;
    Ok(())
}

fn stash_pop(repo: &mut Repository) -> Result<(), String> {
    repo.stash_pop(0, None)
        .map_err(|e| format!("stash pop: {e}"))
}

fn stash_list(repo: &mut Repository) -> Vec<GitStashWire> {
    let mut out = Vec::new();
    let _ = repo.stash_foreach(|index, message, _| {
        out.push(GitStashWire {
            // `git stash list` renders "stash@{0}: On main: msg" — ref before
            // the first ':', message after.
            ref_name: format!("stash@{{{index}}}"),
            message: message.to_owned(),
        });
        true
    });
    out
}

// ── network ops (fetch / pull / push) ───────────────────────────────────

/// The remote fetch/push fetch from: the current branch's configured remote
/// (branch.<name>.remote), else "origin" — what a bare `git fetch` picks.
fn default_remote_name(repo: &Repository) -> String {
    if let Some(branch) = head_branch_name(repo) {
        if let Ok(config) = repo.config() {
            if let Ok(remote) = config.get_string(&format!("branch.{branch}.remote")) {
                return remote;
            }
        }
    }
    "origin".to_owned()
}

/// The TS spawned the CLI with the login-shell env, so SSH went through
/// ssh-agent and HTTPS through the configured credential helpers. git2 gets
/// the same stack explicitly: agent keys for SSH remotes, and one
/// non-interactive `git credential fill` for HTTPS (the helpers themselves
/// are git's, so keychain/manager behave identically). This subprocess is
/// the domain's only git CLI use.
fn credential_helper_fill(
    workdir: &Path,
    url: &str,
    username: Option<&str>,
) -> Result<Cred, git2::Error> {
    let mut child = ProcessCommand::new("git")
        .args(["-c", "credential.interactive=false", "credential", "fill"])
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| git2::Error::from_str(&format!("credential helper spawn failed: {e}")))?;
    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| git2::Error::from_str("credential helper stdin unavailable"))?;
        let mut request = format!("url={url}\n");
        if let Some(username) = username {
            request.push_str(&format!("username={username}\n"));
        }
        request.push('\n');
        stdin
            .write_all(request.as_bytes())
            .map_err(|e| git2::Error::from_str(&format!("credential helper write failed: {e}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| git2::Error::from_str(&format!("credential helper failed: {e}")))?;
    let mut user: Option<String> = None;
    let mut password: Option<String> = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(value) = line.strip_prefix("username=") {
            user = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("password=") {
            password = Some(value.to_owned());
        }
    }
    match (user.or(username.map(str::to_owned)), password) {
        (Some(user), Some(password)) => Cred::userpass_plaintext(&user, &password),
        _ => Err(git2::Error::from_str(
            "credential helper produced no credentials",
        )),
    }
}

fn authed_callbacks(workdir: &Path) -> RemoteCallbacks<'static> {
    let workdir = workdir.to_path_buf();
    let mut agent_tried = false;
    let mut helper_tried = false;
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |url, username, allowed| {
        if allowed.contains(CredentialType::SSH_KEY) && !agent_tried {
            agent_tried = true;
            return Cred::ssh_key_from_agent(username.unwrap_or("git"));
        }
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) && !helper_tried {
            helper_tried = true;
            return credential_helper_fill(&workdir, url, username);
        }
        if allowed.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::from_str("no git credentials available"))
    });
    callbacks
}

fn fetch_remote(repo: &Repository) -> Result<(), String> {
    let remote_name = default_remote_name(repo);
    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|e| format!("'{remote_name}' does not appear to be a git repository: {e}"))?;
    let Some(workdir) = repo.workdir().map(|p| p.to_path_buf()) else {
        return Err("bare repository".into());
    };
    let mut options = FetchOptions::new();
    options.remote_callbacks(authed_callbacks(&workdir));
    // Empty refspec set = the remote's configured refspecs, like bare `git fetch`.
    remote
        .fetch(&[] as &[&str], Some(&mut options), None)
        .map_err(|e| e.to_string())
}

/// `git pull --ff-only`: fetch, then fast-forward HEAD's branch to its
/// upstream or fail.
fn pull(repo: &Repository) -> Result<(), String> {
    fetch_remote(repo)?;
    let upstream = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(String::from))
        .and_then(|name| repo.find_branch(&name, BranchType::Local).ok())
        .and_then(|branch| branch.upstream().ok())
        .ok_or_else(|| "no upstream configured for branch".to_string())?;
    let target = upstream.get().peel_to_commit().map_err(|e| e.to_string())?;
    let annotated = repo
        .reference_to_annotated_commit(upstream.get())
        .map_err(|e| e.to_string())?;
    let (analysis, _) = repo.merge_analysis(&[&annotated]).map_err(|e| e.to_string())?;
    if analysis.is_up_to_date() {
        return Ok(());
    }
    if analysis.is_fast_forward() {
        return fast_forward_to(repo, &target, "pull: Fast-forward").map_err(|e| e.to_string());
    }
    Err("Not possible to fast-forward, aborting.".into())
}

/// `git push` with an upstream, `git push -u origin HEAD` without.
fn push(repo: &Repository) -> Result<(), String> {
    let branch_name =
        head_branch_name(repo).ok_or_else(|| "You are not currently on a branch".to_string())?;
    let mut branch = repo
        .find_branch(&branch_name, BranchType::Local)
        .map_err(|e| e.to_string())?;
    let (remote_name, remote_branch) = match branch.upstream() {
        Ok(upstream) => {
            // "origin/main" → remote origin, remote branch main.
            let short = upstream
                .name()
                .ok()
                .flatten()
                .map(String::from)
                .unwrap_or_default();
            let remote_branch = short
                .split_once('/')
                .map(|(_, b)| b.to_owned())
                .unwrap_or(short);
            let remote_name = repo
                .config()
                .and_then(|c| c.get_string(&format!("branch.{branch_name}.remote")))
                .unwrap_or_else(|_| "origin".to_owned());
            (remote_name, remote_branch)
        }
        Err(_) => ("origin".to_owned(), branch_name.clone()),
    };
    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|e| format!("'{remote_name}' does not appear to be a git repository: {e}"))?;
    let Some(workdir) = repo.workdir().map(|p| p.to_path_buf()) else {
        return Err("bare repository".into());
    };
    let mut options = PushOptions::new();
    options.remote_callbacks(authed_callbacks(&workdir));
    let refspec = format!("refs/heads/{branch_name}:refs/heads/{remote_branch}");
    remote
        .push(&[refspec], Some(&mut options))
        .map_err(|e| e.to_string())?;
    // `push -u`: record the upstream for future bare pushes.
    if branch.upstream().is_err() {
        let _ = branch.set_upstream(Some(&format!("{remote_name}/{branch_name}")));
    }
    Ok(())
}

fn ahead_behind(repo: &Repository) -> Option<GitAheadBehindResultWire> {
    let head = repo.head().ok()?;
    let head_id = head.peel_to_commit().ok()?.id();
    let branch = head.shorthand().ok()?;
    let upstream = repo
        .find_branch(branch, BranchType::Local)
        .ok()?
        .upstream()
        .ok()?;
    let upstream_id = upstream.get().peel_to_commit().ok()?.id();
    let (ahead, behind) = repo.graph_ahead_behind(head_id, upstream_id).ok()?;
    Some(GitAheadBehindResultWire { ahead, behind })
}

/// `branchInfo`: live branch + short HEAD; detached heads read "HEAD" like
/// `rev-parse --abbrev-ref HEAD`, unborn reads null/null.
fn branch_info(repo: &Repository) -> GitBranchInfoResultWire {
    let Some(head) = repo.head().ok() else {
        return GitBranchInfoResultWire { branch: None, head_commit: None };
    };
    let branch = if head.is_branch() {
        head.shorthand().ok().map(String::from)
    } else {
        Some("HEAD".to_owned())
    };
    let head_commit = head.peel_to_commit().ok().map(|commit| short_sha(commit.id()));
    GitBranchInfoResultWire { branch, head_commit }
}

// ── commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn git_status(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<Vec<GitFileChangeWire>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), Vec::new(), |_root, repo| {
        status_entries(repo)
    })
}

#[tauri::command]
pub fn git_diff(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    file_path: String,
    staged: bool,
    context_lines: Option<u32>,
) -> Result<Vec<DiffHunkWire>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), Vec::new(), |root, repo| {
        let rel = contained_rel_path(root, &file_path)?;
        Ok(diff_hunks(&single_file_diff(repo, &rel, staged, context_lines)?))
    })
}

#[tauri::command]
pub fn git_staged_diff(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<serde_json::Value, super::CommandError> {
    let text =
        with_root(&state, &workspace_id, session_id.as_deref(), String::new(), |_root, repo| {
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            let index = repo.index().map_err(|e| e.to_string())?;
            repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
                .map(|diff| diff_patch_text(&diff))
                .map_err(|e| e.to_string())
        })?;
    Ok(serde_json::json!({ "text": text }))
}

#[tauri::command]
pub fn git_log(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<GitCommitWire>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), Vec::new(), |_root, repo| {
        Ok(log_entries(repo, limit))
    })
}

#[tauri::command]
pub fn git_commit_files(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    sha: String,
) -> Result<Vec<GitFileChangeWire>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), Vec::new(), |_root, repo| {
        commit_files(repo, &sha)
    })
}

#[tauri::command]
pub fn git_commit_file_diff(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    sha: String,
    file_path: String,
) -> Result<Vec<DiffHunkWire>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), Vec::new(), |root, repo| {
        let rel = contained_rel_path(root, &file_path)?;
        // `git diff-tree --root -p <sha> -- <path>`: the commit vs its first
        // parent, pathspec-limited at diff build time.
        let commit = repo
            .revparse_single(&sha)
            .and_then(|o| o.peel_to_commit())
            .map_err(|e| format!("unknown revision {sha}: {e}"))?;
        let this_tree = commit.tree().map_err(|e| e.to_string())?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let mut opts = DiffOptions::new();
        opts.pathspec(&rel);
        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&this_tree), Some(&mut opts))
            .map_err(|e| e.to_string())?;
        Ok(diff_hunks(&diff))
    })
}

#[tauri::command]
pub fn git_commit_message(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    sha: String,
) -> Result<serde_json::Value, super::CommandError> {
    let text =
        with_root(&state, &workspace_id, session_id.as_deref(), String::new(), |_root, repo| {
            repo.revparse_single(&sha)
                .and_then(|o| o.peel_to_commit())
                .map(|commit| commit.message().unwrap_or("").trim().to_owned())
                .map_err(|e| e.to_string())
        })?;
    Ok(serde_json::json!({ "text": text }))
}

#[tauri::command]
pub fn git_bulk(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    op: String,
    opts: Option<GitBulkOptsWire>,
) -> Result<GitOpResultWire, super::CommandError> {
    let Some(root) = resolve_git_cwd(&state, &workspace_id, session_id.as_deref())? else {
        return Ok(GitOpResultWire::err("no workspace"));
    };
    let result = open_repo(&root).and_then(|mut repo| match op.as_str() {
        "stage-all" => stage_all(&repo),
        "unstage-all" => unstage_all(&repo),
        "restore-all" => restore_all(&repo),
        "stash" => stash_save(&mut repo, opts.as_ref().and_then(|o| o.message.as_deref())),
        "stash-pop" => stash_pop(&mut repo),
        other => Err(format!("unknown op: {other}")),
    });
    match result {
        Ok(()) => Ok(GitOpResultWire::ok()),
        Err(error) => Ok(GitOpResultWire::err(error)),
    }
}

#[tauri::command]
pub fn git_stash_list(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<Vec<GitStashWire>, super::CommandError> {
    // stash_foreach needs &mut Repository — resolve/open directly.
    let list = resolve_git_cwd(&state, &workspace_id, session_id.as_deref())?
        .and_then(|root| Repository::open(root).ok())
        .map(|mut repo| stash_list(&mut repo))
        .unwrap_or_default();
    Ok(list)
}

#[tauri::command]
pub fn git_stage(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    file_path: String,
    stage: bool,
) -> Result<GitOpResultWire, super::CommandError> {
    // The TS gitStage's no-workspace result is a bare {ok: false}.
    let Some(root) = resolve_git_cwd(&state, &workspace_id, session_id.as_deref())? else {
        return Ok(GitOpResultWire { ok: false, error: None });
    };
    let result = open_repo(&root)
        .and_then(|repo| contained_rel_path(&root, &file_path).and_then(|rel| stage_or_unstage_file(&repo, &rel, stage)));
    match result {
        Ok(()) => Ok(GitOpResultWire::ok()),
        Err(error) => Ok(GitOpResultWire::err(error)),
    }
}

#[tauri::command]
pub fn git_restore_file(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    file_path: String,
    sha: String,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |root, repo| {
            restore_file(repo, root, &file_path, &sha).map(|()| GitOpResultWire::ok())
        },
    )
}

#[tauri::command]
pub fn git_discard_file(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    file_path: String,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |root, repo| discard_file(repo, root, &file_path).map(|()| GitOpResultWire::ok()),
    )
}

#[tauri::command]
pub fn git_commit(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    message: String,
) -> Result<GitCommitResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitCommitResultWire {
            ok: false,
            sha: None,
            error: Some("no workspace".into()),
        },
        |_root, repo| commit_staged(repo, &message).map(|sha| GitCommitResultWire {
            ok: true,
            sha: Some(sha),
            error: None,
        }),
    )
}

#[tauri::command]
pub fn git_amend(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    message: Option<String>,
) -> Result<GitCommitResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitCommitResultWire {
            ok: false,
            sha: None,
            error: Some("no workspace".into()),
        },
        |_root, repo| amend_head(repo, message.as_deref()).map(|sha| GitCommitResultWire {
            ok: true,
            sha: Some(sha),
            error: None,
        }),
    )
}

#[tauri::command]
pub fn git_revert(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    sha: String,
) -> Result<GitRevertResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitRevertResultWire {
            ok: false,
            new_sha: None,
            error: Some("no workspace".into()),
        },
        |_root, repo| revert_commit(repo, &sha).map(|sha| GitRevertResultWire {
            ok: true,
            new_sha: Some(sha),
            error: None,
        }),
    )
}

#[tauri::command]
pub fn git_ahead_behind(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<Option<GitAheadBehindResultWire>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), None, |_root, repo| {
        Ok(ahead_behind(repo))
    })
}

#[tauri::command]
pub fn git_head_sha(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<serde_json::Value, super::CommandError> {
    let sha = with_root(&state, &workspace_id, session_id.as_deref(), None, |_root, repo| {
        Ok(repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|commit| commit.id().to_string()))
    })?;
    Ok(serde_json::json!({ "sha": sha }))
}

#[tauri::command]
pub fn git_branch_info(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<GitBranchInfoResultWire, super::CommandError> {
    with_root(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitBranchInfoResultWire { branch: None, head_commit: None },
        |_root, repo| Ok(branch_info(repo)),
    )
}

#[tauri::command]
pub fn git_branches_detailed(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<Vec<GitBranchDetailedWire>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), Vec::new(), |_root, repo| {
        Ok(branches_detailed(repo))
    })
}

#[tauri::command]
pub fn git_create_branch(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    branch_name: String,
    sha: Option<String>,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |_root, repo| {
            create_branch(repo, &branch_name, sha.as_deref()).map(|()| GitOpResultWire::ok())
        },
    )
}

#[tauri::command]
pub fn git_delete_branch(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    name: String,
    force: bool,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |_root, repo| delete_branch(repo, &name, force).map(|()| GitOpResultWire::ok()),
    )
}

#[tauri::command]
pub fn git_checkout(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    branch: String,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |_root, repo| checkout_branch(repo, &branch).map(|()| GitOpResultWire::ok()),
    )
}

#[tauri::command]
pub fn git_recent_branches(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<Vec<String>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), Vec::new(), |_root, repo| {
        Ok(recent_branches(repo))
    })
}

#[tauri::command]
pub fn git_merge_branch(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    name: String,
) -> Result<GitMergeResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitMergeResultWire {
            ok: false,
            conflicts: None,
            error: Some("no workspace".into()),
        },
        |_root, repo| merge_branch(repo, &name),
    )
}

#[tauri::command]
pub fn git_conflict_files(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<Vec<GitConflictEntryWire>, super::CommandError> {
    with_root(&state, &workspace_id, session_id.as_deref(), Vec::new(), |_root, repo| {
        Ok(conflict_entries(repo))
    })
}

#[tauri::command]
pub fn git_resolve_file(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
    file_path: String,
    side: String,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |root, repo| resolve_file(repo, root, &file_path, &side),
    )
}

#[tauri::command]
pub fn git_fetch(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |_root, repo| fetch_remote(repo).map(|()| GitOpResultWire::ok()),
    )
}

#[tauri::command]
pub fn git_pull(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |_root, repo| pull(repo).map(|()| GitOpResultWire::ok()),
    )
}

#[tauri::command]
pub fn git_push(
    state: tauri::State<AppState>,
    workspace_id: String,
    session_id: Option<String>,
) -> Result<GitOpResultWire, super::CommandError> {
    with_root_op(
        &state,
        &workspace_id,
        session_id.as_deref(),
        GitOpResultWire::err("no workspace"),
        |_root, repo| push(repo).map(|()| GitOpResultWire::ok()),
    )
}

#[tauri::command]
pub fn git_repo_detect(dir_path: String) -> Result<Option<GitRepoInfoWire>, super::CommandError> {
    let dir = PathBuf::from(worktree::expand_home(&dir_path));
    Ok(super::workspaces::detect_git(&dir).map(|info| GitRepoInfoWire {
        branch: info.branch,
        head_commit: info.head_commit,
        file_count: info.file_count,
        is_repo: true,
    }))
}

// ── tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-git-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_over_repo(name: &str, repo_dir: &Path) -> AppState {
        let dir = temp_dir(&format!("{name}-cfg"));
        fs::write(
            dir.join("config.json"),
            format!(
                r#"{{"workspaces":[{{"id": "ws_1", "name": "a", "path": {:?}}}]}}"#,
                repo_dir.to_string_lossy()
            ),
        )
        .unwrap();
        AppState::load(dir)
    }

    /// A repo on `main` with one commit; user identity configured.
    fn seeded_repo(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        let mut init_opts = git2::RepositoryInitOptions::new();
        init_opts.initial_head("main");
        let repo = Repository::init_opts(&dir, &init_opts).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Tide Test").unwrap();
            config.set_str("user.email", "tide@test.local").unwrap();
        }
        commit_files_to(&repo, &[("a.txt", "line1\nline2\nline3\n")], "init");
        dir
    }

    fn commit_tree_of<'r>(
        repo: &'r Repository,
        files: &[(&str, &str)],
        remove: &[&str],
    ) -> git2::Tree<'r> {
        let workdir = repo.workdir().unwrap().to_path_buf();
        for (path, content) in files {
            let abs = workdir.join(path);
            if let Some(parent) = abs.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(abs, content).unwrap();
        }
        // Removals leave the workdir too (a committed delete deletes).
        for path in remove {
            let abs = workdir.join(path);
            if abs.is_dir() {
                let _ = fs::remove_dir_all(abs);
            } else {
                let _ = fs::remove_file(abs);
            }
        }
        let mut index = repo.index().unwrap();
        for (path, _) in files {
            index.add_path(Path::new(path)).unwrap();
        }
        for path in remove {
            index.remove_path(Path::new(path)).unwrap();
        }
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        repo.find_tree(tree_id).unwrap()
    }

    /// Write the files (and remove the removals), then commit on HEAD.
    fn commit_files_to(repo: &Repository, files: &[(&str, &str)], message: &str) -> Oid {
        commit_change_to(repo, files, &[], message)
    }

    fn commit_change_to(
        repo: &Repository,
        files: &[(&str, &str)],
        remove: &[&str],
        message: &str,
    ) -> Oid {
        let tree = commit_tree_of(repo, files, remove);
        let sig = repo.signature().unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .unwrap()
    }

    fn status_word_of(repo: &Repository, path: &str) -> GitFileChangeWire {
        status_entries(repo)
            .unwrap()
            .into_iter()
            .find(|e| e.path == path)
            .unwrap_or_else(|| panic!("{path} not in status"))
    }

    #[test]
    fn status_maps_staged_unstaged_untracked_and_counts() {
        let root = seeded_repo("status");
        let repo = Repository::open(&root).unwrap();
        fs::write(root.join("a.txt"), "line1\nCHANGED\nline3\n").unwrap();
        fs::write(root.join("new.txt"), "n\n").unwrap();
        fs::write(root.join(".DS_Store"), "junk").unwrap();
        fs::write(root.join("staged.txt"), "x\ny\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("staged.txt")).unwrap();
            index.write().unwrap();
        }
        let entries = status_entries(&repo).unwrap();
        let a = status_word_of(&repo, "a.txt");
        assert_eq!((a.status, a.staged), ("modified", false));
        assert_eq!((a.additions, a.deletions), (1, 1));
        let staged = status_word_of(&repo, "staged.txt");
        assert_eq!((staged.status, staged.staged), ("added", true));
        assert_eq!((staged.additions, staged.deletions), (2, 0));
        let new = status_word_of(&repo, "new.txt");
        assert_eq!((new.status, new.staged, new.additions), ("untracked", false, 0));
        assert!(entries.iter().all(|e| e.path != ".DS_Store"));
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn status_renamed_and_staged_deletion_and_unborn() {
        let root = seeded_repo("status-renamed");
        let repo = Repository::open(&root).unwrap();
        fs::rename(root.join("a.txt"), root.join("b.txt")).unwrap();
        {
            let mut index = repo.index().unwrap();
            index.remove_path(Path::new("a.txt")).unwrap();
            index.add_path(Path::new("b.txt")).unwrap();
            index.write().unwrap();
        }
        let renamed = status_word_of(&repo, "b.txt");
        assert_eq!((renamed.status, renamed.staged), ("renamed", true));

        commit_change_to(&repo, &[("c.txt", "c\n")], &[], "add c");
        fs::remove_file(root.join("c.txt")).unwrap();
        {
            let mut index = repo.index().unwrap();
            index.remove_path(Path::new("c.txt")).unwrap();
            index.write().unwrap();
        }
        let deleted = status_word_of(&repo, "c.txt");
        assert_eq!((deleted.status, deleted.staged), ("deleted", true));
        drop(repo);

        // Unborn HEAD: everything untracked at 0/0 (the TS numstat call
        // failed → no counts).
        let empty = temp_dir("status-unborn");
        let repo = Repository::init(&empty).unwrap();
        fs::write(empty.join("x.txt"), "x\n").unwrap();
        let entries = status_entries(&repo).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!((entries[0].status, entries[0].additions), ("untracked", 0));
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&empty).unwrap();
    }

    #[test]
    fn diff_hunks_match_the_parser_shape() {
        let root = seeded_repo("diff");
        let repo = Repository::open(&root).unwrap();
        fs::write(root.join("a.txt"), "line1\nINSERTED\nline2\nline3\n").unwrap();
        let rel = contained_rel_path(&root, "a.txt").unwrap();
        let hunks = diff_hunks(&single_file_diff(&repo, &rel, false, None).unwrap());
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].header.starts_with("@@ -1,3 +1,4 @@"), "{}", hunks[0].header);
        let texts: Vec<&str> = hunks[0].lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(
            texts,
            vec![" line1", "+INSERTED", " line2", " line3"],
            "text carries the +/-/space prefix like the unified lines"
        );
        let add = &hunks[0].lines[1];
        assert_eq!((add.kind, add.old_no, add.new_no), ("add", None, Some(2)));
        let ctx = &hunks[0].lines[0];
        assert_eq!((ctx.kind, ctx.old_no, ctx.new_no), ("context", Some(1), Some(1)));

        // Context clamping: the full-file sentinel keeps every line visible.
        let hunks = diff_hunks(&single_file_diff(&repo, &rel, false, Some(100_000)).unwrap());
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 4);

        // Staged diff of the same change after staging it.
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new(&rel)).unwrap();
            index.write().unwrap();
        }
        let hunks = diff_hunks(&single_file_diff(&repo, &rel, true, None).unwrap());
        assert_eq!(hunks[0].lines.iter().filter(|l| l.kind == "add").count(), 1);

        // Wire shape: "type" spelled out, absent side numbers omitted.
        let wire = serde_json::to_value(&hunks[0].lines[1]).unwrap();
        assert_eq!(wire["type"], serde_json::json!("add"));
        assert!(wire.get("oldNo").is_none());
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn staged_diff_is_raw_unified_text() {
        let root = seeded_repo("staged-diff");
        let repo = Repository::open(&root).unwrap();
        fs::write(root.join("a.txt"), "line1\nline2 X\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
        }
        {
            let head_tree = repo.head().unwrap().peel_to_tree().ok();
            let index = repo.index().unwrap();
            let diff = repo
                .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
                .unwrap();
            let text = diff_patch_text(&diff);
            assert!(text.starts_with("diff --git a/a.txt b/a.txt"), "{text}");
        assert!(text.contains("--- a/a.txt"));
        assert!(text.contains("+++ b/a.txt"));
        assert!(text.contains("@@ -1,3 +1,2 @@"), "{text}");
        assert!(text.contains("+line2 X"));
        }
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn log_decorates_head_branches_and_tags() {
        let root = seeded_repo("log");
        let repo = Repository::open(&root).unwrap();
        let first = repo.head().unwrap().peel_to_commit().unwrap().id();
        commit_files_to(&repo, &[("a.txt", "line1\nline2\nline3\nmore\n")], "second commit");
        {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("feature", &head, false).unwrap();
            repo.tag_lightweight("v1", head.as_object(), false).unwrap();
        }
        repo.tag_lightweight("first-tag", repo.find_commit(first).unwrap().as_object(), false)
            .unwrap();

        let entries = log_entries(&repo, None);
        assert_eq!(entries.len(), 2);
        let tip = &entries[0];
        assert_eq!(tip.subject, "second commit");
        assert_eq!(tip.author, "Tide Test");
        assert!(tip.date.starts_with("20"), "ISO date: {}", tip.date);
        assert_eq!(tip.is_head, Some(true));
        let branch_heads = tip.branch_heads.clone().unwrap_or_default();
        assert!(branch_heads.contains(&"feature".to_owned()), "{branch_heads:?}");
        assert!(branch_heads.contains(&"main".to_owned()), "{branch_heads:?}");
        assert_eq!(tip.tags.as_deref(), Some(&["v1".to_owned()][..]));
        assert_eq!(tip.parents, vec![short_sha(first)]);
        let base = &entries[1];
        assert_eq!(base.is_head, Some(false));
        assert_eq!(base.tags.as_deref(), Some(&["first-tag".to_owned()][..]));
        assert!(base.parents.is_empty());

        assert_eq!(log_entries(&repo, Some(1)).len(), 1);

        // Unborn HEAD → empty history.
        let empty = temp_dir("log-unborn");
        let empty_repo = Repository::init(&empty).unwrap();
        assert!(log_entries(&empty_repo, None).is_empty());
        drop(empty_repo);
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&empty).unwrap();
    }

    #[test]
    fn commit_files_and_file_diff_at_a_commit() {
        let root = seeded_repo("commit-files");
        let repo = Repository::open(&root).unwrap();
        let first = repo.head().unwrap().peel_to_commit().unwrap().id();
        // Root commit: every file shows as added vs the empty tree.
        let files = commit_files(&repo, "HEAD").unwrap();
        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.status, a.staged, a.additions), ("added", true, 3));

        commit_files_to(&repo, &[("a.txt", "line1\nline2\n")], "shrink");
        let files = commit_files(&repo, "HEAD").unwrap();
        let a = files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.status, a.deletions), ("modified", 1));

        // Single-file patch at the first commit.
        let hunks = diff_hunks(&commit_tree_diff(&repo, &short_sha(first)).unwrap());
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].lines.iter().any(|l| l.text == "+line1"));

        // gitCommitMessage returns the trimmed full message.
        let message = repo
            .revparse_single("HEAD")
            .and_then(|o| o.peel_to_commit())
            .map(|commit| commit.message().unwrap_or("").trim().to_owned())
            .unwrap();
        assert_eq!(message, "shrink");
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stage_unstage_and_discard_single_file() {
        let root = seeded_repo("stage-file");
        let repo = Repository::open(&root).unwrap();
        fs::write(root.join("a.txt"), "modified\n").unwrap();
        fs::write(root.join("u.txt"), "untracked\n").unwrap();

        stage_or_unstage_file(&repo, "a.txt", true).unwrap();
        assert!(status_word_of(&repo, "a.txt").staged);

        stage_or_unstage_file(&repo, "a.txt", false).unwrap();
        assert!(!status_word_of(&repo, "a.txt").staged);

        // Discard a tracked modified file → restored to the index/HEAD state.
        fs::write(root.join("a.txt"), "line1\nline2\nline3\nJUNK\n").unwrap();
        discard_file(&repo, &root, "a.txt").unwrap();
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "line1\nline2\nline3\n");

        // Staging a deleted file records the deletion (`git add` semantics).
        fs::remove_file(root.join("a.txt")).unwrap();
        stage_or_unstage_file(&repo, "a.txt", true).unwrap();
        let a = status_word_of(&repo, "a.txt");
        assert_eq!((a.status, a.staged), ("deleted", true));

        // Discard an untracked file → removed from disk.
        discard_file(&repo, &root, "u.txt").unwrap();
        assert!(!root.join("u.txt").exists());
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bulk_ops_stage_unstage_restore_stash() {
        let root = seeded_repo("bulk");
        let mut repo = Repository::open(&root).unwrap();
        fs::write(root.join("a.txt"), "changed\n").unwrap();
        fs::write(root.join("u.txt"), "untracked\n").unwrap();
        fs::create_dir_all(root.join("untracked-dir")).unwrap();
        fs::write(root.join("untracked-dir/nested.txt"), "x\n").unwrap();

        stage_all(&repo).unwrap();
        let statuses = status_entries(&repo).unwrap();
        assert!(statuses.iter().all(|e| e.staged), "{statuses:?}");
        assert!(statuses.iter().any(|e| e.path == "untracked-dir/nested.txt"));

        unstage_all(&repo).unwrap();
        assert!(status_entries(&repo).unwrap().iter().all(|e| !e.staged));

        stash_save(&mut repo, Some("my message")).unwrap();
        let list = stash_list(&mut repo);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].ref_name, "stash@{0}");
        assert!(list[0].message.contains("my message"), "{}", list[0].message);
        assert!(status_entries(&repo).unwrap().is_empty(), "tree clean after stash");

        stash_pop(&mut repo).unwrap();
        assert!(stash_list(&mut repo).is_empty());
        assert!(root.join("u.txt").exists());
        assert!(root.join("untracked-dir/nested.txt").exists());

        restore_all(&repo).unwrap();
        assert!(status_entries(&repo).unwrap().is_empty());
        assert!(!root.join("u.txt").exists());
        assert!(!root.join("untracked-dir").exists());
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "line1\nline2\nline3\n");

        // Stash with nothing to save → ok (CLI exit 0), no entry.
        stash_save(&mut repo, None).unwrap();
        assert!(stash_list(&mut repo).is_empty());
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn commit_amend_and_nothing_staged() {
        let root = seeded_repo("commit");
        let repo = Repository::open(&root).unwrap();

        let err = commit_staged(&repo, "empty").unwrap_err();
        assert!(err.contains("nothing to commit"), "{err}");

        fs::write(root.join("b.txt"), "b\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("b.txt")).unwrap();
            index.write().unwrap();
        }
        let sha = commit_staged(&repo, "add b\n\nbody line").unwrap();
        assert_eq!(sha.len(), 7);
        {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            assert_eq!(head.message().unwrap(), "add b\n\nbody line");
            // Amend with no message keeps the original; the author is
            // preserved.
            let original_author = head.author().name().unwrap().to_owned();
            fs::write(root.join("b.txt"), "b2\n").unwrap();
            {
                let mut index = repo.index().unwrap();
                index.add_path(Path::new("b.txt")).unwrap();
                index.write().unwrap();
            }
            amend_head(&repo, None).unwrap();
            let amended = repo.head().unwrap().peel_to_commit().unwrap();
            assert_eq!(amended.message().unwrap(), "add b\n\nbody line");
            assert_eq!(amended.author().name().unwrap(), original_author);
            assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "b2\n");
        }

        amend_head(&repo, Some("  ")).unwrap(); // whitespace-only → keep original
        amend_head(&repo, Some("replaced")).unwrap();
        assert!(repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .message()
            .unwrap()
            .contains("replaced"));
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restore_file_round_trips_and_deletes_new_files() {
        let root = seeded_repo("restore-file");
        let repo = Repository::open(&root).unwrap();
        let first = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();

        fs::write(root.join("a.txt"), "clobbered\n").unwrap();
        restore_file(&repo, &root, "a.txt", &first).unwrap();
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "line1\nline2\nline3\n");
        // The restored content is staged (checkout <sha> -- path does both).
        assert!(status_entries(&repo).unwrap().is_empty());

        // A file created after the sha → deleted, no index ghost.
        fs::write(root.join("created.txt"), "temp\n").unwrap();
        restore_file(&repo, &root, "created.txt", &first).unwrap();
        assert!(!root.join("created.txt").exists());
        assert!(status_entries(&repo).unwrap().is_empty());
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn branch_lifecycle_and_recent() {
        let root = seeded_repo("branches");
        let repo = Repository::open(&root).unwrap();

        create_branch(&repo, "feature/x", None).unwrap();
        assert_eq!(head_branch_name(&repo).as_deref(), Some("feature/x"));
        commit_files_to(&repo, &[("f.txt", "f\n")], "on feature");

        // Reflog trail: feature/x → main → topic → feature/x.
        checkout_branch(&repo, "main").unwrap();
        create_branch(&repo, "topic", None).unwrap();
        checkout_branch(&repo, "feature/x").unwrap();
        let recent = recent_branches(&repo);
        assert_eq!(recent.first().map(String::as_str), Some("topic"), "{recent:?}");
        assert!(recent.contains(&"main".to_owned()));
        assert!(!recent.contains(&"feature/x".to_owned()), "current excluded");

        // -d on an unmerged branch fails; -D works (from a different HEAD).
        checkout_branch(&repo, "main").unwrap();
        let err = delete_branch(&repo, "feature/x", false).unwrap_err();
        assert!(err.contains("not fully merged"), "{err}");
        assert!(delete_branch(&repo, "feature/x", true).is_ok());

        // Dirty-tree refusal: a local change to a file the target rewrote.
        create_branch(&repo, "diverged", None).unwrap();
        commit_files_to(&repo, &[("a.txt", "diverged\n")], "diverge a.txt");
        checkout_branch(&repo, "main").unwrap();
        fs::write(root.join("a.txt"), "dirty\n").unwrap();
        assert!(
            checkout_branch(&repo, "diverged").is_err(),
            "local change would be overwritten — SAFE checkout refuses"
        );
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn recent_branches_falls_back_without_reflog() {
        let root = seeded_repo("recent-fallback");
        let repo = Repository::open(&root).unwrap();
        // A repo with no reflog file at all (fresh init + direct refs).
        {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("older", &head, false).unwrap();
        }
        commit_files_to(&repo, &[("a.txt", "line1\nline2\nline3\nnewer\n")], "newer");
        {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("newer", &head, false).unwrap();
        }
        let _ = fs::remove_file(root.join(".git/logs/HEAD"));
        let repo = Repository::open(&root).unwrap();
        let recent = recent_branches(&repo);
        assert_eq!(recent, vec!["newer".to_owned(), "older".to_owned()]);
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn branches_detailed_lists_local_and_remote_with_counts() {
        let root = seeded_repo("detailed");
        let repo = Repository::open(&root).unwrap();
        commit_files_to(&repo, &[("a.txt", "line1\nline2\nline3\nmore\n")], "ahead commit");
        let head_id = repo.head().unwrap().peel_to_commit().unwrap().id();
        let base = repo.head().unwrap().peel_to_commit().unwrap().parent(0).unwrap().id();
        repo.reference("refs/remotes/origin/main", base, false, "fetch").unwrap();
        repo.reference("refs/remotes/origin/feature", head_id, false, "fetch").unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            false,
            "origin",
        )
        .unwrap();
        // branch.upstream() resolves through the configured remote — it must
        // exist even though nothing is fetched here.
        repo.remote("origin", "/tmp/nowhere.git").unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("branch.main.remote", "origin").unwrap();
            config.set_str("branch.main.merge", "refs/heads/main").unwrap();
        }

        let branches = branches_detailed(&repo);
        let main = branches.iter().find(|b| b.name == "main").unwrap();
        assert_eq!((main.is_remote, main.upstream.as_deref()), (false, Some("origin/main")));
        assert_eq!((main.ahead, main.behind), (Some(1), Some(0)));
        assert!(main.subject.contains("ahead commit"));
        let feature = branches.iter().find(|b| b.name == "origin/feature").unwrap();
        assert!(feature.is_remote);
        assert!(feature.upstream.is_none());
        assert!(branches.iter().any(|b| b.name == "origin/main"));
        assert!(branches.iter().all(|b| b.name != "origin/HEAD"), "symref excluded");
        // Locals first, remotes after — the TS concat order.
        let first_remote = branches.iter().position(|b| b.is_remote).unwrap();
        assert!(branches[..first_remote].iter().all(|b| !b.is_remote));
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ahead_behind_head_sha_and_branch_info() {
        let root = seeded_repo("ahead");
        let repo = Repository::open(&root).unwrap();
        assert_eq!(ahead_behind(&repo), None, "no upstream configured");

        let tip = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.reference("refs/remotes/origin/main", tip, false, "fetch").unwrap();
        repo.remote("origin", "/tmp/nowhere.git").unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("branch.main.remote", "origin").unwrap();
            config.set_str("branch.main.merge", "refs/heads/main").unwrap();
        }
        assert_eq!(ahead_behind(&repo), Some(GitAheadBehindResultWire { ahead: 0, behind: 0 }));

        commit_files_to(&repo, &[("a.txt", "line1\nline2\nline3\nnew\n")], "ahead");
        assert_eq!(ahead_behind(&repo).unwrap().ahead, 1);

        // gitHeadSha answers the full 40-char sha.
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id().to_string().len(), 40);

        let info = branch_info(&repo);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.head_commit.unwrap().len(), 7);

        // Detached: branch reads "HEAD".
        let head_id = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(head_id).unwrap();
        assert_eq!(branch_info(&repo).branch.as_deref(), Some("HEAD"));

        // Unborn: null/null.
        let empty = temp_dir("ahead-unborn");
        let empty_repo = Repository::init(&empty).unwrap();
        assert_eq!(
            branch_info(&empty_repo),
            GitBranchInfoResultWire { branch: None, head_commit: None }
        );
        drop(empty_repo);
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&empty).unwrap();
    }

    #[test]
    fn merge_fast_forward_true_merge_and_conflicts() {
        let root = seeded_repo("merge");
        let repo = Repository::open(&root).unwrap();
        // main stays at the first commit; feature advances → FF from main.
        create_branch(&repo, "feature", None).unwrap();
        commit_files_to(&repo, &[("f.txt", "feature\n")], "feature work");

        checkout_branch(&repo, "main").unwrap();
        let result = merge_branch(&repo, "feature").unwrap();
        assert!(result.ok);
        assert!(repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .summary()
            .ok()
            .flatten()
            .unwrap()
            .contains("feature work"));

        // True merge: both sides advance disjointly.
        commit_files_to(&repo, &[("m.txt", "main side\n")], "main work");
        checkout_branch(&repo, "feature").unwrap();
        commit_files_to(&repo, &[("f.txt", "feature\nmore\n")], "more feature");
        checkout_branch(&repo, "main").unwrap();
        let result = merge_branch(&repo, "feature").unwrap();
        assert!(result.ok);
        let merged = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(merged.parent_count(), 2);
        assert!(merged.message().unwrap().starts_with("Merge branch 'feature'"));
        assert!(root.join("m.txt").exists() && root.join("f.txt").exists());
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        drop(merged);

        // Conflict: same file changed on both sides → conflicts listed and
        // the repo left mid-merge for the resolve flow.
        create_branch(&repo, "conflicter", None).unwrap();
        commit_files_to(&repo, &[("m.txt", "feature conflict\n")], "conflicting edit");
        checkout_branch(&repo, "main").unwrap();
        commit_files_to(&repo, &[("m.txt", "main conflict\n")], "main conflicting edit");
        let result = merge_branch(&repo, "conflicter").unwrap();
        assert!(!result.ok);
        assert_eq!(
            result.conflicts.unwrap(),
            vec![GitConflictEntryWire { path: "m.txt".into(), state: "both-modified" }]
        );
        assert_eq!(repo.state(), git2::RepositoryState::Merge);
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn conflict_listing_and_resolve_cover_the_delete_states() {
        let root = seeded_repo("resolve");
        let repo = Repository::open(&root).unwrap();
        // Base: three files; ours modifies f, deletes d1, modifies d2;
        // theirs modifies f, modifies d1, deletes d2.
        commit_files_to(
            &repo,
            &[("f.txt", "base\n"), ("d1.txt", "d1\n"), ("d2.txt", "d2\n")],
            "base files",
        );
        create_branch(&repo, "theirs", None).unwrap();
        commit_change_to(
            &repo,
            &[("f.txt", "theirs\n"), ("d1.txt", "d1 theirs\n")],
            &["d2.txt"],
            "theirs edits",
        );
        checkout_branch(&repo, "main").unwrap();
        commit_change_to(
            &repo,
            &[("f.txt", "ours\n"), ("d2.txt", "d2 ours\n")],
            &["d1.txt"],
            "ours edits",
        );

        let result = merge_branch(&repo, "theirs").unwrap();
        assert!(!result.ok);
        let mut conflicts = result.conflicts.unwrap();
        conflicts.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            conflicts,
            vec![
                GitConflictEntryWire { path: "d1.txt".into(), state: "deleted-by-us" },
                GitConflictEntryWire { path: "d2.txt".into(), state: "deleted-by-them" },
                GitConflictEntryWire { path: "f.txt".into(), state: "both-modified" },
            ]
        );

        // resolve theirs on both-modified → their blob in workdir + index.
        assert_eq!(
            resolve_file(&repo, &root, "f.txt", "theirs").unwrap(),
            GitOpResultWire::ok()
        );
        assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), "theirs\n");

        // resolve theirs where THEY deleted → deletion recorded, file gone.
        assert_eq!(
            resolve_file(&repo, &root, "d2.txt", "theirs").unwrap(),
            GitOpResultWire::ok()
        );
        assert!(!root.join("d2.txt").exists());
        assert!(repo.index().unwrap().get_path(Path::new("d2.txt"), 0).is_none());

        // resolve theirs where WE deleted but they modified → restored.
        assert_eq!(
            resolve_file(&repo, &root, "d1.txt", "theirs").unwrap(),
            GitOpResultWire::ok()
        );
        assert_eq!(fs::read_to_string(root.join("d1.txt")).unwrap(), "d1 theirs\n");
        assert!(conflict_entries(&repo).is_empty(), "all three resolved");

        // A path that is not unmerged → {ok: false}.
        let result = resolve_file(&repo, &root, "f.txt", "ours").unwrap();
        assert!(!result.ok);

        // Path escape is refused (the TS threw out of resolveInsideWorkspace;
        // here the same refusal folds into the op error channel).
        assert!(resolve_file(&repo, &root, "../outside.txt", "ours").is_err());
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn revert_creates_the_inverse_commit() {
        let root = seeded_repo("revert");
        let repo = Repository::open(&root).unwrap();
        commit_files_to(&repo, &[("a.txt", "line1\nline2\nline3\nadded\n")], "to revert");
        let target = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();

        let sha = revert_commit(&repo, &target).unwrap();
        assert_eq!(sha.len(), 7);
        {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            assert!(head.message().unwrap().starts_with("Revert \"to revert\""));
            assert!(head.message().unwrap().contains("This reverts commit"));
        }
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "line1\nline2\nline3\n");
        assert_eq!(repo.state(), git2::RepositoryState::Clean);

        let err = revert_commit(&repo, "nosuchrev").unwrap_err();
        assert!(err.contains("unknown revision"));
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn network_ops_against_a_local_remote() {
        // A bare "origin" the workspace pushes to / fetches / pulls from.
        let origin_dir = temp_dir("net-origin");
        let bare = Repository::init_bare(&origin_dir).unwrap();
        drop(bare);

        let root = seeded_repo("net");
        let repo = Repository::open(&root).unwrap();
        repo.remote("origin", &origin_dir.to_string_lossy()).unwrap();
        // An empty remote has no refs — push -u seeds it.
        push(&repo).unwrap();
        let origin = Repository::open_bare(&origin_dir).unwrap();
        let remote_tip = origin
            .find_reference("refs/heads/main")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();
        assert_eq!(remote_tip, repo.head().unwrap().peel_to_commit().unwrap().id());
        drop(origin);
        // push -u recorded the upstream.
        assert_eq!(
            repo.find_branch("main", BranchType::Local)
                .unwrap()
                .upstream()
                .unwrap()
                .name()
                .ok()
                .flatten(),
            Some("origin/main")
        );

        commit_files_to(&repo, &[("a.txt", "line1\nline2\nline3\nlocal\n")], "local work");
        assert_eq!(ahead_behind(&repo).unwrap().ahead, 1);

        // fetch: the remote-tracking ref appears.
        fetch_remote(&repo).unwrap();
        assert!(repo.find_reference("refs/remotes/origin/main").is_ok());

        // pull --ff-only: move local main back one, pull fast-forwards.
        let first = repo.head().unwrap().peel_to_commit().unwrap().parent(0).unwrap().id();
        repo.reference("refs/heads/main", first, true, "back").unwrap();
        {
            let tree = repo.find_commit(first).unwrap().tree().unwrap();
            let mut opts = CheckoutBuilder::new();
            opts.force();
            repo.checkout_tree(tree.as_object(), Some(&mut opts)).unwrap();
        }
        pull(&repo).unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), remote_tip);

        // No-remote fetch surfaces the error string.
        let orphan = seeded_repo("net-orphan");
        let orphan_repo = Repository::open(&orphan).unwrap();
        let err = fetch_remote(&orphan_repo).unwrap_err();
        assert!(err.contains("origin"), "{err}");
        drop(orphan_repo);
        drop(repo);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&origin_dir).unwrap();
        fs::remove_dir_all(&orphan).unwrap();
    }

    #[test]
    fn session_scope_prefers_the_worktree_path() {
        // A workspace repo + a linked worktree; a session row whose
        // session_worktree side-table entry points at the worktree — the
        // worktree-first branch of resolveGitCwd.
        let root = seeded_repo("scope-wt");
        let repo = Repository::open(&root).unwrap();
        let wt_path = root.join(".agent/worktrees").join("wt-a");
        fs::create_dir_all(root.join(".agent/worktrees")).unwrap();
        {
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("wt-a", &head, false).unwrap();
            let reference = repo.find_reference("refs/heads/wt-a").unwrap();
            let mut opts = git2::WorktreeAddOptions::new();
            opts.reference(Some(&reference));
            repo.worktree("wt-a", &wt_path, Some(&opts)).unwrap();
        }
        drop(repo);

        // Dirty only inside the worktree.
        fs::write(wt_path.join("only-in-worktree.txt"), "x\n").unwrap();

        let state_dir = temp_dir("scope-wt-cfg");
        fs::write(
            state_dir.join("config.json"),
            format!(
                r#"{{"workspaces":[{{"id": "ws_1", "name": "a", "path": {:?}}}]}}"#,
                root.to_string_lossy()
            ),
        )
        .unwrap();
        // AppState::load points sessions_db_path at <data>/sessions-v2.db.
        let sessions_db = state_dir.join("sessions-v2.db");
        {
            let hub = tide_store::sessions_v2_write::SessionsV2Writer::open(&sessions_db).unwrap();
            hub.create_session(
                tide_store::sessions_v2_write::CreateSessionInput {
                    id: "s_wt",
                    workspace_path: &root.to_string_lossy(),
                    title: "WT",
                    model_id: "m",
                    provider_id: None,
                    parent_id: None,
                },
                10_000,
            )
            .unwrap();
            hub.set_session_worktree(
                "s_wt",
                Some(&serde_json::json!({
                    "branch": "wt-a",
                    "path": wt_path.to_string_lossy(),
                    "baseCommit": "abc1234",
                    "baseBranch": "main",
                    "ahead": 0,
                    "behind": 0,
                })),
                10_000,
            )
            .unwrap();
        }
        let state = AppState::load(state_dir);

        // With the session scope: the worktree's untracked file shows.
        let entries = with_root(&state, "ws_1", Some("s_wt"), Vec::new(), |_root, repo| {
            status_entries(repo)
        })
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!((entries[0].path.as_str(), entries[0].status), ("only-in-worktree.txt", "untracked"));

        // Without it: the main checkout (clean).
        let entries = with_root(&state, "ws_1", None, Vec::new(), |_root, repo| {
            status_entries(repo)
        })
        .unwrap();
        assert!(entries.is_empty());

        // A session with no worktree row falls back to the workspace path.
        let entries = with_root(&state, "ws_1", Some("s_none"), Vec::new(), |_root, repo| {
            status_entries(repo)
        })
        .unwrap();
        assert!(entries.is_empty());
        drop(state);
        let _ = std::fs::remove_file(&sessions_db);
        let _ = std::fs::remove_file(sessions_db.with_extension("db-wal"));
        let _ = std::fs::remove_file(sessions_db.with_extension("db-shm"));
        fs::remove_dir_all(&root).unwrap();
        let cfg_dir = sessions_db.parent().unwrap().to_path_buf();
        fs::remove_dir_all(&cfg_dir).unwrap();
    }

    #[test]
    fn scope_resolution_and_defaults() {
        let root = seeded_repo("scope");
        let state = state_over_repo("scope", &root);
        // Workspace path resolves.
        let entries = with_root(&state, "ws_1", None, Vec::new(), |_root, repo| {
            status_entries(repo)
        })
        .unwrap();
        assert!(entries.is_empty(), "clean tree");

        // Unknown workspace id → the command's default, no error.
        assert!(with_root(&state, "ws_ghost", None, Vec::new(), |_root, repo| {
            status_entries(repo)
        })
        .unwrap()
        .is_empty());

        // Non-repo workspace path → the default verbatim (open failed).
        let plain = temp_dir("scope-plain");
        let dir = temp_dir("scope-plain-cfg");
        fs::write(
            dir.join("config.json"),
            format!(
                r#"{{"workspaces":[{{"id": "ws_1", "name": "a", "path": {:?}}}]}}"#,
                plain.to_string_lossy()
            ),
        )
        .unwrap();
        let state2 = AppState::load(dir);
        let sentinel = vec![GitFileChangeWire {
            path: "sentinel".into(),
            status: "modified",
            staged: false,
            additions: 1,
            deletions: 0,
        }];
        let out = with_root(&state2, "ws_1", None, sentinel.clone(), |_root, repo| {
            status_entries(repo)
        })
        .unwrap();
        assert_eq!(out, sentinel, "non-repo falls back to the default");

        // No-workspace op result + git error folding.
        let result = with_root_op(
            &state2,
            "ws_missing",
            None,
            GitOpResultWire::err("__no_ws__"),
            |_root, _repo| Ok(GitOpResultWire::ok()),
        )
        .unwrap();
        assert_eq!(result.error.as_deref(), Some("__no_ws__"));
        let result = with_root_op(
            &state,
            "ws_1",
            None,
            GitOpResultWire::ok(),
            |_root, _repo| Err("boom".to_owned()),
        )
        .unwrap();
        assert_eq!(
            result,
            GitOpResultWire { ok: false, error: Some("boom".into()) }
        );

        // gitRepoDetect parity.
        let info = git_repo_detect(root.to_string_lossy().into_owned())
            .unwrap()
            .expect("repo detected");
        assert_eq!(info.branch, "main");
        assert_eq!(info.head_commit.len(), 7);
        assert_eq!((info.file_count, info.is_repo), (1, true));
        assert!(
            git_repo_detect(plain.to_string_lossy().into_owned())
                .unwrap()
                .is_none()
        );
        drop(state);
        drop(state2);
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&plain).unwrap();
    }

    #[test]
    fn path_containment_and_context_clamping() {
        assert!(contained_rel_path(Path::new("/ws/a"), "../escape").is_err());
        assert!(contained_rel_path(Path::new("/ws/a"), "src/x.rs").is_ok());
        assert_eq!(
            contained_rel_path(Path::new("/ws/a"), "src/../y.rs").unwrap(),
            "y.rs"
        );
        assert_eq!(clamp_context_lines(None), None);
        assert_eq!(clamp_context_lines(Some(0)), Some(1));
        assert_eq!(clamp_context_lines(Some(250)), Some(200));
        assert_eq!(clamp_context_lines(Some(100_000)), Some(100_000));
    }
}
