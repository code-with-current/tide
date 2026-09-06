//! Git panel service — port of tide's `src-tauri/src/commands/git.rs`
//! status/diff core on tide's daemon. Everything runs on libgit2
//! in-process; every function takes the repository `cwd` directly.
//!
//! Error style matches the upstream TS wrappers: list-shaped functions
//! swallow git errors and answer their empty default (`Vec::new()` /
//! empty string), op-shaped text results do the same — no `Result`
//! crosses this module's public surface.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::Path;
use std::process::Stdio;

use git2::{
    BranchType, Cred, CredentialType, Delta, Diff, DiffDelta, DiffFormat, DiffLine, DiffOptions,
    FetchOptions, IndexAddOption, MergeOptions, Oid, RemoteCallbacks, Repository, ResetType, Sort,
    StashFlags, Status, StatusOptions, build::CheckoutBuilder,
};
use protocol::git_panel::{
    PanelAheadBehind, PanelBranchInfo, PanelCommit, PanelCommitResult, PanelConflict,
    PanelDiffHunk, PanelDiffLine, PanelFileChange, PanelMergeResult, PanelOpResult,
    PanelRevertResult, PanelStash,
};

/// `gitStatus` — the working-tree change list with numstat counts.
pub fn status(cwd: &Path) -> Vec<PanelFileChange> {
    match Repository::open(cwd).and_then(|repo| status_entries(&repo)) {
        Ok(entries) => entries,
        Err(_) => Vec::new(),
    }
}

/// `gitDiff` — one file's hunks, staged (tree→index) or unstaged
/// (index→workdir), with context lines clamped like upstream.
pub fn file_diff(cwd: &Path, path: &str, staged: bool, context_lines: u32) -> Vec<PanelDiffHunk> {
    let repo = match Repository::open(cwd) {
        Ok(repo) => repo,
        Err(_) => return Vec::new(),
    };
    let run = || -> Result<Vec<PanelDiffHunk>, git2::Error> {
        let rel = contained_rel_path(cwd, path)?;
        let diff = single_file_diff(&repo, &rel, staged, Some(context_lines))?;
        Ok(diff_hunks(&diff))
    };
    run().unwrap_or_default()
}

/// `gitStagedDiff` — raw unified patch text HEAD→index (empty tree when
/// HEAD is unborn), later used as AI-message context.
pub fn staged_diff_text(cwd: &Path) -> String {
    Repository::open(cwd)
        .and_then(|repo| {
            let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
            let index = repo.index()?;
            repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
                .map(|diff| diff_patch_text(&diff))
        })
        .unwrap_or_default()
}

// ── log ─────────────────────────────────────────────────────────────────

/// `gitLog` — TIME-sorted revwalk from HEAD, decorated with branch tips
/// and tags. Errors answer the empty list.
pub fn log(cwd: &Path, limit: u32) -> Vec<PanelCommit> {
    Repository::open(cwd)
        .map(|repo| log_entries(&repo, limit))
        .unwrap_or_default()
}

fn log_entries(repo: &Repository, limit: u32) -> Vec<PanelCommit> {
    let Some(head) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) else {
        return Vec::new();
    };
    let mut walk = match repo.revwalk() {
        Ok(walk) => walk,
        Err(_) => return Vec::new(),
    };
    if walk.set_sorting(Sort::TIME).is_err() || walk.push(head.id()).is_err() {
        return Vec::new();
    }

    // Decorations: branch tips and tags keyed by the ref TARGET's 7-char
    // short sha — fixed at 7 deliberately (`rev-parse --short` parity), not
    // git2's adaptive short-sha length. Annotated tags are NOT peeled: they
    // key on the tag object's own sha and land on no commit row.
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
    for oid in walk.take(limit as usize).map_while(Result::ok) {
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };
        let author = commit.author();
        let s = short_sha(commit.id());
        let parents: Vec<String> = (0..commit.parent_count())
            .map(|i| commit.parent_id(i).map(short_sha).unwrap_or_default())
            .collect();
        out.push(PanelCommit {
            sha: s.clone(),
            author: author.name().map(str::to_owned).unwrap_or_default(),
            date: iso_time(author.when().seconds(), author.when().offset_minutes()),
            subject: commit
                .summary()
                .ok()
                .flatten()
                .map(str::to_owned)
                .unwrap_or_default(),
            parents,
            is_head: s == head_short,
            branch_heads: head_map.get(&s).cloned().unwrap_or_default(),
            tags: tag_map.get(&s).cloned().unwrap_or_default(),
        });
    }
    out
}

// ── History lane layout ──────────────────────────────────────────────────

/// One commit's lane-relevant facts — the Rust shape of tide's
/// `LaneCommit` (`src/lib/git/lanes.ts`). Shas are whatever the caller
/// walks with (the panel's 7-char short shas); only equality matters.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LaneCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub is_head: bool,
    pub branch_heads: Vec<String>,
}

impl LaneCommit {
    pub fn from_panel(commit: &PanelCommit) -> Self {
        Self {
            sha: commit.sha.clone(),
            parents: commit.parents.clone(),
            is_head: commit.is_head,
            branch_heads: commit.branch_heads.clone(),
        }
    }
}

/// The lane assignment for one commit, paired by index with its
/// [`LaneCommit`] — tide's `LaidOutCommit` without the payload echo.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LaidOutCommit {
    /// x-index of the commit's lane.
    pub lane: usize,
    /// Lanes assigned to `parents[1..]` (merge joins), aligned by index.
    pub merge_from_lanes: Vec<usize>,
}

/// Pure lane layout for the History graph column (lazygit-style) — the Rust
/// port of tide's `assignLanes`.
///
/// Walks newest→oldest over an active-lane pool: each lane either waits for
/// a specific sha (its next expected commit) or is free. A commit takes the
/// lowest lane waiting on it (collapsing duplicates — merge joins), else the
/// lowest free lane. Its first parent continues on that lane; extra parents
/// claim free lanes (reusing one already waiting on the same sha). There is
/// no lane cap here, exactly like upstream — the cap is a draw-time x clamp
/// in the graph column.
pub fn assign_lanes(commits: &[LaneCommit]) -> Vec<LaidOutCommit> {
    // `None` is a free lane; `Some(sha)` waits for that sha.
    let mut active: Vec<Option<&str>> = Vec::new();
    let mut out = Vec::with_capacity(commits.len());

    for commit in commits {
        let sha = commit.sha.as_str();
        let mut lane = active
            .iter()
            .position(|waiting| waiting.is_some_and(|w| w == sha));
        if let Some(found) = lane {
            // Clear later duplicates — a merge join collapses onto the
            // lowest lane waiting on this sha.
            for waiting in active.iter_mut().skip(found + 1) {
                if waiting.is_some_and(|w| w == sha) {
                    *waiting = None;
                }
            }
        } else {
            lane = active.iter().position(|waiting| waiting.is_none());
        }
        let lane = lane.unwrap_or(active.len());
        while active.len() <= lane {
            active.push(None);
        }
        active[lane] = None;

        let mut parents = commit.parents.iter().map(String::as_str);
        if let Some(first) = parents.next() {
            active[lane] = Some(first);
        }
        let mut merge_from_lanes = Vec::new();
        for parent in parents {
            let mut found = active
                .iter()
                .position(|waiting| waiting.is_some_and(|w| w == parent));
            if found.is_none() {
                found = active.iter().position(|waiting| waiting.is_none());
            }
            let claimed = found.unwrap_or(active.len());
            while active.len() <= claimed {
                active.push(None);
            }
            active[claimed] = Some(parent);
            merge_from_lanes.push(claimed);
        }

        out.push(LaidOutCommit {
            lane,
            merge_from_lanes,
        });
    }

    out
}

/// `rev-parse --short HEAD` parity: 7 hex chars, always.
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

// ── commit inspection ───────────────────────────────────────────────────

/// `gitCommitFiles` — numstat per delta of the commit vs its first parent
/// (empty tree for root commits). Errors answer the empty list.
pub fn commit_files(cwd: &Path, sha: &str) -> Vec<PanelFileChange> {
    let repo = match Repository::open(cwd) {
        Ok(repo) => repo,
        Err(_) => return Vec::new(),
    };
    (|| -> Result<Vec<PanelFileChange>, git2::Error> {
        let diff = commit_tree_diff(&repo, sha)?;
        let numstat = diff_numstat(&diff);
        let mut out = Vec::new();
        for delta in diff.deltas() {
            let Some(path) = delta_path(&delta) else {
                continue;
            };
            let (additions, deletions) = numstat.get(&path).copied().unwrap_or((0, 0));
            out.push(PanelFileChange {
                path,
                status: delta_status_word(delta.status()).to_owned(),
                staged: true,
                additions,
                deletions,
            });
        }
        Ok(out)
    })()
    .unwrap_or_default()
}

/// `gitCommitFileDiff` — the commit vs its first parent, pathspec-limited,
/// same hunk shape as `file_diff`. Errors answer the empty list.
pub fn commit_file_diff(cwd: &Path, sha: &str, path: &str) -> Vec<PanelDiffHunk> {
    let repo = match Repository::open(cwd) {
        Ok(repo) => repo,
        Err(_) => return Vec::new(),
    };
    let run = || -> Result<Vec<PanelDiffHunk>, git2::Error> {
        let rel = contained_rel_path(cwd, path)?;
        let commit = repo.revparse_single(sha).and_then(|o| o.peel_to_commit())?;
        let this_tree = commit.tree()?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let mut opts = DiffOptions::new();
        opts.pathspec(&rel);
        let diff =
            repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&this_tree), Some(&mut opts))?;
        Ok(diff_hunks(&diff))
    };
    run().unwrap_or_default()
}

/// `gitCommitMessage` — the full commit message, trimmed. Errors answer "".
pub fn commit_message(cwd: &Path, sha: &str) -> String {
    Repository::open(cwd)
        .and_then(|repo| {
            repo.revparse_single(sha)
                .and_then(|o| o.peel_to_commit())
                .map(|commit| commit.message().unwrap_or("").trim().to_owned())
        })
        .unwrap_or_default()
}

/// `git diff-tree --root -r <sha>` — the commit vs its first parent (empty
/// tree for root commits). No rename detection, like the plumbing call.
fn commit_tree_diff<'r>(repo: &'r Repository, sha: &str) -> Result<Diff<'r>, git2::Error> {
    let commit = repo.revparse_single(sha).and_then(|o| o.peel_to_commit())?;
    let this_tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&this_tree), None)
}

/// numstat per delta — '+'/'-' line counts (binary files count 0/0).
fn diff_numstat(diff: &Diff<'_>) -> HashMap<String, (u64, u64)> {
    let stats: RefCell<HashMap<String, (u64, u64)>> = RefCell::new(HashMap::new());
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

// ── commit / amend / revert ─────────────────────────────────────────────

/// `gitCommit` — commits the INDEX as-is; the UI does bulk stage-all first
/// when it wants worktree changes included. Attribution (trailer + author
/// override) applies per the data-dir config, and the new sha comes back in
/// the 7-char short form the panel's log uses.
pub fn panel_commit(cwd: &Path, message: &str) -> PanelCommitResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| {
            let attribution = store::config::current_attribution();
            commit_staged(&repo, message, attribution.as_ref())
        });
    match result {
        Ok(sha) => PanelCommitResult {
            ok: true,
            sha: Some(sha),
            error: None,
        },
        Err(error) => PanelCommitResult {
            ok: false,
            sha: None,
            error: Some(error),
        },
    }
}

/// `gitAmend` — replaces HEAD with the index tree. `None` (or a blank)
/// message keeps HEAD's original; the original author is preserved and the
/// committer is "now", per `git commit --amend` semantics.
pub fn amend(cwd: &Path, message: Option<&str>) -> PanelCommitResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| {
            let attribution = store::config::current_attribution();
            amend_head(&repo, message, attribution.as_ref())
        });
    match result {
        Ok(sha) => PanelCommitResult {
            ok: true,
            sha: Some(sha),
            error: None,
        },
        Err(error) => PanelCommitResult {
            ok: false,
            sha: None,
            error: Some(error),
        },
    }
}

/// `gitRevert` — reverts the commit and commits the inverse with git's
/// revert message template + attribution. Conflicts answer ok:false and
/// leave the repo mid-revert for the resolve flow.
pub fn revert(cwd: &Path, sha: &str) -> PanelRevertResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| {
            let attribution = store::config::current_attribution();
            revert_commit(&repo, sha, attribution.as_ref())
        });
    match result {
        Ok(new_sha) => PanelRevertResult {
            ok: true,
            new_sha: Some(new_sha),
            error: None,
        },
        Err(error) => PanelRevertResult {
            ok: false,
            new_sha: None,
            error: Some(error),
        },
    }
}

/// The repo identity libgit2 resolves (config + env), with the tools path's
/// error text when nothing resolves — the commit itself has no author.
fn panel_signature(repo: &Repository) -> Result<git2::Signature<'static>, String> {
    repo.signature().map_err(|_| {
        "no user.name/user.email configured (git config) and no GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL set"
            .to_string()
    })
}

fn commit_staged(
    repo: &Repository,
    message: &str,
    attribution: Option<&store::config::CommitAttribution>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("enter a commit message".into());
    }
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
    let parents: Vec<git2::Commit<'_>> = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .into_iter()
        .collect();
    let parent_refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
    commit_with_tree(repo, message, &parent_refs, attribution)
}

/// Commit the current index tree with attribution applied — the libgit2
/// equivalent of the tools path's author/committer signatures + env override.
fn commit_with_tree(
    repo: &Repository,
    message: &str,
    parents: &[&git2::Commit<'_>],
    attribution: Option<&store::config::CommitAttribution>,
) -> Result<String, String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let committer = panel_signature(repo)?;
    // The repo's applied identity (author unless attribution overrides it,
    // and the co-author in Author mode). Signature accessors return
    // Result<Option<_>> — missing halves read as the empty string.
    let user_name = committer.name().ok().unwrap_or_default();
    let user_email = committer.email().ok().unwrap_or_default();
    let (author, message) = match attribution {
        Some(attribution) => {
            let message = store::config::append_trailer_once(
                message,
                &attribution.trailer(user_name, user_email),
            );
            match attribution.author_override() {
                Some((name, email)) => {
                    let author = git2::Signature::now(name, email).map_err(|e| e.to_string())?;
                    (author, message)
                }
                None => (committer.clone(), message),
            }
        }
        None => (committer.clone(), message.to_owned()),
    };
    let oid = repo
        .commit(Some("HEAD"), &author, &committer, &message, &tree, parents)
        .map_err(|e| e.to_string())?;
    Ok(short_sha(oid))
}

fn amend_head(
    repo: &Repository,
    message: Option<&str>,
    attribution: Option<&store::config::CommitAttribution>,
) -> Result<String, String> {
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
    let committer = panel_signature(repo)?;
    let text = match message.map(str::trim) {
        Some(m) if !m.is_empty() => Some(m),
        _ => None,
    };
    let text = match (attribution, text) {
        (Some(attribution), Some(text)) => {
            // Co-author mode always trails; Author mode re-trails the user's
            // identity only when amending a Tide-authored commit (the
            // original author stays put — standard amend semantics).
            let keep = match attribution.mode {
                store::config::GitAttributionMode::CoAuthor => true,
                store::config::GitAttributionMode::Author => head
                    .author()
                    .email()
                    .ok()
                    .is_some_and(|email| email.eq_ignore_ascii_case(&attribution.email)),
            };
            if !keep {
                Some(text.to_owned())
            } else {
                let committer_name = committer.name().ok().unwrap_or_default();
                let committer_email = committer.email().ok().unwrap_or_default();
                Some(store::config::append_trailer_once(
                    text,
                    &attribution.trailer(committer_name, committer_email),
                ))
            }
        }
        (_, text) => text.map(str::to_owned),
    };
    let oid = head
        .amend(
            Some("HEAD"),
            Some(&author),
            Some(&committer),
            None,
            text.as_deref(),
            Some(&tree),
        )
        .map_err(|e| e.to_string())?;
    Ok(short_sha(oid))
}

fn revert_commit(
    repo: &Repository,
    sha: &str,
    attribution: Option<&store::config::CommitAttribution>,
) -> Result<String, String> {
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
    let oid = commit_with_tree(repo, &message, &[&head], attribution)?;
    // The CLI clears MERGE_MSG/REVERT_HEAD once the commit lands.
    let _ = repo.cleanup_state();
    Ok(oid)
}

// ── staging / bulk ops / stash / discard / restore ──────────────────────

/// `gitStage` — `git add -- <path>` (stage=true) or
/// `git restore --staged -- <path>` (stage=false). Not-a-repo answers the
/// bare `{ok: false}` the upstream no-workspace path returns.
pub fn stage_file(cwd: &Path, path: &str, stage: bool) -> PanelOpResult {
    let repo = match Repository::open(cwd) {
        Ok(repo) => repo,
        Err(_) => {
            return PanelOpResult {
                ok: false,
                error: None,
            };
        }
    };
    let result = contained_rel_path(cwd, path)
        .map_err(|e| e.to_string())
        .and_then(|rel| stage_or_unstage_file(&repo, &rel, stage));
    op_result(result)
}

/// `gitBulk` — stage-all | unstage-all | restore-all | stash | stash-pop.
pub fn bulk(cwd: &Path, op: &str, message: Option<&str>) -> PanelOpResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|mut repo| match op {
            "stage-all" => stage_all(&repo),
            "unstage-all" => unstage_all(&repo),
            "restore-all" => restore_all(&repo),
            "stash" => stash_save(&mut repo, message),
            "stash-pop" => stash_pop(&mut repo),
            other => Err(format!("unknown op: {other}")),
        });
    op_result(result)
}

/// `gitStashList` — `stash@{n}` refs + raw stash messages, newest first.
/// Errors answer the empty list.
pub fn stash_list(cwd: &Path) -> Vec<PanelStash> {
    Repository::open(cwd)
        .map(|mut repo| stash_entries(&mut repo))
        .unwrap_or_default()
}

/// `gitDiscardFile` — discard workdir-only changes for the path; the
/// staged (index) copy is untouched. Untracked paths are removed.
pub fn discard_file(cwd: &Path, path: &str) -> PanelOpResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| discard_file_inner(&repo, cwd, path));
    op_result(result)
}

/// `gitRestoreFile` — `git checkout <sha> -- <path>`: blob content from the
/// sha into worktree AND index; a path absent from the sha is deleted from
/// the worktree only (no index touch).
pub fn restore_file_from(cwd: &Path, path: &str, sha: &str) -> PanelOpResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| restore_file(&repo, cwd, path, sha));
    op_result(result)
}

fn op_result(result: Result<(), String>) -> PanelOpResult {
    match result {
        Ok(()) => PanelOpResult {
            ok: true,
            error: None,
        },
        Err(error) => PanelOpResult::err(error),
    }
}

fn stage_or_unstage_file(repo: &Repository, rel: &str, stage: bool) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    if stage {
        // `git add -- <path>`: stage the workdir state, deletions included.
        let exists = repo
            .workdir()
            .map(|w| w.join(rel).exists())
            .unwrap_or(false);
        if exists {
            index.add_path(Path::new(rel)).map_err(|e| e.to_string())?;
        } else {
            index
                .remove_path(Path::new(rel))
                .map_err(|e| e.to_string())?;
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

fn discard_file_inner(repo: &Repository, root: &Path, file_path: &str) -> Result<(), String> {
    let rel = contained_rel_path(root, file_path).map_err(|e| e.to_string())?;
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
/// delete it from the worktree only (no index touch).
fn restore_file(repo: &Repository, root: &Path, file_path: &str, sha: &str) -> Result<(), String> {
    let rel = contained_rel_path(root, file_path).map_err(|e| e.to_string())?;
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
fn write_workdir_file(
    repo: &Repository,
    rel: &str,
    content: &[u8],
    mode: u32,
) -> Result<(), String> {
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

fn stash_save(repo: &mut Repository, message: Option<&str>) -> Result<(), String> {
    // `git stash push` with nothing to stash exits 0 — libgit2 errors, so
    // gate it on real changes first.
    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    let has_changes = repo
        .statuses(Some(&mut opts))
        .map(|statuses| {
            statuses
                .iter()
                .any(|e| !e.status().is_empty() && !e.status().is_ignored())
        })
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

fn stash_entries(repo: &mut Repository) -> Vec<PanelStash> {
    let mut out = Vec::new();
    let _ = repo.stash_foreach(|index, message, _| {
        out.push(PanelStash {
            // `git stash list` renders "stash@{0}: On main: msg" — ref before
            // the first ':', message after.
            stash_ref: format!("stash@{{{index}}}"),
            message: message.to_owned(),
        });
        true
    });
    out
}

// ── branch info / recent branches ───────────────────────────────────────

/// `gitBranchInfo`: live branch + short HEAD; detached heads read "HEAD"
/// like `rev-parse --abbrev-ref HEAD`, unborn reads null/null.
pub fn branch_info(cwd: &Path) -> PanelBranchInfo {
    Repository::open(cwd)
        .ok()
        .map(|repo| branch_info_inner(&repo))
        .unwrap_or(PanelBranchInfo {
            branch: None,
            head_commit: None,
        })
}

fn branch_info_inner(repo: &Repository) -> PanelBranchInfo {
    let Some(head) = repo.head().ok() else {
        return PanelBranchInfo {
            branch: None,
            head_commit: None,
        };
    };
    let branch = if head.is_branch() {
        head.shorthand().ok().map(String::from)
    } else {
        Some("HEAD".to_owned())
    };
    let head_commit = head
        .peel_to_commit()
        .ok()
        .map(|commit| short_sha(commit.id()));
    PanelBranchInfo {
        branch,
        head_commit,
    }
}

/// `gitAheadBehind` — HEAD vs its upstream; None without an upstream.
pub fn ahead_behind(cwd: &Path) -> Option<PanelAheadBehind> {
    let repo = Repository::open(cwd).ok()?;
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
    Some(PanelAheadBehind {
        ahead: ahead as u64,
        behind: behind as u64,
    })
}

/// `gitHeadSha` — the full 40-char oid of HEAD (None unborn/not-a-repo).
pub fn head_sha(cwd: &Path) -> Option<String> {
    Repository::open(cwd)
        .ok()?
        .head()
        .ok()?
        .peel_to_commit()
        .ok()
        .map(|commit| commit.id().to_string())
}

fn head_branch_name(repo: &Repository) -> Option<String> {
    repo.head().ok()?.shorthand().ok().map(String::from)
}

/// `gitRecentBranches` — reflog walk of checkout entries ("moving from A to
/// B", newest first, "to" before "from"), max 5, deduped, current excluded;
/// falls back to local branches by latest commit date without a reflog.
pub fn recent_branches(cwd: &Path) -> Vec<String> {
    Repository::open(cwd)
        .map(|repo| recent_branches_inner(&repo))
        .unwrap_or_default()
}

fn recent_branches_inner(repo: &Repository) -> Vec<String> {
    let current = head_branch_name(repo).unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut ordered: Vec<String> = Vec::new();
    // The reflog iterates in file order, which is newest-first.
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
                if !candidate.is_empty()
                    && candidate != current
                    && seen.insert(candidate.to_owned())
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
            let Some(name) = branch.name().ok().flatten().map(str::to_owned) else {
                continue;
            };
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
    branches.sort_by_key(|(_, date)| std::cmp::Reverse(*date));
    branches.into_iter().take(5).map(|(name, _)| name).collect()
}

// ── merge / conflicts / resolve ─────────────────────────────────────────

/// `gitMergeBranch` — fast-forward or merge-commit (`--no-edit` message,
/// committed automatically like the CLI). Conflicts surface ok:false with
/// the conflicted paths and leave the repo mid-merge for the resolve flow.
pub fn merge(cwd: &Path, name: &str) -> PanelMergeResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| {
            let attribution = store::config::current_attribution();
            merge_branch(&repo, name, attribution.as_ref())
        });
    match result {
        Ok((ok, conflicts, error)) => PanelMergeResult {
            ok,
            conflicts,
            error,
        },
        Err(error) => PanelMergeResult {
            ok: false,
            conflicts: Vec::new(),
            error: Some(error),
        },
    }
}

fn merge_branch(
    repo: &Repository,
    name: &str,
    attribution: Option<&store::config::CommitAttribution>,
) -> Result<(bool, Vec<String>, Option<String>), String> {
    let reference = repo
        .find_reference(&format!("refs/heads/{name}"))
        .map_err(|e| format!("merge: {name} — {e}"))?;
    let commit = reference.peel_to_commit().map_err(|e| e.to_string())?;
    let annotated = repo
        .reference_to_annotated_commit(&reference)
        .map_err(|e| e.to_string())?;
    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.to_string())?;
    if analysis.is_up_to_date() {
        return Ok((true, Vec::new(), None));
    }
    if analysis.is_fast_forward() || analysis.is_unborn() {
        fast_forward_to(repo, &commit, "merge: Fast-forward").map_err(|e| e.to_string())?;
        return Ok((true, Vec::new(), None));
    }
    let Some(head) = head else {
        return Err("merge: no HEAD".into());
    };

    let mut checkout = CheckoutBuilder::new();
    checkout
        .allow_conflicts(true)
        .conflict_style_merge(true)
        .force();
    if let Err(error) = repo.merge(
        &[&annotated],
        Some(&mut MergeOptions::new()),
        Some(&mut checkout),
    ) {
        // A failed merge may still have left conflicts staged — surface them
        // for the resolve flow like the TS's error-path re-list.
        let conflicts = conflict_entries(repo);
        if !conflicts.is_empty() {
            return Ok((false, conflict_paths(&conflicts), None));
        }
        return Ok((false, Vec::new(), Some(error.to_string())));
    }
    let index = repo.index().map_err(|e| e.to_string())?;
    if index.has_conflicts() {
        return Ok((false, conflict_paths(&conflict_entries(repo)), None));
    }

    // The CLI's `--no-edit` message: "Merge branch 'x'" (no "into" on the
    // default branch names), parents HEAD + theirs.
    let current = head_branch_name(repo).unwrap_or_default();
    let message = if current.is_empty() || current == "master" || current == "main" {
        format!("Merge branch '{name}'")
    } else {
        format!("Merge branch '{name}' into {current}")
    };
    commit_with_tree(repo, &message, &[&head, &commit], attribution).map_err(|e| e.to_string())?;
    let _ = repo.cleanup_state();
    Ok((true, Vec::new(), None))
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

/// `gitConflictFiles` — unmerged index entries with the porcelain conflict
/// code. Errors answer the empty list.
pub fn conflict_files(cwd: &Path) -> Vec<PanelConflict> {
    Repository::open(cwd)
        .map(|repo| conflict_entries(&repo))
        .unwrap_or_default()
}

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

fn conflict_entries(repo: &Repository) -> Vec<PanelConflict> {
    let Ok(index) = repo.index() else {
        return Vec::new();
    };
    let Ok(conflicts) = index.conflicts() else {
        return Vec::new();
    };
    let mut out = Vec::new();
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
            out.push(PanelConflict {
                path,
                state: state.to_owned(),
            });
        }
    }
    out
}

fn conflict_paths(conflicts: &[PanelConflict]) -> Vec<String> {
    conflicts.iter().map(|c| c.path.clone()).collect()
}

/// `gitResolveFile`: pick a side for one conflicted path and stage the
/// resolution. A side that deleted the file → `git rm` semantics (drop the
/// workdir file + index entries, recording the deletion); otherwise the
/// side's blob is materialized in the worktree and staged.
pub fn resolve_file(cwd: &Path, path: &str, side: &str) -> PanelOpResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| resolve_file_inner(&repo, cwd, path, side));
    op_result(result)
}

fn resolve_file_inner(
    repo: &Repository,
    root: &Path,
    file_path: &str,
    side: &str,
) -> Result<(), String> {
    let rel = contained_rel_path(root, file_path).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let Some(conflict) = index.conflict_get(Path::new(&rel)).ok() else {
        return Err(format!("{rel} is not unmerged"));
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
            index
                .conflict_remove(Path::new(&rel))
                .map_err(|e| e.to_string())?;
            // A stage-0 entry shouldn't coexist with conflicts, but a stale
            // one must not survive as a ghost.
            let _ = index.remove_path(Path::new(&rel));
        }
        Some(entry) => {
            let blob = repo.find_blob(entry.id).map_err(|e| e.to_string())?;
            write_workdir_file(repo, &rel, blob.content(), entry.mode as u32)?;
            index
                .conflict_remove(Path::new(&rel))
                .map_err(|e| e.to_string())?;
            index.add_path(Path::new(&rel)).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

// ── network ops (fetch / pull) ──────────────────────────────────────────

/// The remote a bare fetch/pull uses: the current branch's configured
/// remote (branch.<name>.remote), else "origin".
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

/// The CLI inherited the login-shell env, so SSH went through ssh-agent and
/// HTTPS through the configured credential helpers. git2 gets the same
/// stack explicitly: agent keys for SSH remotes, and one non-interactive
/// `git credential fill` for HTTPS (the helpers themselves are git's, so
/// keychain/manager behave identically). This subprocess is the module's
/// only git CLI use — spawned through `command_env::command` so the GUI
/// process's captured shell PATH resolves `git`.
fn credential_helper_fill(
    workdir: &Path,
    url: &str,
    username: Option<&str>,
) -> Result<Cred, git2::Error> {
    let mut command = crate::command_env::command("git");
    command
        .args(["-c", "credential.interactive=false", "credential", "fill"])
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "echo")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
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

/// Remote auth stack: ssh-agent first for SSH remotes, then one
/// `git credential fill` for HTTPS — each tried once per fetch.
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

/// `gitFetch` — bare fetch of the default remote's configured refspecs.
pub fn fetch(cwd: &Path) -> PanelOpResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| fetch_remote(&repo));
    op_result(result)
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

/// `gitPull` — `git pull --ff-only`: fetch, then fast-forward HEAD's branch
/// to its upstream or fail.
pub fn pull(cwd: &Path) -> PanelOpResult {
    let result = Repository::open(cwd)
        .map_err(|e| e.to_string())
        .and_then(|repo| pull_inner(&repo));
    op_result(result)
}

fn pull_inner(repo: &Repository) -> Result<(), String> {
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
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.to_string())?;
    if analysis.is_up_to_date() {
        return Ok(());
    }
    if analysis.is_fast_forward() {
        return fast_forward_to(repo, &target, "pull: Fast-forward").map_err(|e| e.to_string());
    }
    Err("Not possible to fast-forward, aborting.".into())
}

// ── status ──────────────────────────────────────────────────────────────

fn status_entries(repo: &Repository) -> Result<Vec<PanelFileChange>, git2::Error> {
    // numstat came from `git diff HEAD` — tracked changes (staged + unstaged)
    // vs HEAD; untracked files read 0/0. Unborn HEAD → every entry stays 0/0.
    let mut stats: HashMap<String, (u64, u64)> = HashMap::new();
    if let Some(head_tree) = repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        if let Ok(diff) = repo.diff_tree_to_workdir_with_index(Some(&head_tree), None) {
            let current: RefCell<Option<String>> = RefCell::new(None);
            let mut file_cb = |delta: DiffDelta<'_>, _f: f32| -> bool {
                *current.borrow_mut() = delta_path(&delta);
                true
            };
            let mut line_cb = |_delta: DiffDelta<'_>,
                               _hunk: Option<git2::DiffHunk<'_>>,
                               line: DiffLine<'_>|
             -> bool {
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
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut out = Vec::new();
    for entry in statuses.iter() {
        let mut path = String::from_utf8_lossy(entry.path_bytes()).into_owned();
        // libgit2 keys rename entries by the OLD path; porcelain (and the
        // `old -> new` split) reports the new one.
        if entry.status().is_index_renamed() || entry.status().is_wt_renamed() {
            if let Some(new_path) = entry
                .head_to_index()
                .or_else(|| entry.index_to_workdir())
                .and_then(|d| {
                    d.new_file()
                        .path()
                        .map(|p| p.to_string_lossy().into_owned())
                })
            {
                path = new_path;
            }
        }
        let base_name = path.rsplit('/').next().unwrap_or_default();
        // macOS metadata noise and dir-shaped entries never render (and must
        // not be discardable) — the upstream skip.
        if base_name.is_empty() || base_name == ".DS_Store" {
            continue;
        }
        let (x, y) = porcelain_xy(entry.status());
        let (status, staged) = status_word_and_staged(x, y);
        let (additions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
        out.push(PanelFileChange {
            path,
            status: status.to_owned(),
            staged,
            additions,
            deletions,
        });
    }
    Ok(out)
}

/// The (x, y) porcelain code pair for a git2 status — the upstream status
/// mapper keyed off these characters directly.
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

/// The upstream status mapping, verbatim: untracked/added/deleted/renamed/
/// modified with the staged flag from the x column.
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

fn delta_path(delta: &DiffDelta<'_>) -> Option<String> {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|p| p.to_string_lossy().into_owned())
}

// ── diff machinery ──────────────────────────────────────────────────────

/// Walk libgit2's patch printer: 'H' lines open hunks (header = the raw
/// `@@ ... @@` text), '+'/'-'/' ' lines carry the upstream prefix-included
/// `text` and libgit2's own old/new line numbers. EOFNL markers ('=' '>' '<')
/// are skipped.
fn diff_hunks(diff: &Diff<'_>) -> Vec<PanelDiffHunk> {
    let mut hunks: Vec<PanelDiffHunk> = Vec::new();
    let mut cb =
        |_d: git2::DiffDelta<'_>, _h: Option<git2::DiffHunk<'_>>, line: DiffLine<'_>| -> bool {
            match line.origin() {
                'H' => hunks.push(PanelDiffHunk {
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
                        hunk.lines.push(PanelDiffLine {
                            kind: kind.to_owned(),
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
/// headers, hunks, EOFNL markers) for the AI-message context.
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

/// `resolveInsideWorkspace(root, rel)` — the lexical containment upstream
/// enforced before letting a panel-supplied path near git. `..` segments
/// are resolved lexically first (the upstream `lexical_join`).
fn contained_rel_path(root: &Path, rel: &str) -> Result<String, git2::Error> {
    let joined = lexical_join(root, rel);
    match joined.strip_prefix(root).ok() {
        Some(rest) if !rest.as_os_str().is_empty() => Ok(rest.to_string_lossy().replace('\\', "/")),
        _ => Err(git2::Error::from_str(&format!(
            "Path \"{rel}\" escapes the repository root"
        ))),
    }
}

/// Join then normalize `.` / `..` segments lexically, like upstream's
/// `worktree::lexical_join`.
fn lexical_join(base: &Path, rel: &str) -> std::path::PathBuf {
    let mut out = base.to_path_buf();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// clampContextLines (upstream expand-context.ts): absent → git default;
/// ladder values clamp to 1..200; >= 1000 is the full-file sentinel.
fn clamp_context_lines(n: Option<u32>) -> Option<u32> {
    let n = n?;
    if n >= 1000 {
        return Some(n);
    }
    Some(n.clamp(1, 200))
}

fn single_file_diff<'r>(
    repo: &'r Repository,
    rel: &str,
    staged: bool,
    context_lines: Option<u32>,
) -> Result<Diff<'r>, git2::Error> {
    let mut opts = DiffOptions::new();
    opts.pathspec(rel);
    if let Some(n) = clamp_context_lines(context_lines) {
        opts.context_lines(n);
    }
    let diff = if staged {
        // `git diff --cached`: vs HEAD, or vs the empty tree when unborn
        // (the CLI shows staged files as added pre-first-commit).
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let index = repo.index()?;
        repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
    };
    diff
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::RepositoryInitOptions;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tide-gitpanel-{name}-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seeded_repo(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        let root = dir.join("repo");
        fs::create_dir_all(&root).unwrap();
        let repo = Repository::init_opts(&root, RepositoryInitOptions::new().initial_head("main"))
            .unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Ada").unwrap();
        cfg.set_str("user.email", "ada@example.com").unwrap();
        root
    }

    fn commit_all(root: &Path, message: &str) {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parents: Vec<git2::Commit> = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .into_iter()
            .collect();
        let sig = repo.signature().unwrap();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
            .unwrap();
    }

    fn stage(root: &Path, rel: &str) {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(rel)).unwrap();
        index.write().unwrap();
    }

    fn find<'a>(changes: &'a [PanelFileChange], path: &str) -> &'a PanelFileChange {
        changes.iter().find(|c| c.path == path).unwrap_or_else(|| {
            panic!("no entry for {path}: {changes:?}");
        })
    }

    fn line(kind: &str, old_no: Option<u32>, new_no: Option<u32>, text: &str) -> PanelDiffLine {
        PanelDiffLine {
            kind: kind.into(),
            old_no,
            new_no,
            text: text.into(),
        }
    }

    fn lane(sha: &str, parents: &[&str]) -> LaneCommit {
        LaneCommit {
            sha: sha.into(),
            parents: parents.iter().map(|p| (*p).into()).collect(),
            is_head: false,
            branch_heads: Vec::new(),
        }
    }

    fn lanes_of(commits: &[LaneCommit]) -> Vec<(usize, Vec<usize>)> {
        assign_lanes(commits)
            .into_iter()
            .map(|laid| (laid.lane, laid.merge_from_lanes))
            .collect()
    }

    #[test]
    fn lanes_linear_history_uses_one_lane() {
        // c3 → c2 → c1 → c0, newest first.
        let commits = [
            lane("c3", &["c2"]),
            lane("c2", &["c1"]),
            lane("c1", &["c0"]),
            lane("c0", &[]),
        ];
        assert_eq!(
            lanes_of(&commits),
            vec![(0, vec![]), (0, vec![]), (0, vec![]), (0, vec![])],
        );
    }

    #[test]
    fn lanes_branch_and_merge_uses_two_lanes_with_join() {
        // m (merge) has parents b and a; b branched off a2.
        //   m
        //  / \
        // b   a3? no — walk newest first:
        // m → [b, a2], b → [a2], a2 → [a1], a1 → []
        let commits = [
            lane("m", &["b", "a2"]),
            lane("b", &["a2"]),
            lane("a2", &["a1"]),
            lane("a1", &[]),
        ];
        assert_eq!(
            lanes_of(&commits),
            // m: lane 0, first parent b continues there, a2 claims lane 1.
            // b: arrives on the lane waiting on it (0), continues a2 there.
            // a2: lanes 0+1 both waiting → collapses onto lane 0.
            vec![(0, vec![1]), (0, vec![]), (0, vec![]), (0, vec![])],
        );
    }

    #[test]
    fn lanes_two_branches_off_one_commit() {
        // Newest first: t2 (tip of branch 2), s2 (tip of branch 1), both
        // parented on base; then base.
        let commits = [
            lane("t2", &["t1"]),
            lane("s2", &["s1"]),
            lane("t1", &["base"]),
            lane("s1", &["base"]),
            lane("base", &[]),
        ];
        assert_eq!(
            lanes_of(&commits),
            vec![
                (0, vec![]),
                (1, vec![]),
                (0, vec![]),
                (1, vec![]),
                (0, vec![])
            ],
        );
    }

    #[test]
    fn lanes_octopus_merge_claims_one_lane_per_extra_parent() {
        // Octopus: o merges three tips t1..t3, each two commits deep.
        let commits = [
            lane("o", &["t1", "t2", "t3"]),
            lane("t1", &["m"]),
            lane("t2", &["m"]),
            lane("t3", &["m"]),
            lane("m", &[]),
        ];
        assert_eq!(
            lanes_of(&commits),
            vec![
                (0, vec![1, 2]), // two merge edges: t1 continues on lane 0
                (0, vec![]),
                (1, vec![]),
                (2, vec![]),
                (0, vec![]), // lanes 0..2 wait on m → collapses to 0
            ],
        );
    }

    #[test]
    fn lanes_grow_past_any_cap_and_reuse_freed_lanes() {
        // Six simultaneous branches: the layout itself has no cap (upstream
        // clamps only at draw time), and freed lanes are reused lowest-first.
        let commits: Vec<LaneCommit> = std::iter::once(lane("x", &["b1", "b2", "b3"]))
            .chain((1..=3).map(|i| lane(&format!("b{i}"), &["root"])))
            .chain([lane("root", &[])])
            .collect();
        assert_eq!(
            lanes_of(&commits),
            vec![
                (0, vec![1, 2]),
                (0, vec![]),
                (1, vec![]),
                (2, vec![]),
                (0, vec![])
            ],
        );

        // Exhaustion beyond any width: five extra parents force lanes 1..5.
        let wide: Vec<LaneCommit> = std::iter::once(lane("w", &["p1", "p2", "p3", "p4", "p5"]))
            .chain((1..=5).map(|i| lane(&format!("p{i}"), &["z"])))
            .chain([lane("z", &[])])
            .collect();
        assert_eq!(
            lanes_of(&wide),
            vec![
                (0, vec![1, 2, 3, 4]),
                (0, vec![]),
                (1, vec![]),
                (2, vec![]),
                (3, vec![]),
                (4, vec![]),
                (0, vec![]),
            ],
        );
    }

    #[test]
    fn status_covers_staged_unstaged_untracked_deleted_with_counts() {
        let root = seeded_repo("status");
        fs::write(root.join("tracked.txt"), "line1\nline2\nline3\n").unwrap();
        fs::write(root.join("to_delete.txt"), "bye\n").unwrap();
        fs::write(root.join("both.txt"), "one\ntwo\n").unwrap();
        commit_all(&root, "initial");
        // Unstaged modification: replace two lines with one.
        fs::write(root.join("tracked.txt"), "line1\nchanged\n").unwrap();
        // Staged new file.
        fs::write(root.join("staged_new.txt"), "a\nb\nc\n").unwrap();
        stage(&root, "staged_new.txt");
        // Staged modification with extra unstaged edit on top.
        fs::write(root.join("both.txt"), "ONE\ntwo\n").unwrap();
        stage(&root, "both.txt");
        fs::write(root.join("both.txt"), "ONE\nTWO\nthree\n").unwrap();
        // Staged deletion.
        stage_delete(&root, "to_delete.txt");
        // Untracked.
        fs::write(root.join("untracked.txt"), "new\n").unwrap();

        let changes = status(&root);

        let c = find(&changes, "tracked.txt");
        assert_eq!(c.status, "modified");
        assert!(!c.staged);
        // numstat vs HEAD: "line1\nline2\nline3\n" -> "line1\nchanged\n":
        // del 2 (line2, line3), add 1 (changed).
        assert_eq!((c.additions, c.deletions), (1, 2));

        let c = find(&changes, "staged_new.txt");
        assert_eq!(c.status, "added");
        assert!(c.staged);
        assert_eq!((c.additions, c.deletions), (3, 0));

        let c = find(&changes, "both.txt");
        assert_eq!(c.status, "modified");
        // x = 'M' (the index copy differs from HEAD) wins the staged flag
        // even with a further workdir edit on top.
        assert!(c.staged);
        // vs HEAD ("one\ntwo\n") -> workdir ("ONE\nTWO\nthree\n"): +3/-2.
        assert_eq!((c.additions, c.deletions), (3, 2));

        let c = find(&changes, "to_delete.txt");
        assert_eq!(c.status, "deleted");
        assert!(c.staged);
        assert_eq!((c.additions, c.deletions), (0, 1));

        let c = find(&changes, "untracked.txt");
        assert_eq!(c.status, "untracked");
        assert!(!c.staged);
        assert_eq!((c.additions, c.deletions), (0, 0));

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    fn stage_delete(root: &Path, rel: &str) {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new(rel)).unwrap();
        index.write().unwrap();
        fs::remove_file(root.join(rel)).unwrap();
    }

    fn stage_rename(root: &Path, old: &str, new: &str) {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new(old)).unwrap();
        index.add_path(Path::new(new)).unwrap();
        index.write().unwrap();
    }

    #[test]
    fn status_reports_renames_by_new_path_and_binary_as_zero_zero() {
        let root = seeded_repo("rename-binary");
        fs::write(root.join("old_name.txt"), "alpha\nbeta\ngamma\ndelta\n").unwrap();
        let mut f = fs::File::create(root.join("blob.bin")).unwrap();
        use std::io::Write as _;
        f.write_all(b"\x00\x01\x02\x03\x04").unwrap();
        drop(f);
        commit_all(&root, "initial");
        // Staged rename: old path dropped from the index, new path added —
        // with head_to_index rename detection this is a single R entry.
        fs::rename(root.join("old_name.txt"), root.join("new_name.txt")).unwrap();
        stage_rename(&root, "old_name.txt", "new_name.txt");
        // Unstaged binary change — numstat stays 0/0.
        let mut f = fs::OpenOptions::new()
            .write(true)
            .open(root.join("blob.bin"))
            .unwrap();
        f.write_all(b"\xff\xfe\xfd\xfc\xfb\xfa").unwrap();
        drop(f);

        let changes = status(&root);

        let c = find(&changes, "new_name.txt");
        assert_eq!(c.status, "renamed");
        assert!(c.staged);

        let c = find(&changes, "blob.bin");
        assert_eq!(c.status, "modified");
        assert!(!c.staged);
        assert_eq!((c.additions, c.deletions), (0, 0));

        // The old path must not appear as its own entry.
        assert!(!changes.iter().any(|c| c.path == "old_name.txt"));

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn file_diff_staged_and_unstaged_hunks_match_upstream_shape() {
        let root = seeded_repo("diff");
        fs::write(
            root.join("file.txt"),
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
        )
        .unwrap();
        commit_all(&root, "initial");
        // Staged: insert after line 1.
        fs::write(
            root.join("file.txt"),
            "one\nINSERTED\ntwo\nthree\nfour\nfive\nsix\nseven\n",
        )
        .unwrap();
        stage(&root, "file.txt");

        let hunks = file_diff(&root, "file.txt", true, 3);
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].header.starts_with("@@ -1,4 +1,5 @@"));
        let texts: Vec<&str> = hunks[0].lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec![" one", "+INSERTED", " two", " three", " four"]);
        assert_eq!(hunks[0].lines[0].kind, "context");
        assert_eq!(hunks[0].lines[0].old_no, Some(1));
        assert_eq!(hunks[0].lines[0].new_no, Some(1));
        assert_eq!(hunks[0].lines[1].kind, "add");
        assert_eq!(hunks[0].lines[1].old_no, None);
        assert_eq!(hunks[0].lines[1].new_no, Some(2));
        assert_eq!(hunks[0].lines[3].old_no, Some(3));
        assert_eq!(hunks[0].lines[3].new_no, Some(4));

        // Unstaged on top: delete "seven".
        fs::write(
            root.join("file.txt"),
            "one\nINSERTED\ntwo\nthree\nfour\nfive\nsix\n",
        )
        .unwrap();
        let hunks = file_diff(&root, "file.txt", false, 3);
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].header.starts_with("@@ -5,4 +5,3 @@"));
        let texts: Vec<&str> = hunks[0].lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec![" four", " five", " six", "-seven"]);
        let last = hunks[0].lines.last().unwrap();
        assert_eq!(last.kind, "del");
        assert_eq!(last.old_no, Some(8));
        assert_eq!(last.new_no, None);

        // Zero context clamps to 1 (upstream min).
        let hunks = file_diff(&root, "file.txt", false, 0);
        let texts: Vec<&str> = hunks[0].lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec![" six", "-seven"]);
        // Huge context clamps to 200 — no crash, same single hunk.
        let hunks200 = file_diff(&root, "file.txt", false, 200);
        assert_eq!(hunks200.len(), 1);
        // Full-file sentinel (>= 1000) passes through.
        let hunks_full = file_diff(&root, "file.txt", false, 1000);
        assert_eq!(hunks_full.len(), 1);

        // A path escaping the root yields no hunks.
        assert!(file_diff(&root, "../escape.txt", false, 3).is_empty());

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn staged_diff_text_is_unified_patch_and_works_on_unborn_head() {
        // Unborn HEAD: staged files diff against the empty tree.
        let root = seeded_repo("unborn");
        fs::write(root.join("first.txt"), "hello\nworld\n").unwrap();
        stage(&root, "first.txt");
        let text = staged_diff_text(&root);
        assert!(text.contains("--- /dev/null"));
        assert!(text.contains("+++ b/first.txt"));
        assert!(text.contains("+hello"));
        assert!(text.contains("+world"));
        assert!(text.starts_with("diff --git"));

        // Not a repository → empty string.
        let plain = temp_dir("notrepo");
        assert_eq!(staged_diff_text(&plain), "");
        assert!(status(&plain).is_empty());
        assert!(file_diff(&plain, "x.txt", false, 3).is_empty());
        fs::remove_dir_all(&plain).unwrap();

        // After a commit, HEAD→index shows only newly staged work.
        commit_all(&root, "initial");
        fs::write(root.join("second.txt"), "more\n").unwrap();
        stage(&root, "second.txt");
        let text = staged_diff_text(&root);
        assert!(text.contains("+++ b/second.txt"));
        assert!(!text.contains("first.txt"));

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    fn head_oid(root: &Path) -> git2::Oid {
        let repo = Repository::open(root).unwrap();
        repo.head().unwrap().peel_to_commit().unwrap().id()
    }

    fn short(oid: git2::Oid) -> String {
        oid.to_string().chars().take(7).collect()
    }

    fn merge_commit(root: &Path, other_branch: &str, message: &str) {
        let repo = Repository::open(root).unwrap();
        let ours = repo.head().unwrap().peel_to_commit().unwrap();
        let theirs = repo
            .find_branch(other_branch, git2::BranchType::Local)
            .unwrap()
            .get()
            .peel_to_commit()
            .unwrap();
        let mut merged = repo.merge_commits(&ours, &theirs, None).unwrap();
        let tree = repo
            .find_tree(merged.write_tree_to(&repo).unwrap())
            .unwrap();
        let sig = repo.signature().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&ours, &theirs])
            .unwrap();
    }

    /// main: c1 ← c3(merge, HEAD); feature: c1 ← c2.
    /// `vlight` = lightweight tag on c1; `vann` = annotated tag on c2.
    fn history_repo(name: &str) -> (PathBuf, git2::Oid, git2::Oid, git2::Oid) {
        let root = seeded_repo(name);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        commit_all(&root, "initial\n\nThe first commit body.");
        let c1 = head_oid(&root);

        let repo = Repository::open(&root).unwrap();
        repo.tag_lightweight("vlight", repo.find_commit(c1).unwrap().as_object(), false)
            .unwrap();
        let sig = repo.signature().unwrap();
        repo.tag(
            "vann",
            repo.find_commit(c1).unwrap().as_object(),
            &sig,
            "release one\n",
            false,
        )
        .unwrap();
        drop(repo);

        // Side branch with one commit — its sha is the `feature` branch head.
        let repo = Repository::open(&root).unwrap();
        repo.branch("feature", &repo.find_commit(c1).unwrap(), false)
            .unwrap();
        drop(repo);
        set_head(&root, "feature");
        fs::write(root.join("side.txt"), "one\ntwo\nthree\n").unwrap();
        commit_all(&root, "side work");
        let c2 = head_oid(&root);

        // Back on main, merge feature — merge commit parents are
        // [first parent (main's c1), second (feature's c2)].
        set_head(&root, "main");
        merge_commit(&root, "feature", "merge feature");
        let c3 = head_oid(&root);
        (root, c1, c2, c3)
    }

    fn set_head(root: &Path, branch: &str) {
        let repo = Repository::open(root).unwrap();
        repo.set_head(&format!("refs/heads/{branch}")).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }

    #[test]
    fn log_decorates_branch_heads_tags_and_head() {
        let (root, c1, c2, c3) = history_repo("log");

        let commits = log(&root, 100);
        assert_eq!(commits.len(), 3);

        let by_sha: HashMap<String, &PanelCommit> =
            commits.iter().map(|c| (c.sha.clone(), c)).collect();
        // Upstream parity: shas and parents are the 7-char short form.
        assert!(by_sha.contains_key(&short(c1)));
        assert!(by_sha.contains_key(&short(c2)));
        assert!(by_sha.contains_key(&short(c3)));

        let merge = by_sha[&short(c3)];
        assert!(merge.is_head);
        assert_eq!(merge.subject, "merge feature");
        assert_eq!(merge.author, "Ada");
        assert_eq!(merge.parents, vec![short(c1), short(c2)]);

        let side = by_sha[&short(c2)];
        assert!(!side.is_head);
        assert_eq!(side.subject, "side work");
        assert_eq!(side.parents, vec![short(c1)]);
        assert!(side.branch_heads.contains(&"feature".to_string()));
        // Annotated tags key on the tag object's sha — never peeled onto the
        // wrapped commit.
        assert!(!side.tags.contains(&"vann".to_string()));
        assert!(
            !commits.iter().any(|c| c.tags.contains(&"vann".to_string())),
            "annotated tag must not peel onto any row"
        );

        let base = by_sha[&short(c1)];
        assert!(!base.is_head);
        assert!(base.parents.is_empty());
        assert!(base.tags.contains(&"vlight".to_string()));
        assert!(!base.branch_heads.contains(&"main".to_string()));
        // Only the HEAD commit carries is_head.
        assert_eq!(commits.iter().filter(|c| c.is_head).count(), 1);
        // ISO-8601 with offset, like git's %aI.
        assert!(base.date.len() >= 20);
        assert!(base.date.contains('T'));
        assert!(base.date[19..].starts_with('+') || base.date[19..].starts_with('-'));

        // Limit is honored.
        assert_eq!(log(&root, 1).len(), 1);
        // Not a repository → empty.
        let plain = temp_dir("log-notrepo");
        assert!(log(&plain, 10).is_empty());
        fs::remove_dir_all(&plain).unwrap();

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn commit_files_counts_and_commit_diff_and_message() {
        let (root, c1, c2, c3) = history_repo("inspect");

        // Side commit added side.txt (+3/-0).
        let files = commit_files(&root, &short(c2));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "side.txt");
        assert_eq!(files[0].status, "added");
        assert!(files[0].staged);
        assert_eq!((files[0].additions, files[0].deletions), (3, 0));

        // Root commit diffs against the empty tree.
        let files = commit_files(&root, &short(c1));
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].additions, files[0].deletions), (1, 0));

        // Merge vs first parent (c1): only side.txt appears.
        let files = commit_files(&root, &short(c3));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "side.txt");

        // Hunks for the side commit's file.
        let hunks = commit_file_diff(&root, &short(c2), "side.txt");
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].header.starts_with("@@ -0,0 +1,3 @@"));
        let texts: Vec<&str> = hunks[0].lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, vec!["+one", "+two", "+three"]);
        assert!(hunks[0].lines.iter().all(|l| l.kind == "add"));
        // Pathspec-limited: another path yields nothing.
        assert!(commit_file_diff(&root, &short(c2), "base.txt").is_empty());
        // Escaping path yields nothing.
        assert!(commit_file_diff(&root, &short(c2), "../x.txt").is_empty());

        // Full message with body preserved, trimmed.
        assert_eq!(
            commit_message(&root, &short(c1)),
            "initial\n\nThe first commit body."
        );
        assert_eq!(commit_message(&root, &short(c2)), "side work");

        // Error shapes: bad sha / bad repo → empty defaults.
        assert!(commit_files(&root, "deadbee").is_empty());
        assert!(commit_file_diff(&root, "deadbee", "side.txt").is_empty());
        assert_eq!(commit_message(&root, "deadbee"), "");
        let plain = temp_dir("commit-notrepo");
        assert!(commit_files(&plain, &short(c1)).is_empty());
        assert_eq!(commit_message(&plain, &short(c1)), "");
        fs::remove_dir_all(&plain).unwrap();

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    fn worktree_is_clean(root: &Path) -> bool {
        status(root).is_empty()
    }

    fn index_entry(root: &Path, rel: &str) -> Option<String> {
        let repo = Repository::open(root).unwrap();
        let index = repo.index().unwrap();
        index.get_path(Path::new(rel), 0).map(|e| e.id.to_string())
    }

    #[test]
    fn stage_and_unstage_single_file_including_untracked() {
        let root = seeded_repo("stage");
        fs::write(root.join("a.txt"), "one\n").unwrap();
        commit_all(&root, "initial");

        // Untracked file stages.
        fs::write(root.join("new.txt"), "n\n").unwrap();
        let r = stage_file(&root, "new.txt", true);
        assert_eq!(
            r,
            PanelOpResult {
                ok: true,
                error: None
            }
        );
        assert!(find(&status(&root), "new.txt").staged);

        // Tracked modification stages, then unstages back to HEAD.
        fs::write(root.join("a.txt"), "two\n").unwrap();
        assert!(stage_file(&root, "a.txt", true).ok);
        assert!(find(&status(&root), "a.txt").staged);
        assert!(stage_file(&root, "a.txt", false).ok);
        let changes = status(&root);
        assert!(!find(&changes, "a.txt").staged);

        // Unstage an untracked (never-in-HEAD) file: unborn-style reset to
        // HEAD drops it from the index → back to untracked.
        assert!(stage_file(&root, "new.txt", false).ok);
        let changes = status(&root);
        let c = find(&changes, "new.txt");
        assert_eq!(c.status, "untracked");
        assert!(!c.staged);

        // Staging a deletion: file gone from disk → index entry removed.
        fs::remove_file(root.join("a.txt")).unwrap();
        assert!(stage_file(&root, "a.txt", true).ok);
        assert_eq!(find(&status(&root), "a.txt").status, "deleted");

        // Not a repository: bare {ok: false} parity with upstream's
        // no-workspace gitStage.
        let plain = temp_dir("stage-notrepo");
        assert_eq!(
            stage_file(&plain, "x.txt", true),
            PanelOpResult {
                ok: false,
                error: None
            }
        );
        fs::remove_dir_all(&plain).unwrap();

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn unstage_on_unborn_head_removes_from_index() {
        let root = seeded_repo("unstage-unborn");
        fs::write(root.join("first.txt"), "x\n").unwrap();
        stage(&root, "first.txt");
        assert!(stage_file(&root, "first.txt", false).ok);
        // Index is empty again → nothing staged, file back to untracked.
        let repo = Repository::open(&root).unwrap();
        assert!(repo.index().unwrap().is_empty());
        drop(repo);
        assert_eq!(find(&status(&root), "first.txt").status, "untracked");

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn bulk_stage_unstage_restore_all() {
        let root = seeded_repo("bulk");
        fs::write(root.join("keep.txt"), "same\n").unwrap();
        fs::write(root.join("edit.txt"), "old\n").unwrap();
        commit_all(&root, "initial");

        // stage-all: modification + untracked both land in the index.
        fs::write(root.join("edit.txt"), "new\n").unwrap();
        fs::write(root.join("untracked.txt"), "u\n").unwrap();
        fs::write(root.join("staged_only.txt"), "s\n").unwrap();
        stage(&root, "staged_only.txt");
        assert!(bulk(&root, "stage-all", None).ok);
        assert!(find(&status(&root), "edit.txt").staged);
        assert!(find(&status(&root), "untracked.txt").staged);
        assert!(find(&status(&root), "staged_only.txt").staged);

        // unstage-all: index becomes HEAD's tree.
        assert!(bulk(&root, "unstage-all", None).ok);
        let changes = status(&root);
        assert!(!changes.iter().any(|c| c.staged));
        assert!(!find(&changes, "edit.txt").staged);
        assert_eq!(find(&changes, "untracked.txt").status, "untracked");

        // restore-all: hard reset to HEAD + clean untracked → clean tree.
        assert!(bulk(&root, "restore-all", None).ok);
        assert!(worktree_is_clean(&root));
        assert_eq!(fs::read_to_string(root.join("edit.txt")).unwrap(), "old\n");
        assert!(!root.join("untracked.txt").exists());

        // Unknown op surfaces its error.
        let r = bulk(&root, "bogus", None);
        assert!(!r.ok);
        assert_eq!(r.error.as_deref(), Some("unknown op: bogus"));

        // Not a repo: err("no workspace") parity.
        let plain = temp_dir("bulk-notrepo");
        let r = bulk(&plain, "stash", None);
        assert!(!r.ok);
        fs::remove_dir_all(&plain).unwrap();

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn stash_includes_untracked_message_list_and_pop() {
        let root = seeded_repo("stash");
        fs::write(root.join("a.txt"), "one\n").unwrap();
        commit_all(&root, "initial");

        fs::write(root.join("a.txt"), "dirty\n").unwrap();
        fs::write(root.join("fresh.txt"), "untracked\n").unwrap();
        assert!(bulk(&root, "stash", Some("my wip")).ok);

        // INCLUDE_UNTRACKED: fresh.txt went with the stash; tree is clean.
        assert!(worktree_is_clean(&root));
        assert!(!root.join("fresh.txt").exists());

        let list = stash_list(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].stash_ref, "stash@{0}");
        assert!(list[0].message.contains("my wip"), "{:?}", list[0].message);

        // pop restores content (incl. untracked) and drops the stash.
        assert!(bulk(&root, "stash-pop", None).ok);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "dirty\n");
        assert_eq!(
            fs::read_to_string(root.join("fresh.txt")).unwrap(),
            "untracked\n"
        );
        assert!(stash_list(&root).is_empty());

        // Clean the tree again, then: stashing with nothing to stash is ok
        // (git exits 0) and leaves no entry.
        assert!(bulk(&root, "restore-all", None).ok);
        assert!(worktree_is_clean(&root));
        assert!(bulk(&root, "stash", None).ok);
        assert!(stash_list(&root).is_empty());

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn stash_pop_conflict_writes_markers_and_drops_on_git2() {
        // git2 0.21's stash_pop does NOT error on conflicts the way the git
        // CLI does: it applies with conflict markers ("Updated upstream" /
        // "Stashed changes"), returns Ok, and drops the stash. Upstream
        // tide's impl is the same `stash_pop(0, None)` call, so this ports
        // that behavior verbatim — documented rather than "fixed".
        let root = seeded_repo("stash-conflict");
        fs::write(root.join("a.txt"), "base\n").unwrap();
        commit_all(&root, "initial");

        // Stash a change, then move the same line elsewhere on main.
        fs::write(root.join("a.txt"), "stashed\n").unwrap();
        assert!(bulk(&root, "stash", Some("wip")).ok);
        fs::write(root.join("a.txt"), "moved on\n").unwrap();
        commit_all(&root, "conflicting commit");

        let r = bulk(&root, "stash-pop", None);
        assert!(r.ok);
        let merged = fs::read_to_string(root.join("a.txt")).unwrap();
        assert!(merged.contains("<<<<<<< Updated upstream"), "{merged}");
        assert!(merged.contains("moved on"), "{merged}");
        assert!(merged.contains(">>>>>>> Stashed changes"), "{merged}");
        assert!(stash_list(&root).is_empty());

        // The error prefix still exists on the API surface for real git2
        // failures — e.g. popping with no stash at all.
        let r = bulk(&root, "stash-pop", None);
        assert!(!r.ok);
        assert!(
            r.error.as_deref().unwrap().starts_with("stash pop: "),
            "{:?}",
            r.error
        );

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn discard_file_reverts_worktree_keeps_staged_version() {
        let root = seeded_repo("discard");
        fs::write(root.join("a.txt"), "base\n").unwrap();
        commit_all(&root, "initial");

        // Staged edit + further workdir edit on top: discard reverts the
        // workdir to the INDEX copy, staged state untouched.
        fs::write(root.join("a.txt"), "staged\n").unwrap();
        stage(&root, "a.txt");
        let staged_id = index_entry(&root, "a.txt").unwrap();
        fs::write(root.join("a.txt"), "workdir\n").unwrap();
        assert!(discard_file(&root, "a.txt").ok);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "staged\n");
        assert_eq!(
            index_entry(&root, "a.txt").as_deref(),
            Some(staged_id.as_str())
        );

        // Untracked file: rm the path.
        fs::write(root.join("u.txt"), "u\n").unwrap();
        assert!(discard_file(&root, "u.txt").ok);
        assert!(!root.join("u.txt").exists());

        // Escaping path errors.
        let r = discard_file(&root, "../escape.txt");
        assert!(!r.ok);

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn restore_file_from_restores_content_and_index_and_deletes_absent() {
        let root = seeded_repo("restore");
        fs::write(root.join("a.txt"), "old\n").unwrap();
        commit_all(&root, "old state");
        let old_head = head_oid(&root);

        fs::write(root.join("a.txt"), "new\n").unwrap();
        commit_all(&root, "new state");

        // Restore the older content into worktree AND index.
        assert!(restore_file_from(&root, "a.txt", &old_head.to_string()).ok);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "old\n");
        let repo = Repository::open(&root).unwrap();
        {
            let blob = repo
                .find_blob(
                    repo.index()
                        .unwrap()
                        .get_path(Path::new("a.txt"), 0)
                        .unwrap()
                        .id,
                )
                .unwrap();
            assert_eq!(blob.content(), b"old\n");
        }
        drop(repo);

        // A file absent from the target sha is deleted from the workdir
        // (index untouched).
        fs::write(root.join("born_later.txt"), "x\n").unwrap();
        commit_all(&root, "adds file");
        assert!(restore_file_from(&root, "born_later.txt", &old_head.to_string()).ok);
        assert!(!root.join("born_later.txt").exists());

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    // ── commit / amend / revert ─────────────────────────────────────────

    /// TIDE_DATA_DIR is process-global, so attribution tests serialize on it.

    fn with_scratch_tide_dir(config_json: Option<&str>) -> PathBuf {
        let scratch = std::env::temp_dir().join(format!(
            "tide-gitpanel-tide-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir_all(&scratch).unwrap();
        if let Some(json) = config_json {
            fs::write(scratch.join("config.json"), json).unwrap();
        }
        unsafe { std::env::set_var(store::paths::DATA_DIR_ENV, &scratch) };
        scratch
    }

    fn clear_tide_dir(scratch: &Path) {
        unsafe { std::env::remove_var(store::paths::DATA_DIR_ENV) };
        let _ = fs::remove_dir_all(scratch);
    }

    const AUTHOR_CFG: &str = r#"{"generalSettings":{"gitCoAuthored":true,"gitAttributionMode":"author","gitCoAuthorName":"Tide","gitCoAuthorEmail":"314188112+tide-codes@users.noreply.github.com"}}"#;
    const CO_AUTHOR_CFG: &str = r#"{"generalSettings":{"gitCoAuthored":true,"gitAttributionMode":"co-author","gitCoAuthorName":"Tide","gitCoAuthorEmail":"314188112+tide-codes@users.noreply.github.com"}}"#;

    /// (author name/email, committer name/email, full message) of HEAD.
    fn head_facts(root: &Path) -> (String, String, String, String) {
        let repo = Repository::open(root).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        let author = commit.author();
        let committer = commit.committer();
        (
            author.name().unwrap_or("").to_owned(),
            author.email().unwrap_or("").to_owned(),
            committer.name().unwrap_or("").to_owned(),
            commit.message().unwrap_or("").trim().to_owned(),
        )
    }

    #[test]
    fn panel_commit_applies_attribution_in_both_modes_and_off() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let root = seeded_repo("commit-attr");
        fs::write(root.join("a.txt"), "one\n").unwrap();
        commit_all(&root, "initial");

        // Author mode: Tide authors, the repo identity (Ada) trails.
        fs::write(root.join("b.txt"), "two\n").unwrap();
        stage(&root, "b.txt");
        let scratch = with_scratch_tide_dir(Some(AUTHOR_CFG));
        let r = panel_commit(&root, "author mode");
        clear_tide_dir(&scratch);
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.sha.as_deref(), Some(short(head_oid(&root)).as_str()));
        let (an, ae, cn, msg) = head_facts(&root);
        assert_eq!(
            (an.as_str(), ae.as_str()),
            ("Tide", "314188112+tide-codes@users.noreply.github.com")
        );
        assert_eq!(cn, "Ada");
        assert_eq!(msg, "author mode\n\nCo-authored-by: Ada <ada@example.com>");

        // Co-author mode: the repo identity authors, Tide trails.
        fs::write(root.join("c.txt"), "three\n").unwrap();
        stage(&root, "c.txt");
        let scratch = with_scratch_tide_dir(Some(CO_AUTHOR_CFG));
        let r = panel_commit(&root, "co-author mode");
        clear_tide_dir(&scratch);
        assert!(r.ok, "{:?}", r.error);
        let (an, _ae, _cn, msg) = head_facts(&root);
        assert_eq!(an, "Ada");
        assert_eq!(
            msg,
            "co-author mode\n\nCo-authored-by: Tide <314188112+tide-codes@users.noreply.github.com>"
        );

        // Off / config absent: message untouched, repo identity everywhere.
        fs::write(root.join("d.txt"), "four\n").unwrap();
        stage(&root, "d.txt");
        let scratch = with_scratch_tide_dir(None);
        let r = panel_commit(&root, "plain");
        clear_tide_dir(&scratch);
        assert!(r.ok, "{:?}", r.error);
        let (an, _ae, cn, msg) = head_facts(&root);
        assert_eq!(an, "Ada");
        assert_eq!(cn, "Ada");
        assert_eq!(msg, "plain");

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn panel_commit_requires_message_and_commits_index_only() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let root = seeded_repo("commit-index");
        fs::write(root.join("a.txt"), "one\n").unwrap();
        commit_all(&root, "initial");

        // Empty / whitespace message → ok:false, nothing committed.
        let before = head_oid(&root);
        for message in ["", "   \n  "] {
            let r = panel_commit(&root, message);
            assert!(!r.ok);
            assert!(r.sha.is_none());
        }
        assert_eq!(head_oid(&root), before);

        // Worktree-only change does NOT get committed (index-only).
        fs::write(root.join("a.txt"), "workdir edit\n").unwrap();
        let r = panel_commit(&root, "should not commit");
        assert!(!r.ok, "{:?}", r.error);
        assert_eq!(head_oid(&root), before);
        assert!(!status(&root).is_empty());

        // Staged change commits; the later workdir edit stays unstaged.
        stage(&root, "a.txt");
        fs::write(root.join("a.txt"), "staged plus workdir\n").unwrap();
        let r = panel_commit(&root, "staged only");
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.sha.as_deref(), Some(short(head_oid(&root)).as_str()));
        assert!(!find(&status(&root), "a.txt").staged);

        // Clean tree → "nothing to commit".
        let r = panel_commit(&root, "nothing");
        assert!(!r.ok);
        assert!(r.error.as_deref().unwrap().contains("nothing to commit"));

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn amend_keeps_or_replaces_message_and_preserves_original_author() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let root = seeded_repo("amend");
        // HEAD commit authored by someone other than the repo identity, so
        // author preservation is observable.
        fs::write(root.join("a.txt"), "one\n").unwrap();
        {
            let repo = Repository::open(&root).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.txt")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let original = git2::Signature::now("Original Author", "original@example.com").unwrap();
            repo.commit(
                Some("HEAD"),
                &original,
                &repo.signature().unwrap(),
                "original message",
                &tree,
                &[],
            )
            .unwrap();
        }

        // message: None keeps HEAD's original message (attribution off).
        fs::write(root.join("root.txt"), "ignore\n").unwrap();
        stage(&root, "root.txt");
        let r = amend(&root, None);
        assert!(r.ok, "{:?}", r.error);
        let (an, ae, _cn, msg) = head_facts(&root);
        assert_eq!(
            (an.as_str(), ae.as_str()),
            ("Original Author", "original@example.com")
        );
        assert_eq!(msg, "original message");

        // New message replaces; author still preserved, committer is "now"
        // (the repo identity).
        fs::write(root.join("b.txt"), "b\n").unwrap();
        stage(&root, "b.txt");
        let r = amend(&root, Some("rewritten message"));
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.sha.as_deref(), Some(short(head_oid(&root)).as_str()));
        let (an, _ae, cn, msg) = head_facts(&root);
        assert_eq!(an, "Original Author");
        assert_eq!(cn, "Ada");
        assert_eq!(msg, "rewritten message");

        // Author-mode amend of a non-Tide-authored commit does NOT re-trail
        // (original author stays put — standard amend semantics).
        let scratch = with_scratch_tide_dir(Some(AUTHOR_CFG));
        let r = amend(&root, Some("rewritten again"));
        clear_tide_dir(&scratch);
        assert!(r.ok, "{:?}", r.error);
        let (an, _ae, _cn, msg) = head_facts(&root);
        assert_eq!(an, "Original Author");
        assert_eq!(msg, "rewritten again");

        // Co-author-mode amend trails with the committer identity.
        let scratch = with_scratch_tide_dir(Some(CO_AUTHOR_CFG));
        let r = amend(&root, Some("co-author amend"));
        clear_tide_dir(&scratch);
        assert!(r.ok, "{:?}", r.error);
        let (an, _ae, _cn, msg) = head_facts(&root);
        assert_eq!(an, "Original Author");
        assert_eq!(
            msg,
            "co-author amend\n\nCo-authored-by: Tide <314188112+tide-codes@users.noreply.github.com>"
        );

        // Empty/whitespace message acts like None (original stays).
        let r = amend(&root, Some("   "));
        assert!(r.ok, "{:?}", r.error);
        let (_an, _ae, _cn, msg) = head_facts(&root);
        assert_eq!(
            msg,
            "co-author amend\n\nCo-authored-by: Tide <314188112+tide-codes@users.noreply.github.com>"
        );

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn revert_creates_inverse_commit_with_message_and_attribution() {
        let _guard = crate::TIDE_DIR_TEST_LOCK.lock().unwrap();
        let (root, c1, c2, c3) = history_repo("revert");

        // Revert the side-work commit: file content returns to its parent
        // state and the message follows git's revert template.
        let scratch = with_scratch_tide_dir(Some(CO_AUTHOR_CFG));
        let r = revert(&root, &short(c2));
        clear_tide_dir(&scratch);
        assert!(r.ok, "{:?}", r.error);
        assert_eq!(r.new_sha.as_deref(), Some(short(head_oid(&root)).as_str()));
        let (an, _ae, _cn, msg) = head_facts(&root);
        assert_eq!(an, "Ada");
        assert_eq!(
            msg,
            format!(
                "Revert \"side work\"\n\nThis reverts commit {c2}.\n\nCo-authored-by: Tide <314188112+tide-codes@users.noreply.github.com>"
            )
        );
        assert!(
            !root.join("side.txt").exists(),
            "side.txt must be gone again"
        );
        assert!(worktree_is_clean(&root));

        // Merge commits refuse (mainline required) — c3 is the merge.
        let r = revert(&root, &short(c3));
        assert!(!r.ok);
        assert_eq!(
            r.error.as_deref(),
            Some(format!("revert {} is a merge commit, mainline required", short(c3)).as_str())
        );

        // Unknown revision errors cleanly.
        let r = revert(&root, "deadbee");
        assert!(!r.ok);
        assert!(
            r.error
                .as_deref()
                .unwrap()
                .starts_with("unknown revision deadbee")
        );

        let _ = c1;
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    // ── branch info / merge / conflicts / remote ops (Task 7) ────────────

    /// The CLI's "checkout: moving from A to B" reflog line — libgit2 does
    /// not write it, so the port maintains it itself (upstream's
    /// `log_checkout`). Used to seed reflogs in recent-branches tests.
    fn checkout_branch(root: &Path, branch: &str) {
        let repo = Repository::open(root).unwrap();
        let from = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().ok().map(String::from));
        let refname = format!("refs/heads/{branch}");
        let reference = repo.find_reference(&refname).unwrap();
        let tree = reference.peel_to_commit().unwrap().tree().unwrap();
        repo.checkout_tree(tree.as_object(), None).unwrap();
        repo.set_head(&refname).unwrap();
        if let (Some(from), Ok(mut reflog)) = (from.as_deref(), repo.reflog("HEAD")) {
            let id = repo.head().unwrap().target().unwrap();
            if let Ok(sig) = repo.signature() {
                let _ = reflog.append(
                    id,
                    &sig,
                    Some(&format!("checkout: moving from {from} to {branch}")),
                );
            }
        }
    }

    fn create_branch_at_head(root: &Path, name: &str) {
        let repo = Repository::open(root).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch(name, &head, false).unwrap();
    }

    fn commit_change(root: &Path, edits: &[(&str, &str)], removes: &[&str], message: &str) {
        for (rel, content) in edits {
            fs::write(root.join(rel), content).unwrap();
        }
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        for (rel, _) in edits {
            index.add_path(Path::new(rel)).unwrap();
        }
        for path in removes {
            index.remove_path(Path::new(path)).unwrap();
            fs::remove_file(root.join(path)).unwrap();
        }
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let sig = repo.signature().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
            .unwrap();
    }

    #[test]
    fn branch_info_ahead_behind_and_head_sha_across_repo_states() {
        let root = seeded_repo("branch-info");
        fs::write(root.join("a.txt"), "one\n").unwrap();
        commit_all(&root, "initial");

        // Normal repo: live branch + short HEAD; no upstream yet.
        let info = branch_info(&root);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(
            info.head_commit.as_deref(),
            Some(short(head_oid(&root)).as_str())
        );
        assert_eq!(ahead_behind(&root), None);
        assert_eq!(
            head_sha(&root).as_deref(),
            Some(head_oid(&root).to_string().as_str())
        );

        // A second commit so the upstream can sit one behind.
        fs::write(root.join("a.txt"), "two\n").unwrap();
        commit_all(&root, "second");

        // Configure a remote-tracking upstream one behind.
        let repo = Repository::open(&root).unwrap();
        let tip = head_oid(&root);
        let parent = repo.find_commit(tip).unwrap().parent(0).unwrap().id();
        repo.reference("refs/remotes/origin/main", parent, false, "fetch")
            .unwrap();
        repo.remote("origin", "/tmp/nowhere.git").unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("branch.main.remote", "origin").unwrap();
        cfg.set_str("branch.main.merge", "refs/heads/main").unwrap();
        drop(repo);
        assert_eq!(
            ahead_behind(&root),
            Some(PanelAheadBehind {
                ahead: 1,
                behind: 0
            })
        );

        // Detached: branch reads "HEAD" (rev-parse --abbrev-ref parity).
        let repo = Repository::open(&root).unwrap();
        let head_id = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(head_id).unwrap();
        drop(repo);
        assert_eq!(branch_info(&root).branch.as_deref(), Some("HEAD"));
        assert_eq!(
            head_sha(&root).as_deref(),
            Some(head_id.to_string().as_str())
        );

        // Unborn: null/null; head_sha None.
        let fresh = temp_dir("branch-info-unborn");
        let _ = Repository::init(&fresh).unwrap();
        assert_eq!(
            branch_info(&fresh),
            PanelBranchInfo {
                branch: None,
                head_commit: None
            }
        );
        assert_eq!(head_sha(&fresh), None);
        assert_eq!(recent_branches(&fresh), Vec::<String>::new());
        fs::remove_dir_all(&fresh).unwrap();

        // Not a repo: defaults.
        let plain = temp_dir("branch-info-notrepo");
        assert_eq!(branch_info(&plain).branch, None);
        assert_eq!(ahead_behind(&plain), None);
        fs::remove_dir_all(&plain).unwrap();

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn merge_fast_forward_true_merge_and_conflict() {
        let root = seeded_repo("merge");
        fs::write(root.join("a.txt"), "base\n").unwrap();
        commit_all(&root, "initial");

        // Fast-forward: main stays at the base; feature advances.
        create_branch_at_head(&root, "feature");
        set_head(&root, "feature");
        fs::write(root.join("f.txt"), "feature\n").unwrap();
        commit_all(&root, "feature work");
        let feature_tip = head_oid(&root);
        set_head(&root, "main");
        let r = merge(&root, "feature");
        assert!(r.ok, "{:?}", r.error);
        assert!(r.conflicts.is_empty());
        assert_eq!(head_oid(&root), feature_tip, "main fast-forwarded");

        // True merge: both sides advance disjointly.
        fs::write(root.join("m.txt"), "main side\n").unwrap();
        commit_all(&root, "main work");
        set_head(&root, "feature");
        fs::write(root.join("f.txt"), "feature\nmore\n").unwrap();
        commit_all(&root, "more feature");
        set_head(&root, "main");
        let r = merge(&root, "feature");
        assert!(r.ok, "{:?}", r.error);
        let merged = Repository::open(&root).unwrap();
        {
            let head = merged.head().unwrap().peel_to_commit().unwrap();
            assert_eq!(head.parent_count(), 2);
            assert!(
                head.message()
                    .unwrap()
                    .starts_with("Merge branch 'feature'")
            );
        }
        assert!(root.join("m.txt").exists() && root.join("f.txt").exists());
        assert_eq!(merged.state(), git2::RepositoryState::Clean);
        drop(merged);

        // Up-to-date merge: ok, no new commit.
        let before = head_oid(&root);
        let r = merge(&root, "feature");
        assert!(r.ok);
        assert_eq!(head_oid(&root), before);

        // Conflict: same line changed on both sides.
        create_branch_at_head(&root, "conflicter");
        set_head(&root, "conflicter");
        fs::write(root.join("m.txt"), "their conflict\n").unwrap();
        commit_all(&root, "their edit");
        set_head(&root, "main");
        fs::write(root.join("m.txt"), "our conflict\n").unwrap();
        commit_all(&root, "our edit");
        let r = merge(&root, "conflicter");
        assert!(!r.ok);
        assert!(r.error.is_none());
        assert_eq!(r.conflicts, vec!["m.txt".to_owned()]);
        let repo = Repository::open(&root).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Merge);
        let conflicts = conflict_files(&root);
        assert_eq!(
            conflicts,
            vec![PanelConflict {
                path: "m.txt".into(),
                state: "both-modified".into()
            }]
        );

        // Resolving ours stages our content; the conflict list clears.
        assert!(resolve_file(&root, "m.txt", "ours").ok);
        assert!(conflict_files(&root).is_empty());
        assert_eq!(
            fs::read_to_string(root.join("m.txt")).unwrap(),
            "our conflict\n"
        );

        // An unknown branch errors.
        let r = merge(&root, "nosuch");
        assert!(!r.ok);
        assert!(r.error.as_deref().unwrap().contains("merge: nosuch"));

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn conflict_states_and_resolve_ours_theirs_including_deletes() {
        let root = seeded_repo("conflicts");
        // Base: three files; ours modifies f, deletes d1, modifies d2;
        // theirs modifies f, modifies d1, deletes d2. Plus a file ADDED on
        // both sides with different content (both-added).
        fs::write(root.join("f.txt"), "base\n").unwrap();
        fs::write(root.join("d1.txt"), "d1\n").unwrap();
        fs::write(root.join("d2.txt"), "d2\n").unwrap();
        commit_all(&root, "base files");
        create_branch_at_head(&root, "theirs");
        set_head(&root, "theirs");
        fs::write(root.join("new.txt"), "their new\n").unwrap();
        commit_change(
            &root,
            &[
                ("f.txt", "theirs\n"),
                ("d1.txt", "d1 theirs\n"),
                ("new.txt", "their new\n"),
            ],
            &["d2.txt"],
            "theirs edits",
        );
        set_head(&root, "main");
        fs::write(root.join("new.txt"), "our new\n").unwrap();
        commit_change(
            &root,
            &[
                ("f.txt", "ours\n"),
                ("d2.txt", "d2 ours\n"),
                ("new.txt", "our new\n"),
            ],
            &["d1.txt"],
            "ours edits",
        );

        let r = merge(&root, "theirs");
        assert!(!r.ok);
        let mut conflicts = conflict_files(&root);
        conflicts.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            conflicts,
            vec![
                PanelConflict {
                    path: "d1.txt".into(),
                    state: "deleted-by-us".into()
                },
                PanelConflict {
                    path: "d2.txt".into(),
                    state: "deleted-by-them".into()
                },
                PanelConflict {
                    path: "f.txt".into(),
                    state: "both-modified".into()
                },
                PanelConflict {
                    path: "new.txt".into(),
                    state: "both-added".into()
                },
            ]
        );
        // The merge result's conflict list is the same paths, names only.
        let mut paths = r.conflicts.clone();
        paths.sort();
        assert_eq!(paths, vec!["d1.txt", "d2.txt", "f.txt", "new.txt"]);

        // resolve theirs on both-modified → their blob in workdir + index.
        assert!(resolve_file(&root, "f.txt", "theirs").ok);
        assert_eq!(fs::read_to_string(root.join("f.txt")).unwrap(), "theirs\n");

        // resolve theirs where THEY deleted → deletion recorded, file gone.
        assert!(resolve_file(&root, "d2.txt", "theirs").ok);
        assert!(!root.join("d2.txt").exists());
        let repo = Repository::open(&root).unwrap();
        assert!(
            repo.index()
                .unwrap()
                .get_path(Path::new("d2.txt"), 0)
                .is_none()
        );
        drop(repo);

        // resolve ours on both-added keeps our content.
        assert!(resolve_file(&root, "new.txt", "ours").ok);
        assert_eq!(
            fs::read_to_string(root.join("new.txt")).unwrap(),
            "our new\n"
        );

        // resolve theirs where WE deleted but they modified → restored.
        assert!(resolve_file(&root, "d1.txt", "theirs").ok);
        assert_eq!(
            fs::read_to_string(root.join("d1.txt")).unwrap(),
            "d1 theirs\n"
        );
        assert!(conflict_files(&root).is_empty(), "all resolved");

        // A path that is not unmerged → {ok: false}.
        let r = resolve_file(&root, "f.txt", "ours");
        assert!(!r.ok);

        // Path escape refused.
        let r = resolve_file(&root, "../outside.txt", "ours");
        assert!(!r.ok);

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn recent_branches_from_reflog_and_fallback() {
        let root = seeded_repo("recent");
        fs::write(root.join("a.txt"), "one\n").unwrap();
        commit_all(&root, "initial");

        // Reflog trail: feature/x → main → topic → feature/x.
        create_branch_at_head(&root, "feature/x");
        checkout_branch(&root, "feature/x");
        fs::write(root.join("f.txt"), "f\n").unwrap();
        commit_all(&root, "on feature");
        create_branch_at_head(&root, "topic");
        checkout_branch(&root, "main");
        checkout_branch(&root, "topic");
        checkout_branch(&root, "feature/x");
        checkout_branch(&root, "topic");

        let recent = recent_branches(&root);
        assert_eq!(
            recent.first().map(String::as_str),
            Some("feature/x"),
            "{recent:?}"
        );
        assert!(recent.contains(&"main".to_owned()));
        assert!(!recent.contains(&"topic".to_owned()), "current excluded");

        // No reflog at all → local branches by latest commit date.
        fs::remove_file(root.join(".git/logs/HEAD")).unwrap();
        let recent = recent_branches(&root);
        assert!(!recent.contains(&"topic".to_owned()));
        assert!(recent.contains(&"feature/x".to_owned()));
        assert!(recent.contains(&"main".to_owned()));

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn fetch_and_pull_against_a_local_bare_remote() {
        // Hermetic: a bare "origin" on the local filesystem — the file
        // transport needs no credentials, so fetch/pull run their real path
        // without network. The credential-helper plumbing (ssh-agent env
        // passthrough + `git credential fill`) is NOT unit-tested: it only
        // runs against authenticated remotes and would need real secrets.
        let origin_dir =
            std::env::temp_dir().join(format!("tide-gitpanel-net-origin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&origin_dir);
        let _ = Repository::init_bare(&origin_dir).unwrap();

        let root = seeded_repo("net");
        fs::write(root.join("a.txt"), "one\n").unwrap();
        commit_all(&root, "initial");
        {
            let repo = Repository::open(&root).unwrap();
            repo.remote("origin", &origin_dir.to_string_lossy())
                .unwrap();
        }
        // Seed the bare remote by pushing main directly (libgit2, local
        // transport — push itself is Task 8's wiring, not under test here).
        {
            let repo = Repository::open(&root).unwrap();
            let mut remote = repo.find_remote("origin").unwrap();
            remote
                .push(&["refs/heads/main:refs/heads/main"], None)
                .unwrap();
        }
        fs::write(root.join("a.txt"), "two\n").unwrap();
        commit_all(&root, "second");
        let tip = head_oid(&root);
        // Push the advanced tip too, so origin/main is a real fast-forward
        // target for the pull below.
        {
            let repo = Repository::open(&root).unwrap();
            let mut remote = repo.find_remote("origin").unwrap();
            remote
                .push(&["refs/heads/main:refs/heads/main"], None)
                .unwrap();
        }

        // fetch: the remote-tracking ref appears.
        assert!(fetch(&root).ok, "local fetch");
        let repo = Repository::open(&root).unwrap();
        assert!(repo.find_reference("refs/remotes/origin/main").is_ok());
        // ...but ahead_behind still has no upstream configured.
        drop(repo);
        assert_eq!(ahead_behind(&root), None);

        // Wire the upstream, rewind main one commit, pull --ff-only.
        {
            let repo = Repository::open(&root).unwrap();
            let mut branch = repo.find_branch("main", git2::BranchType::Local).unwrap();
            branch.set_upstream(Some("origin/main")).unwrap();
        }
        let first = {
            let repo = Repository::open(&root).unwrap();
            repo.head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent(0)
                .unwrap()
                .id()
        };
        {
            let repo = Repository::open(&root).unwrap();
            repo.reference("refs/heads/main", first, true, "back")
                .unwrap();
            let tree = repo.find_commit(first).unwrap().tree().unwrap();
            let mut opts = git2::build::CheckoutBuilder::new();
            opts.force();
            repo.checkout_tree(tree.as_object(), Some(&mut opts))
                .unwrap();
        }
        assert!(pull(&root).ok);
        assert_eq!(head_oid(&root), tip, "pull fast-forwarded back to the tip");
        assert_eq!(
            ahead_behind(&root),
            Some(PanelAheadBehind {
                ahead: 0,
                behind: 0
            })
        );

        // No-remote fetch surfaces the error string.
        let orphan = seeded_repo("net-orphan");
        let r = fetch(&orphan);
        assert!(!r.ok);
        assert!(
            r.error.as_deref().unwrap().contains("origin"),
            "{:?}",
            r.error
        );
        // pull without a remote fails the same way (fetch step first).
        let r = pull(&orphan);
        assert!(!r.ok);

        fs::remove_dir_all(root.parent().unwrap()).unwrap();
        fs::remove_dir_all(&origin_dir).unwrap();
        fs::remove_dir_all(orphan.parent().unwrap()).unwrap();
    }

    #[test]
    fn diff_line_wire_shape_omits_absent_line_numbers() {
        // The byte-shape contract: old_no/new_no serialize only when present.
        let l = line("add", None, Some(2), "+x");
        let json = serde_json::to_value(&l).unwrap();
        assert!(json.get("oldNo").is_none());
        assert_eq!(json["newNo"], 2);
        assert_eq!(json["kind"], "add");
        assert_eq!(json["text"], "+x");
    }
}
