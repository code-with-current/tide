//! git — port of `app/core/agent/tools/git.ts` (91ec558), re-implemented
//! natively on git2 instead of spawning the git CLI. The TS tool passed an
//! arbitrary argv to `git`; this port keeps the same `args: string[]`
//! interface (fixture-locked) but executes the subcommands git2 can do
//! exactly — status, diff, log, show, branch, add, commit, restore/reset
//! (unstage) — and fails with a clear message for everything else (push,
//! rebase, interactive commands, …) instead of shelling out. No hooks run:
//! libgit2 never executes prepare-commit-msg / pre-commit (the TS CLI path
//! did), so agent commits no longer carry the co-author hook — an accepted
//! deviation that keeps the tool side-effect-free beyond git state.
//!
//! Permission tiers are per-subcommand: reads (status/diff/log/show/branch)
//! are read_only, index/commit mutations are write, anything else falls
//! back to the tool's destructive default — see
//! [`crate::permission::risk_tier_for_call`].

use std::path::{Path, PathBuf};
use std::time::Instant;

use git2::{BranchType, DiffFormat, DiffOptions, IndexEntry, Repository, Sort, Status, StatusOptions};
use serde_json::json;

use crate::path_safety::resolve_inside_workspace;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

pub(crate) const MAX_OUTPUT: usize = 50 * 1024;

const DESCRIPTION: &str = "Run any git subcommand in the workspace. Pass args as an array of strings.\nGit safety protocol:\n- Never amend after a failed pre-commit hook \u{2014} the commit did not happen, so amend would modify the PREVIOUS commit. Fix the issue, re-stage, create a NEW commit.\n- Stage specific files by name; never `git add -A` / `git add .` (risks secrets and large binaries).\n- Never skip hooks (`--no-verify`), never force-push (especially main/master), never update git config, unless the user explicitly asks.\n- Never use `-i` flags (interactive) \u{2014} they hang.\n- Never push unless the user explicitly asks. Do not commit files that look like secrets (.env, credentials) \u{2014} warn instead.";

/// Subcommands implemented natively on git2; anything else fails without
/// executing. Read ops are read_only tier, index/HEAD mutations write.
pub(crate) fn subcommand_tier(sub: &str) -> RiskTier {
    match sub {
        "status" | "diff" | "log" | "show" | "branch" => RiskTier::ReadOnly,
        "add" | "commit" | "restore" | "reset" => RiskTier::Write,
        _ => RiskTier::Destructive,
    }
}

const SUPPORTED: &str = "status, diff [--cached] [--stat] [--name-only] [paths], log [-n N] [--oneline] [ref] [-- paths], show <commit>, branch [-a], add <paths>, commit -m <msg>, restore --staged <paths> (aka reset -- <paths>)";

pub struct GitTool;

/// Char-boundary-safe clip with the TS git_repo truncation marker.
pub(crate) fn clip_output(text: &str, max: usize, label: &str) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n[truncated at {max} chars — {label}]", &text[..cut])
}

pub(crate) fn run_git(argv: &[String], workspace_root: &Path) -> ToolOutcome {
    let start = Instant::now();
    if argv.is_empty() {
        return ToolOutcome::failed("Missing required arg: args");
    }
    let repo = match Repository::discover(workspace_root) {
        Ok(r) => r,
        Err(e) => return ToolOutcome::failed(format!("fatal: not a git repository (discovered from {}): {e}", workspace_root.display())),
    };

    let result = match argv[0].as_str() {
        "status" => cmd_status(&repo, &argv[1..]),
        "diff" => cmd_diff(&repo, &argv[1..], workspace_root),
        "log" => cmd_log(&repo, &argv[1..], workspace_root),
        "show" => cmd_show(&repo, &argv[1..]),
        "branch" => cmd_branch(&repo, &argv[1..]),
        "add" => cmd_add(&repo, &argv[1..], workspace_root),
        "commit" => cmd_commit(&repo, &argv[1..]),
        "restore" | "reset" => cmd_unstage(&repo, argv[0].as_str(), &argv[1..], workspace_root),
        other => ToolOutcome::failed(format!(
            "git2-native tool does not implement `{other}`. Supported: {SUPPORTED}. Use the bash tool for anything else (same approval gate)."
        )),
    };
    let ms = start.elapsed().as_millis() as u64;
    ToolOutcome {
        output: clip_output(&result.output, MAX_OUTPUT, "output"),
        meta: Some(format!("native · {ms}ms")),
        duration_ms: Some(ms),
        ..result
    }
}

// ─── shared git2 helpers (also used by git_repo) ───────────────────────

pub(crate) fn short_oid(oid: git2::Oid) -> String {
    oid.to_string()[..7].to_string()
}

/// Strict ISO-8601 like git's `%aI`, from a unix timestamp + the signature's
/// UTC offset in minutes (e.g. `2026-08-27T09:41:00+02:00`).
pub(crate) fn iso_time(secs: i64, offset_minutes: i32) -> String {
    let local = secs + i64::from(offset_minutes) * 60;
    let days = local.div_euclid(86_400);
    let rem = local.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let om = offset_minutes.unsigned_abs();
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}{sign}{:02}:{:02}", om / 60, om % 60)
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

/// UTC `YYYY-MM-DD` (git blame's condensed author date, TS toISOString slice).
pub(crate) fn iso_date(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// `%h %aI %an` — the header line both git log styles share with git_repo.
pub(crate) fn log_line(commit: &git2::Commit<'_>) -> String {
    let a = commit.author();
    format!(
        "{} {} {}",
        short_oid(commit.id()),
        iso_time(a.when().seconds(), a.when().offset_minutes()),
        a.name().unwrap_or("?")
    )
}

/// Render a diff as a unified patch (no rename detection — the TS tool ran
/// `git diff --no-ext-diff --no-rename`).
pub(crate) fn diff_patch(diff: &git2::Diff<'_>, max: usize) -> String {
    let mut out = String::new();
    let mut cb = |_d: git2::DiffDelta, _h: Option<git2::DiffHunk<'_>>, line: git2::DiffLine<'_>| -> bool {
        if out.len() < max {
            match line.origin() {
                '+' | '-' | ' ' => out.push(line.origin()),
                // 'H' hunk headers / 'F' file headers carry the full text.
                _ => {}
            }
            out.push_str(&String::from_utf8_lossy(line.content()));
        }
        true
    };
    let _ = diff.print(DiffFormat::Patch, &mut cb);
    clip_output(&out, max, "diff")
}

/// Pathspec-filtered history for `log [-- paths]`: commits whose tree diff
/// against the first parent touches any of `paths` (root commits match when
/// the path exists in their tree) — the same simplification CLI `git log --
/// path` applies without --follow.
pub(crate) fn commits_touching_paths<'r>(
    repo: &'r Repository,
    start: git2::Oid,
    paths: &[String],
    limit: usize,
) -> Result<Vec<git2::Commit<'r>>, git2::Error> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TIME)?;
    walk.push(start)?;
    let mut out = Vec::new();
    for oid in walk.take(limit) {
        let commit = repo.find_commit(oid?)?;
        let mut touched = false;
        if commit.parent_count() == 0 {
            if let Ok(tree) = commit.tree() {
                touched = paths.iter().any(|p| tree.get_path(Path::new(p)).is_ok());
            }
        } else {
            for i in 0..commit.parent_count() {
                let parent_tree = commit.parent(i).ok().and_then(|p| p.tree().ok());
                let this_tree = commit.tree().ok();
                let mut opts = DiffOptions::new();
                for p in paths {
                    opts.pathspec(p);
                }
                if let Ok(d) = repo.diff_tree_to_tree(parent_tree.as_ref(), this_tree.as_ref(), Some(&mut opts)) {
                    if d.deltas().len() > 0 {
                        touched = true;
                        break;
                    }
                }
            }
        }
        if touched {
            out.push(commit);
        }
    }
    Ok(out)
}

/// Resolve a model-supplied path against the workspace sandbox and convert
/// it to a workdir-relative path for git2 index/pathspec calls.
fn rel_path(repo: &Repository, workspace_root: &Path, p: &str) -> Result<String, String> {
    let Some(workdir) = repo.workdir() else {
        return Err("bare repository — workspace operations need a work tree".to_string());
    };
    let abs = resolve_inside_workspace(workspace_root, p)
        .map_err(|e| format!("Workspace error: {}", e.message))?;
    relative_within(&abs, workdir)
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .ok_or_else(|| format!("Path \"{p}\" resolves outside the repository work tree"))
}

/// `abs` relative to `root`, tolerating symlinked prefixes (macOS tempdirs:
/// `/var` → `/private/var`) by comparing canonical forms; the lexical
/// prefix is preferred so non-existent targets (pathspecs for deleted
/// files) still resolve.
fn relative_within(abs: &Path, root: &Path) -> Option<PathBuf> {
    if let Ok(rel) = abs.strip_prefix(root) {
        return Some(rel.to_path_buf());
    }
    let root_c = std::fs::canonicalize(root).ok()?;
    let mut existing = abs.to_path_buf();
    let mut tail = Vec::new();
    while !existing.exists() {
        let name = existing.file_name()?.to_os_string();
        tail.push(name);
        existing = existing.parent()?.to_path_buf();
    }
    let mut abs_c = std::fs::canonicalize(&existing).ok()?;
    for t in tail.iter().rev() {
        abs_c.push(t);
    }
    abs_c.strip_prefix(&root_c).ok().map(|r| r.to_path_buf())
}

// ─── status ────────────────────────────────────────────────────────────

fn index_code(s: Status) -> char {
    if s.is_conflicted() { 'U' }
    else if s.is_index_new() { 'A' }
    else if s.is_index_modified() { 'M' }
    else if s.is_index_deleted() { 'D' }
    else if s.is_index_renamed() { 'R' }
    else if s.is_index_typechange() { 'T' }
    else { ' ' }
}

fn workdir_code(s: Status) -> char {
    if s.is_conflicted() { 'U' }
    else if s.is_wt_modified() { 'M' }
    else if s.is_wt_deleted() { 'D' }
    else if s.is_wt_renamed() { 'R' }
    else if s.is_wt_typechange() { 'T' }
    else { ' ' }
}

fn cmd_status(repo: &Repository, flags: &[String]) -> ToolOutcome {
    let short = flags.iter().any(|f| f == "--short" || f == "--porcelain");
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).renames_head_to_index(true);
    let statuses = match repo.statuses(Some(&mut opts)) {
        Ok(s) => s,
        Err(e) => return ToolOutcome::failed(format!("git status failed: {e}")),
    };

    if short {
        let mut out = String::new();
        for entry in statuses.iter() {
            let s = entry.status();
            let path = String::from_utf8_lossy(entry.path_bytes()).into_owned();
            let line = if s.is_wt_new() && !s.is_index_new() && index_code(s) == ' ' {
                format!("?? {path}")
            } else if s.is_ignored() {
                format!("!! {path}")
            } else if s.is_index_renamed() {
                let old = entry.head_to_index()
                    .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().into_owned()))
                    .unwrap_or(path.clone());
                format!("R  {old} -> {path}")
            } else {
                format!("{}{} {path}", index_code(s), workdir_code(s))
            };
            out.push_str(&line);
            out.push('\n');
        }
        return ToolOutcome::executed(out);
    }

    // Long format (condensed CLI shape).
    let head = repo.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand().ok().map(String::from));
    let mut staged: Vec<String> = Vec::new();
    let mut unstaged: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    for entry in statuses.iter() {
        let s = entry.status();
        let path = String::from_utf8_lossy(entry.path_bytes()).into_owned();
        if s.is_conflicted() {
            staged.push(format!("unmerged:   {path}"));
            continue;
        }
        if s.is_wt_new() && !s.is_index_new() && index_code(s) == ' ' {
            if !s.is_ignored() {
                untracked.push(path);
            }
            continue;
        }
        match index_code(s) {
            'A' => staged.push(format!("new file:   {path}")),
            'M' => staged.push(format!("modified:   {path}")),
            'D' => staged.push(format!("deleted:    {path}")),
            'R' => {
                let old = entry.head_to_index()
                    .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().into_owned()))
                    .unwrap_or(path.clone());
                staged.push(format!("renamed:    {old} -> {path}"));
            }
            'T' => staged.push(format!("typechange: {path}")),
            _ => {}
        }
        match workdir_code(s) {
            'M' => unstaged.push(format!("modified:   {path}")),
            'D' => unstaged.push(format!("deleted:    {path}")),
            'T' => unstaged.push(format!("typechange: {path}")),
            _ => {}
        }
    }
    let mut out = String::new();
    out.push_str(&format!("On branch {}\n", branch.as_deref().unwrap_or("(unborn)")));
    if staged.is_empty() && unstaged.is_empty() && untracked.is_empty() {
        out.push_str("nothing to commit, working tree clean\n");
        return ToolOutcome::executed(out);
    }
    if !staged.is_empty() {
        out.push_str("\nChanges to be committed:\n");
        for l in &staged { out.push_str(&format!("  {l}\n")); }
    }
    if !unstaged.is_empty() {
        out.push_str("\nChanges not staged for commit:\n");
        for l in &unstaged { out.push_str(&format!("  {l}\n")); }
    }
    if !untracked.is_empty() {
        out.push_str("\nUntracked files:\n");
        for l in &untracked { out.push_str(&format!("  {l}\n")); }
    }
    ToolOutcome::executed(out)
}

// ─── diff ──────────────────────────────────────────────────────────────

fn cmd_diff(repo: &Repository, args: &[String], ws: &Path) -> ToolOutcome {
    let mut cached = false;
    let mut stat = false;
    let mut name_only = false;
    let mut paths: Vec<String> = Vec::new();
    for a in args {
        match a.as_str() {
            "--cached" | "--staged" => cached = true,
            "--stat" => stat = true,
            "--name-only" => name_only = true,
            "--no-color" | "--no-ext-diff" | "--no-rename" | "--textconv" | "-M" => {}
            f if f.starts_with('-') => {
                return ToolOutcome::failed(format!("diff: unsupported flag {f} (supported: --cached/--staged, --stat, --name-only, paths)"))
            }
            p => match rel_path(repo, ws, p) {
                Ok(rel) => paths.push(rel),
                Err(e) => return ToolOutcome::failed(e),
            },
        }
    }

    let mut opts = DiffOptions::new();
    for p in &paths {
        opts.pathspec(p);
    }
    let diff = if cached {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        let index = match repo.index() {
            Ok(i) => i,
            Err(e) => return ToolOutcome::failed(format!("diff: {e}")),
        };
        repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))
    };
    let diff = match diff {
        Ok(d) => d,
        Err(e) => return ToolOutcome::failed(format!("git diff failed: {e}")),
    };

    if name_only {
        let mut out = String::new();
        for delta in diff.deltas() {
            let f = delta.new_file();
            let p = f.path().or_else(|| delta.old_file().path());
            if let Some(p) = p {
                out.push_str(&p.to_string_lossy());
                out.push('\n');
            }
        }
        return ToolOutcome::executed(out);
    }
    if stat {
        let stats = match diff.stats() {
            Ok(s) => s,
            Err(e) => return ToolOutcome::failed(format!("diff --stat: {e}")),
        };
        let buf = stats.to_buf(git2::DiffStatsFormat::FULL | git2::DiffStatsFormat::INCLUDE_SUMMARY, 80)
            .map(|b| String::from_utf8_lossy(b.as_ref()).into_owned())
            .unwrap_or_default();
        return ToolOutcome::executed(buf);
    }
    ToolOutcome::executed(diff_patch(&diff, MAX_OUTPUT))
}

// ─── log / show ────────────────────────────────────────────────────────

fn cmd_log(repo: &Repository, args: &[String], ws: &Path) -> ToolOutcome {
    let mut limit = 50usize;
    let mut oneline = false;
    let mut refname: Option<String> = None;
    let mut paths: Vec<String> = Vec::new();
    let mut after_dashdash = false;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if after_dashdash {
            match push_path(repo, ws, a) {
                Ok(rel) => paths.push(rel),
                Err(e) => return ToolOutcome::failed(e),
            }
        } else if a == "--" {
            after_dashdash = true;
        } else if a == "--oneline" {
            oneline = true;
        } else if a == "-n" {
            i += 1;
            if let Some(n) = args.get(i).and_then(|v| v.parse().ok()) {
                limit = n;
            } else {
                return ToolOutcome::failed("log: -n requires a number");
            }
        } else if let Some(n) = a.strip_prefix('-').and_then(|s| s.parse::<usize>().ok()) {
            limit = n;
        } else if let Some(n) = a.strip_prefix("-n").and_then(|s| s.parse::<usize>().ok()) {
            limit = n;
        } else if a.starts_with('-') {
            return ToolOutcome::failed(format!("log: unsupported flag {a} (supported: -n N, --oneline, ref, -- paths)"));
        } else if refname.is_none() {
            refname = Some(a.clone());
        } else {
            match push_path(repo, ws, a) {
                Ok(rel) => paths.push(rel),
                Err(e) => return ToolOutcome::failed(e),
            }
        }
        i += 1;
    }

    let target = match refname.as_deref().unwrap_or("HEAD") {
        "HEAD" => repo
            .head()
            .ok()
            .and_then(|h| h.resolve().ok())
            .and_then(|r| r.target())
            .ok_or_else(|| "HEAD is unborn".to_string()),
        r => repo
            .revparse_single(r)
            .and_then(|o| o.peel_to_commit().map(|c| c.id()))
            .map_err(|e| e.to_string()),
    };
    let start = match target {
        Ok(oid) => oid,
        Err(e) => return ToolOutcome::failed(format!("log: unknown revision ({e})")),
    };

    let commits_result = if paths.is_empty() {
        (|| -> Result<Vec<git2::Commit<'_>>, String> {
            let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
            walk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;
            walk.push(start).map_err(|e| e.to_string())?;
            walk.take(limit)
                .map(|o| o.map_err(|e| e.to_string()).and_then(|oid| repo.find_commit(oid).map_err(|e| e.to_string())))
                .collect()
        })()
    } else {
        commits_touching_paths(repo, start, &paths, limit).map_err(|e| e.to_string())
    };
    let commits = match commits_result {
        Ok(c) => c,
        Err(e) => return ToolOutcome::failed(format!("git log failed: {e}")),
    };

    let mut out = String::new();
    for c in &commits {
        if oneline {
            out.push_str(&format!("{} {}\n", short_oid(c.id()), c.summary().ok().flatten().unwrap_or("")));
        } else {
            let a = c.author();
            out.push_str(&format!(
                "commit {}\nAuthor: {} <{}>\nDate:   {}\n\n",
                c.id(),
                a.name().unwrap_or("?"),
                a.email().unwrap_or("?"),
                iso_time(a.when().seconds(), a.when().offset_minutes())
            ));
            for line in c.message().unwrap_or("").lines() {
                out.push_str(&format!("    {line}\n"));
            }
            out.push('\n');
        }
    }
    if out.is_empty() {
        return ToolOutcome::executed("(no commits)");
    }
    ToolOutcome::executed(out)
}

fn push_path(repo: &Repository, ws: &Path, p: &str) -> Result<String, String> {
    rel_path(repo, ws, p)
}

/// Header + patch for one commit (diff against first parent; root commits
/// diff against the empty tree) — the `git show` payload.
pub(crate) fn show_commit_patch(repo: &Repository, commit: &git2::Commit<'_>, max: usize) -> Result<String, git2::Error> {
    let a = commit.author();
    let mut out = format!(
        "commit {}\nAuthor: {} <{}>\nDate:   {}\n\n{}\n",
        commit.id(),
        a.name().unwrap_or("?"),
        a.email().unwrap_or("?"),
        iso_time(a.when().seconds(), a.when().offset_minutes()),
        commit.message().unwrap_or("").trim_end()
    );
    let this_tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&this_tree), None)?;
    let patch = diff_patch(&diff, max.saturating_sub(out.len()));
    if !patch.is_empty() {
        out.push('\n');
        out.push_str(&patch);
    }
    Ok(out)
}

fn cmd_show(repo: &Repository, args: &[String]) -> ToolOutcome {
    let target = match args.iter().find(|a| !a.starts_with('-')) {
        Some(t) => t.clone(),
        None => return ToolOutcome::failed("show: a commit-ish is required"),
    };
    let obj = match repo.revparse_single(&target) {
        Ok(o) => o,
        Err(e) => return ToolOutcome::failed(format!("show: bad revision '{target}' ({e})")),
    };
    let commit = match obj.peel_to_commit() {
        Ok(c) => c,
        Err(_) => return ToolOutcome::failed(format!("show: '{target}' is not a commit (trees/blobs unsupported)")),
    };
    match show_commit_patch(repo, &commit, MAX_OUTPUT) {
        Ok(out) => ToolOutcome::executed(out),
        Err(e) => ToolOutcome::failed(format!("git show failed: {e}")),
    }
}

// ─── branch (listing) ──────────────────────────────────────────────────

fn cmd_branch(repo: &Repository, flags: &[String]) -> ToolOutcome {
    let all = flags.iter().any(|f| f == "-a" || f == "--all" || f == "--remotes" || f == "-r");
    if flags.iter().any(|f| f == "--show-current") {
        let name = repo.head().ok().and_then(|h| h.shorthand().ok().map(String::from));
        return ToolOutcome::executed(name.unwrap_or_default());
    }
    let unexpected = flags.iter().find(|f| !matches!(f.as_str(), "-a" | "--all" | "-r" | "--remotes" | "-v" | "--list"));
    if let Some(f) = unexpected {
        return ToolOutcome::failed(format!(
            "branch: only listing is supported natively ({f} given). Creating/switching/deleting branches: use bash with approval."
        ));
    }
    let current = repo.head().ok().and_then(|h| h.shorthand().ok().map(String::from));
    let mut out = String::new();
    let emit = |ty: BranchType, prefix: &str, out: &mut String| {
        if let Ok(branches) = repo.branches(Some(ty)) {
            for b in branches.flatten() {
                let (branch, _) = b;
                if let Some(name) = branch.name().ok().flatten() {
                    let name = format!("{prefix}{name}");
                    let marker = if ty == BranchType::Local && Some(name.trim_start_matches(prefix)) == current.as_deref() { "*" } else { " " };
                    out.push_str(&format!("{marker} {name}\n"));
                }
            }
        }
    };
    emit(BranchType::Local, "", &mut out);
    if all {
        emit(BranchType::Remote, "remotes/", &mut out);
    }
    ToolOutcome::executed(if out.is_empty() { "(no branches)".to_string() } else { out })
}

// ─── add / commit / unstage ────────────────────────────────────────────

fn cmd_add(repo: &Repository, args: &[String], ws: &Path) -> ToolOutcome {
    if args.iter().any(|a| a == "." || a == "-A" || a == "--all" || a == ".." || a.starts_with("../")) {
        return ToolOutcome::failed(
            "Refused: stage specific files by name — `git add -A` / `git add .` risks secrets and large binaries (see the tool's safety protocol).",
        );
    }
    let unexpected = args.iter().find(|a| a.starts_with('-'));
    if let Some(f) = unexpected {
        return ToolOutcome::failed(format!("add: unsupported flag {f} — stage specific files by name"));
    }
    if args.is_empty() {
        return ToolOutcome::failed("add: at least one path is required");
    }
    let mut index = match repo.index() {
        Ok(i) => i,
        Err(e) => return ToolOutcome::failed(format!("add: {e}")),
    };
    for a in args {
        let rel = match rel_path(repo, ws, a) {
            Ok(r) => r,
            Err(e) => return ToolOutcome::failed(e),
        };
        let on_disk = repo.workdir().map(|w| w.join(&rel)).is_some_and(|p| p.exists());
        if on_disk {
            if let Err(e) = index.add_path(Path::new(&rel)) {
                return ToolOutcome::failed(format!("add: {rel}: {e}"));
            }
        } else if index.get_path(Path::new(&rel), 0).is_some() {
            // Stage the deletion of a tracked file that vanished (git add
            // records removals for named paths too).
            if let Err(e) = index.remove_path(Path::new(&rel)) {
                return ToolOutcome::failed(format!("add: {rel}: {e}"));
            }
        } else {
            return ToolOutcome::failed(format!("add: pathspec '{a}' did not match any files"));
        }
    }
    if let Err(e) = index.write() {
        return ToolOutcome::failed(format!("add: write index: {e}"));
    }
    ToolOutcome::executed(format!("staged {}", args.join(" ")))
}

fn commit_signature(repo: &Repository) -> Result<git2::Signature<'static>, String> {
    let pick = |keys: [&str; 2]| -> Option<(String, String)> {
        for k in keys {
            if let Ok(v) = std::env::var(k) {
                if !v.trim().is_empty() {
                    let peer = if k.ends_with("NAME") { k.replace("NAME", "EMAIL") } else { k.replace("EMAIL", "NAME") };
                    if let (Ok(pn), Ok(pe)) = (std::env::var(&peer), std::env::var(k)) {
                        if !pn.trim().is_empty() {
                            return Some((pn, pe));
                        }
                    }
                }
            }
        }
        None
    };
    if let Ok(cfg) = repo.config() {
        if let (Ok(name), Ok(email)) = (cfg.get_string("user.name"), cfg.get_string("user.email")) {
            if !name.trim().is_empty() && !email.trim().is_empty() {
                return git2::Signature::now(&name, &email).map_err(|e| e.to_string());
            }
        }
    }
    if let Some((name, email)) = pick(["GIT_COMMITTER_NAME", "GIT_AUTHOR_NAME"]) {
        return git2::Signature::now(&name, &email).map_err(|e| e.to_string());
    }
    Err("commit: no user.name/user.email configured (git config) and no GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL set".to_string())
}

fn cmd_commit(repo: &Repository, args: &[String]) -> ToolOutcome {
    let mut messages: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-m" | "--message" => {
                i += 1;
                match args.get(i) {
                    Some(m) => messages.push(m.clone()),
                    None => return ToolOutcome::failed("commit: -m requires a message"),
                }
            }
            f if f.starts_with('-') => {
                return ToolOutcome::failed(format!("commit: unsupported flag {f} (supported: -m, repeatable)"))
            }
            p => return ToolOutcome::failed(format!("commit: unexpected argument '{p}' (amend/pathspec commits unsupported; create a NEW commit)")),
        }
        i += 1;
    }
    if messages.is_empty() {
        return ToolOutcome::failed("commit: -m <message> is required");
    }
    let message = messages.join("\n\n");
    let sig = match commit_signature(repo) {
        Ok(s) => s,
        Err(m) => return ToolOutcome::failed(m),
    };
    let mut index = match repo.index() {
        Ok(i) => i,
        Err(e) => return ToolOutcome::failed(format!("commit: {e}")),
    };
    let tree_id = match index.write_tree() {
        Ok(t) => t,
        Err(e) => return ToolOutcome::failed(format!("commit: {e}")),
    };
    let tree = match repo.find_tree(tree_id) {
        Ok(t) => t,
        Err(e) => return ToolOutcome::failed(format!("commit: {e}")),
    };
    let parent = match repo.head() {
        Ok(h) => h.resolve().ok().and_then(|r| r.target().to_owned()).and_then(|t| repo.find_commit(t).ok()),
        Err(_) => None,
    };
    let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
    let oid = match repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents) {
        Ok(o) => o,
        Err(e) => return ToolOutcome::failed(format!("commit: {e}")),
    };
    let branch = repo.head().ok().and_then(|h| h.shorthand().ok().map(String::from)).unwrap_or_else(|| "(detached)".into());
    let subject = message.lines().next().unwrap_or("").to_string();
    ToolOutcome::executed(format!("[{} {}] {}", branch, short_oid(oid), subject))
}

fn cmd_unstage(repo: &Repository, cmd: &str, args: &[String], ws: &Path) -> ToolOutcome {
    let rest: &[String] = if cmd == "restore" {
        match args.first().map(|s| s.as_str()) {
            Some("--staged") | Some("-S") => &args[1..],
            _ => return ToolOutcome::failed("restore: only `--staged <paths>` (unstage) is supported; discarding worktree changes is destructive — use bash with approval"),
        }
    } else {
        match args.iter().position(|a| a == "--") {
            Some(pos) if pos == 0 || args[..pos].iter().all(|a| a.is_empty()) => &args[pos + 1..],
            Some(_) => return ToolOutcome::failed("reset: only `reset -- <paths>` (unstage) is supported; hard/soft/mode resets are destructive — use bash with approval"),
            None => return ToolOutcome::failed("reset: only `reset -- <paths>` (unstage) is supported; hard/soft/mode resets are destructive — use bash with approval"),
        }
    };
    if rest.is_empty() {
        return ToolOutcome::failed(format!("{cmd}: at least one path is required"));
    }
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut index = match repo.index() {
        Ok(i) => i,
        Err(e) => return ToolOutcome::failed(format!("{cmd}: {e}")),
    };
    for a in rest {
        let rel = match rel_path(repo, ws, a) {
            Ok(r) => r,
            Err(e) => return ToolOutcome::failed(e),
        };
        match head_tree.as_ref().and_then(|t| t.get_path(Path::new(&rel)).ok()) {
            Some(entry) => {
                if let Ok(blob) = repo.find_blob(entry.id()) {
                    let staged = IndexEntry {
                        ctime: git2::IndexTime::new(0, 0),
                        mtime: git2::IndexTime::new(0, 0),
                        dev: 0,
                        ino: 0,
                        mode: entry.filemode() as u32,
                        uid: 0,
                        gid: 0,
                        file_size: blob.size() as u32,
                        flags_extended: 0,
                        flags: 0,
                        id: entry.id(),
                        path: rel.clone().into_bytes(),
                    };
                    if let Err(e) = index.add(&staged) {
                        return ToolOutcome::failed(format!("{cmd}: {rel}: {e}"));
                    }
                }
            }
            None => {
                if index.get_path(Path::new(&rel), 0).is_some() {
                    if let Err(e) = index.remove_path(Path::new(&rel)) {
                        return ToolOutcome::failed(format!("{cmd}: {rel}: {e}"));
                    }
                } else {
                    return ToolOutcome::failed(format!("{cmd}: pathspec '{a}' did not match any files"));
                }
            }
        }
    }
    if let Err(e) = index.write() {
        return ToolOutcome::failed(format!("{cmd}: write index: {e}"));
    }
    ToolOutcome::executed(format!("unstaged {}", rest.join(" ")))
}

impl Tool for GitTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "git".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "args": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Subcommand + flags, e.g. [\"status\", \"--short\"] or [\"log\", \"-n\", \"5\"].",
                    }
                },
                "required": ["args"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Destructive
    }

    fn execute(&self, ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        let argv: Vec<String> = args
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(String::from).collect())
            .unwrap_or_default();
        Ok(run_git(&argv, &ctx.workspace_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolContext;

    fn seed_repo() -> (tempfile::TempDir, Repository) {
        let tmp = tempfile::tempdir().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        let sig = git2::Signature::now("Tester", "tester@example.com").unwrap();
        let mut index = repo.index().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "line one\nline two\n").unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::write(tmp.path().join("src/b.rs"), "fn b() {}\n").unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.add_path(Path::new("src/b.rs")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[]).unwrap();
        drop(tree);
        drop(index);
        (tmp, repo)
    }

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn git(ws: &Path, v: &[&str]) -> ToolOutcome {
        run_git(&args(v), ws)
    }

    #[test]
    fn status_reports_clean_tree_after_commit() {
        let (tmp, _repo) = seed_repo();
        let out = git(tmp.path(), &["status"]);
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(out.output.contains("On branch master"));
        assert!(out.output.contains("nothing to commit, working tree clean"), "{}", out.output);
    }

    #[test]
    fn status_short_shows_staged_unstaged_and_untracked() {
        let (tmp, repo) = seed_repo();
        std::fs::write(tmp.path().join("a.txt"), "line one changed\nline two\n").unwrap();
        std::fs::write(tmp.path().join("new.txt"), "x").unwrap();
        let mut index = repo.index().unwrap();
        std::fs::write(tmp.path().join("src/b.rs"), "fn b2() {}\n").unwrap();
        index.add_path(Path::new("src/b.rs")).unwrap();
        index.write().unwrap();

        let out = git(tmp.path(), &["status", "--short"]);
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(out.output.contains("M  src/b.rs"), "{}", out.output); // staged
        assert!(out.output.contains(" M a.txt"), "{}", out.output);    // unstaged
        assert!(out.output.contains("?? new.txt"), "{}", out.output);  // untracked
    }

    #[test]
    fn diff_shows_unstaged_then_cached() {
        let (tmp, repo) = seed_repo();
        std::fs::write(tmp.path().join("a.txt"), "line one CHANGED\nline two\n").unwrap();
        let out = git(tmp.path(), &["diff"]);
        assert!(out.output.contains("--- a/a.txt"), "{}", out.output);
        assert!(out.output.contains("+++ b/a.txt"), "{}", out.output);
        assert!(out.output.contains("-line one"), "{}", out.output);
        assert!(out.output.contains("+line one CHANGED"), "{}", out.output);

        // Nothing staged yet: --cached is empty.
        let out = git(tmp.path(), &["diff", "--cached"]);
        assert_eq!(out.output.trim(), "", "{}", out.output);

        // Stage the change: --cached shows it, plain diff is clean.
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let out = git(tmp.path(), &["diff", "--cached"]);
        assert!(out.output.contains("+line one CHANGED"), "{}", out.output);
        let out = git(tmp.path(), &["diff"]);
        assert_eq!(out.output.trim(), "", "{}", out.output);

        // --stat summary line.
        let out = git(tmp.path(), &["diff", "--cached", "--stat"]);
        assert!(out.output.contains("a.txt"), "{}", out.output);

        // Pathspec filtering via workspace sandbox.
        let out = git(tmp.path(), &["diff", "--name-only"]);
        assert_eq!(out.output.trim(), "");
        let _ = repo; // silence unused when assertions short-circuit
    }

    #[test]
    fn log_and_show_work() {
        let (tmp, repo) = seed_repo();
        let sig = git2::Signature::now("Tester", "tester@example.com").unwrap();
        std::fs::write(tmp.path().join("a.txt"), "line one\nline two\nline three\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "second commit\n\nbody text", &tree, &[&parent]).unwrap();

        let out = git(tmp.path(), &["log"]);
        assert!(out.output.contains("commit "), "{}", out.output);
        assert!(out.output.contains("Author: Tester <tester@example.com>"), "{}", out.output);
        assert!(out.output.contains("second commit"), "{}", out.output);

        let out = git(tmp.path(), &["log", "--oneline"]);
        assert_eq!(out.output.lines().count(), 2, "{}", out.output);
        assert!(out.output.contains("second commit"), "{}", out.output);

        let out = git(tmp.path(), &["log", "-n", "1", "--oneline"]);
        assert_eq!(out.output.lines().count(), 1);
        assert!(out.output.contains("second commit"));

        // Path-filtered log: only the commit touching a.txt.
        let out = git(tmp.path(), &["log", "--oneline", "--", "a.txt"]);
        assert_eq!(out.output.lines().count(), 2);
        let out = git(tmp.path(), &["log", "--oneline", "--", "src/b.rs"]);
        assert_eq!(out.output.lines().count(), 1);
        assert!(out.output.contains("initial commit"));

        let out = git(tmp.path(), &["show", "HEAD"]);
        assert!(out.output.contains("second commit"), "{}", out.output);
        assert!(out.output.contains("+line three"), "{}", out.output);
    }

    #[test]
    fn add_commit_and_unstage_roundtrip() {
        let (tmp, repo) = seed_repo();
        std::fs::write(tmp.path().join("c.txt"), "brand new\n").unwrap();

        // git add refuses blanket staging (safety protocol).
        let out = git(tmp.path(), &["add", "."]);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Refused: stage specific files by name"), "{}", out.output);

        let out = git(tmp.path(), &["add", "c.txt"]);
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
        let out = git(tmp.path(), &["status", "--short"]);
        assert!(out.output.contains("A  c.txt"), "{}", out.output);

        // commit without configured identity: repo-local config provides one.
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Agent").unwrap();
        cfg.set_str("user.email", "agent@tide.local").unwrap();
        let out = git(tmp.path(), &["commit", "-m", "add c", "-m", "with body"]);
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
        assert!(out.output.starts_with("[master "), "{}", out.output);
        assert!(out.output.contains("add c"), "{}", out.output);

        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message().unwrap(), "add c\n\nwith body");

        // modify + stage, then unstage via restore --staged and reset --.
        std::fs::write(tmp.path().join("c.txt"), "changed\n").unwrap();
        git(tmp.path(), &["add", "c.txt"]);
        let out = git(tmp.path(), &["status", "--short"]);
        assert!(out.output.contains("M  c.txt"), "{}", out.output);
        let out = git(tmp.path(), &["restore", "--staged", "c.txt"]);
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
        let out = git(tmp.path(), &["status", "--short"]);
        assert!(out.output.contains(" M c.txt"), "{}", out.output);

        git(tmp.path(), &["add", "c.txt"]);
        let out = git(tmp.path(), &["reset", "--", "c.txt"]);
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
        let out = git(tmp.path(), &["status", "--short"]);
        assert!(out.output.contains(" M c.txt"), "{}", out.output);

        // Unstaging a newly-added (not in HEAD) file removes the entry.
        std::fs::write(tmp.path().join("d.txt"), "d").unwrap();
        git(tmp.path(), &["add", "d.txt"]);
        let out = git(tmp.path(), &["restore", "--staged", "d.txt"]);
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
        let out = git(tmp.path(), &["status", "--short"]);
        assert!(out.output.contains("?? d.txt"), "{}", out.output);
    }

    #[test]
    fn branch_lists_local_and_remotes() {
        let (tmp, repo) = seed_repo();
        let out = git(tmp.path(), &["branch"]);
        assert!(out.output.contains("* master"), "{}", out.output);
        let out = git(tmp.path(), &["branch", "--show-current"]);
        assert_eq!(out.output.trim(), "master");
        // Remote listing needs remote refs; with none, -a adds nothing.
        let out = git(tmp.path(), &["branch", "-a"]);
        assert!(out.output.contains("* master"), "{}", out.output);
        let _ = repo;
    }

    #[test]
    fn subcommands_outside_native_set_fail_without_executing() {
        let (tmp, _repo) = seed_repo();
        for v in [&["push"][..], &["rebase", "main"][..], &["stash"][..]] {
            let out = git(tmp.path(), v);
            assert_eq!(out.status, crate::OutcomeStatus::Failed, "{v:?}: {}", out.output);
            assert!(out.output.contains("git2-native tool does not implement"), "{v:?}");
        }
        // reset --hard routes into the unstage parser and is refused there.
        let out = git(tmp.path(), &["reset", "--hard"]);
        assert_eq!(out.status, crate::OutcomeStatus::Failed, "{}", out.output);
        assert!(out.output.contains("destructive"), "{}", out.output);
        // Nothing was mutated (HEAD unchanged, no new refs).
        let out = git(tmp.path(), &["log", "--oneline"]);
        assert_eq!(out.output.lines().count(), 1);
    }

    #[test]
    fn paths_escaping_the_workspace_are_rejected() {
        let (tmp, repo) = seed_repo();
        // A sibling repo outside the workspace root.
        let outside = tempfile::tempdir().unwrap();
        let _other = Repository::init_bare(outside.path()).unwrap();
        let out = git(tmp.path(), &["add", &outside.path().display().to_string()]);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("outside the workspace root"), "{}", out.output);
        let _ = repo;
    }

    #[test]
    fn non_repo_root_reports_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        let out = git(tmp.path(), &["status"]);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("not a git repository"), "{}", out.output);
    }

    #[test]
    fn empty_args_missing() {
        let (tmp, _repo) = seed_repo();
        let out = git(tmp.path(), &[]);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Missing required arg"));
    }

    #[test]
    fn discovery_walks_up_from_subdirectory() {
        let (tmp, _repo) = seed_repo();
        let sub = tmp.path().join("src");
        let out = git(&sub, &["status"]);
        assert_eq!(out.status, crate::OutcomeStatus::Executed, "{}", out.output);
    }

    #[test]
    fn subcommand_tiers_follow_operation_semantics() {
        use crate::permission::RiskTier;
        assert_eq!(subcommand_tier("status"), RiskTier::ReadOnly);
        assert_eq!(subcommand_tier("diff"), RiskTier::ReadOnly);
        assert_eq!(subcommand_tier("log"), RiskTier::ReadOnly);
        assert_eq!(subcommand_tier("show"), RiskTier::ReadOnly);
        assert_eq!(subcommand_tier("branch"), RiskTier::ReadOnly);
        assert_eq!(subcommand_tier("add"), RiskTier::Write);
        assert_eq!(subcommand_tier("commit"), RiskTier::Write);
        assert_eq!(subcommand_tier("restore"), RiskTier::Write);
        assert_eq!(subcommand_tier("push"), RiskTier::Destructive);
        assert_eq!(subcommand_tier("rebase"), RiskTier::Destructive);
    }

    #[test]
    fn iso_time_formats_strict_iso8601() {
        assert_eq!(iso_time(0, 0), "1970-01-01T00:00:00+00:00");
        assert_eq!(iso_time(1_700_000_000, 120), "2023-11-15T00:13:20+02:00");
        assert_eq!(iso_time(1_700_000_000, -330), "2023-11-14T16:43:20-05:30");
    }

    #[test]
    fn trait_execute_parses_args_array() {
        let (tmp, _repo) = seed_repo();
        let tool = GitTool;
        assert_eq!(tool.spec().name, "git");
        assert_eq!(tool.risk_tier(), RiskTier::Destructive);
        let out = tool
            .execute(&ToolContext::new(tmp.path().to_path_buf()), serde_json::json!({"args": ["log", "--oneline"]}))
            .unwrap();
        assert!(out.output.contains("initial commit"), "{}", out.output);
        // Missing args → failed like the TS tool.
        let out = tool.execute(&ToolContext::new(tmp.path().to_path_buf()), serde_json::json!({})).unwrap();
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
    }
}
