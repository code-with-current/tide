//! git2-backed session-worktree lifecycle — the port of the worktree trio in
//! `app/core/ipc-adjacent/git.ts` @ 91ec558 (`worktreeAdd` / `worktreeRemove`
//! / `worktreeStatus`) plus `copyConfigFile` from sessions.ts. The TS shelled
//! out to the git CLI; libgit2 does the same jobs natively (branch create +
//! worktree add from the base branch, recursive prune + branch delete on
//! remove, ahead/behind via the commit graph).

use std::fs;
use std::path::{Path, PathBuf};

use git2::{BranchType, Repository, WorktreeAddOptions, WorktreePruneOptions};
use serde::Serialize;

use super::CommandError;

/// `SessionWorktree` in shared/rpc.ts — persisted into the `session_worktree`
/// side table and returned by `sessionCreateWorktree`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorktreeWire {
    pub branch: String,
    pub path: String,
    pub base_commit: String,
    pub base_branch: String,
    pub ahead: usize,
    pub behind: usize,
}

/// `git rev-parse --short HEAD` parity: 7 hex chars.
fn short_sha(oid: git2::Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

/// `worktreeAdd`: create `<root>/<location>/<branch>` checked out on a new
/// branch off `base_branch`. Errors propagate (branch exists, base missing,
/// path clash) — the renderer catches and falls back to no-worktree mode.
pub fn worktree_add(
    root_dir: &Path,
    worktree_location: &str,
    branch_name: &str,
    base_branch: &str,
) -> Result<(PathBuf, String), String> {
    let full_path = lexical_join(root_dir, worktree_location).join(branch_name);
    let repo = Repository::open(root_dir).map_err(|e| format!("git worktree add: {e}"))?;
    // The git CLI creates intermediate worktree dirs; libgit2 does not.
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("git worktree add: {e}"))?;
    }
    let base_ref = repo
        .find_reference(&format!("refs/heads/{base_branch}"))
        .map_err(|e| format!("base branch {base_branch}: {e}"))?;
    let base_commit = base_ref
        .peel_to_commit()
        .map_err(|e| format!("base branch {base_branch}: {e}"))?;
    // `-b branchName … baseBranch`: a NEW branch at the base tip. force=false
    // keeps the CLI's "branch already exists" failure.
    let branch = repo
        .branch(branch_name, &base_commit, false)
        .map_err(|e| format!("branch {branch_name}: {e}"))?;
    let mut opts = WorktreeAddOptions::new();
    opts.reference(Some(branch.get()));
    repo.worktree(branch_name, &full_path, Some(&opts))
        .map_err(|e| format!("git worktree add: {e}"))?;
    // TS quirk kept: baseCommit is the ROOT checkout's HEAD short sha (the
    // `rev-parse --short HEAD` ran with cwd=rootDir), not the base tip.
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("git rev-parse HEAD: {e}"))?;
    Ok((full_path, short_sha(head.id())))
}

/// `worktreeStatus`: ahead/behind of the worktree HEAD vs its base branch.
/// `rev-list --left-right --count base...HEAD` returned [behind, ahead];
/// git2's graph_ahead_behind(local, upstream) returns (ahead, behind).
pub fn worktree_status(worktree_path: &Path, base_branch: &str) -> (usize, usize) {
    let repo = match Repository::open(worktree_path) {
        Ok(repo) => repo,
        Err(_) => return (0, 0),
    };
    let head_id = match repo.head().and_then(|h| h.peel_to_commit()).map(|c| c.id()) {
        Ok(id) => id,
        Err(_) => return (0, 0),
    };
    let base_id = repo
        .find_reference(&format!("refs/heads/{base_branch}"))
        .and_then(|r| r.peel_to_commit())
        .map(|c| c.id());
    let Ok(base_id) = base_id else {
        return (0, 0);
    };
    match repo.graph_ahead_behind(head_id, base_id) {
        Ok((ahead, behind)) => (ahead, behind),
        Err(_) => (0, 0),
    }
}

/// `worktreeRemove`: remove the worktree (directory + admin data) and delete
/// its branch. Best-effort like the TS — each failure is swallowed, and the
/// caller clears the session linkage regardless.
pub fn worktree_remove(root_dir: &Path, branch_name: &str) {
    let repo = match Repository::open(root_dir) {
        Ok(repo) => repo,
        Err(_) => return,
    };
    let found = repo.find_worktree(branch_name);
    if let Ok(worktree) = found {
        let _ = worktree.unlock();
        let mut opts = WorktreePruneOptions::new();
        // `git worktree remove --force`: valid + locked worktrees go too, and
        // the working tree is recursively removed.
        opts.valid(true).locked(true).working_tree(true);
        let _ = worktree.prune(Some(&mut opts));
    }
    let branch = repo.find_branch(branch_name, BranchType::Local);
    if let Ok(mut branch) = branch {
        let _ = branch.delete();
    }
}

/// `copyConfigFile`: copy a file from the workspace root into the worktree,
/// mirroring subdirs; refuses `..`-escapes and overwrites cleanly.
pub fn copy_config_file(workspace_root: &Path, worktree_root: &Path, rel_path: &str) -> Result<(), String> {
    let src = lexical_join(workspace_root, rel_path);
    let dst = lexical_join(worktree_root, rel_path);
    if !contained_in(workspace_root, &src) {
        return Err(format!("Source path escapes workspace: {rel_path}"));
    }
    if !contained_in(worktree_root, &dst) {
        return Err(format!("Destination path escapes worktree: {rel_path}"));
    }
    if !src.is_file() {
        return Err(format!("Source not found: {rel_path}"));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

/// `path.resolve(root, rel)` without symlink resolution — `~/` expanded,
/// relative segments joined, `..` folded lexically (the TS relative/escape
/// checks were purely lexical too).
pub(crate) fn lexical_join(root: &Path, rel: &str) -> PathBuf {
    let rel = expand_home(rel);
    let rel_path = PathBuf::from(&rel);
    if rel_path.is_absolute() {
        return normalize_lexical(rel_path);
    }
    let mut out = normalize_lexical(PathBuf::from(expand_home(&root.to_string_lossy())));
    for component in rel_path.components() {
        use std::path::Component;
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// True when `child` sits inside `root` (strictly — the root itself does not
/// count, matching the TS `rel === ''` rejection).
fn contained_in(root: &Path, child: &Path) -> bool {
    match child.strip_prefix(root) {
        Ok(rest) => !rest.as_os_str().is_empty(),
        Err(_) => false,
    }
}

fn normalize_lexical(path: PathBuf) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub(crate) fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            return Path::new(&home).join(rest).to_string_lossy().into_owned();
        }
    }
    p.to_owned()
}

/// The full `sessionCreateWorktree` flow against a workspace: add, copy
/// config files, compute status. Returns the persisted wire shape.
pub fn create_session_worktree(
    workspace_root: &Path,
    worktree_location: &str,
    branch_name: &str,
    base_branch: &str,
    config_files: &[String],
) -> Result<SessionWorktreeWire, CommandError> {
    let (wt_path, base_commit) = worktree_add(workspace_root, worktree_location, branch_name, base_branch)
        .map_err(|e| CommandError::with_code(e, "WORKTREE_ADD"))?;
    for rel in config_files {
        // Per-file best-effort with a log — a missing .env must not undo the
        // worktree (the TS warned and continued).
        if let Err(error) = copy_config_file(workspace_root, &wt_path, rel) {
            #[cfg(debug_assertions)]
            eprintln!("[tide] worktree config copy failed for {rel}: {error}");
        }
    }
    let (ahead, behind) = worktree_status(&wt_path, base_branch);
    Ok(SessionWorktreeWire {
        branch: branch_name.to_owned(),
        path: wt_path.to_string_lossy().into_owned(),
        base_commit,
        base_branch: base_branch.to_owned(),
        ahead,
        behind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tide-cmd-worktree-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn worktree_names(repo: &Repository) -> Vec<String> {
        repo.worktrees()
            .unwrap()
            .iter()
            .filter_map(|entry| entry.ok().flatten().map(|s| s.to_owned()))
            .collect()
    }

    /// A repo with one commit on `main` and a tracked file.
    fn seeded_repo(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        let repo = Repository::init(&dir).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Tide Test").unwrap();
        config.set_str("user.email", "tide@test.local").unwrap();
        drop(config);
        fs::write(dir.join("hello.txt"), "hi\n").unwrap();
        fs::write(dir.join(".env"), "SECRET=1\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("hello.txt")).unwrap();
        index.add_path(Path::new(".env")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = repo.signature().unwrap();
        let commit_id = repo
            .commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        drop(tree);
        let head_commit = repo.find_commit(commit_id).unwrap();
        repo.branch("main", &head_commit, true).unwrap();
        drop(head_commit);
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(None).unwrap();
        dir
    }

    #[test]
    fn add_copies_base_and_remove_prunes_everything() {
        let root = seeded_repo("add-remove");
        let (wt_path, base_commit) =
            worktree_add(&root, ".agent/worktrees", "wt-x", "main").unwrap();
        assert!(wt_path.ends_with(".agent/worktrees/wt-x"));
        assert!(wt_path.join("hello.txt").is_file());
        assert_eq!(base_commit.len(), 7);
        let (ahead, behind) = worktree_status(&wt_path, "main");
        assert_eq!((ahead, behind), (0, 0));

        let repo = Repository::open(&root).unwrap();
        assert!(repo.find_branch("wt-x", BranchType::Local).is_ok());
        assert!(worktree_names(&repo).contains(&"wt-x".to_owned()));
        drop(repo);

        worktree_remove(&root, "wt-x");
        assert!(!wt_path.exists(), "working tree recursively removed");
        let repo = Repository::open(&root).unwrap();
        assert!(repo.find_branch("wt-x", BranchType::Local).is_err());
        assert!(!worktree_names(&repo).contains(&"wt-x".to_owned()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn add_reuses_existing_branch_name_fails_like_the_cli() {
        let root = seeded_repo("branch-clash");
        let first = worktree_add(&root, ".agent/worktrees", "wt-dup", "main");
        assert!(first.is_ok());
        let second = worktree_add(&root, ".agent/worktrees", "wt-dup", "main");
        assert!(second.unwrap_err().contains("wt-dup"));
        let missing_base = worktree_add(&root, ".agent/worktrees", "wt-y", "nope");
        assert!(missing_base.unwrap_err().contains("nope"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn config_copy_mirrors_and_refuses_escapes() {
        let root = seeded_repo("config-copy");
        let (wt_path, _) = worktree_add(&root, ".agent/worktrees", "wt-c", "main").unwrap();
        copy_config_file(&root, &wt_path, ".env").unwrap();
        assert_eq!(
            fs::read_to_string(wt_path.join(".env")).unwrap(),
            "SECRET=1\n"
        );
        // Subdir mirroring.
        fs::create_dir_all(root.join("config")).unwrap();
        fs::write(root.join("config/app.json"), "{}").unwrap();
        copy_config_file(&root, &wt_path, "config/app.json").unwrap();
        assert!(wt_path.join("config/app.json").is_file());

        assert!(copy_config_file(&root, &wt_path, "../outside.txt")
            .unwrap_err()
            .contains("escapes"));
        assert!(copy_config_file(&root, &wt_path, "missing.txt")
            .unwrap_err()
            .contains("not found"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn full_flow_returns_the_persisted_shape() {
        let root = seeded_repo("flow");
        let wire = create_session_worktree(
            &root,
            ".agent/worktrees/",
            "wt-flow",
            "main",
            &[".env".to_owned()],
        )
        .unwrap();
        assert_eq!(wire.branch, "wt-flow");
        assert_eq!(wire.base_branch, "main");
        assert!(wire.path.ends_with(".agent/worktrees/wt-flow"));
        assert_eq!(wire.base_commit.len(), 7);
        assert_eq!((wire.ahead, wire.behind), (0, 0));
        let wire_value = serde_json::to_value(&wire).unwrap();
        assert_eq!(
            wire_value,
            serde_json::json!({
                "branch": "wt-flow",
                "path": wire.path,
                "baseCommit": wire.base_commit,
                "baseBranch": "main",
                "ahead": 0,
                "behind": 0,
            })
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn lexical_join_folds_parents_and_expands_home() {
        let joined = lexical_join(Path::new("/ws/alpha"), ".agent/worktrees/wt");
        assert_eq!(joined, PathBuf::from("/ws/alpha/.agent/worktrees/wt"));
        let escaped = lexical_join(Path::new("/ws/alpha"), "../../etc/passwd");
        assert_eq!(escaped, PathBuf::from("/etc/passwd"));
        assert!(!contained_in(Path::new("/ws/alpha"), &escaped));
        let root_itself = lexical_join(Path::new("/ws/alpha"), "");
        assert!(!contained_in(Path::new("/ws/alpha"), &root_itself));
        let inside = lexical_join(Path::new("/ws/alpha"), "src/main.rs");
        assert!(contained_in(Path::new("/ws/alpha"), &inside));
    }
}
