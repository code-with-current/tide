//! Path sandboxing — port of `app/core/agent/path-safety.ts` ().
//! Resolve tool target paths against the workspace root and refuse escapes
//! using component-wise checks (string-prefix matching is unsafe).
//!
//! One deliberate deviation from the TS: when re-verifying a symlink-resolved
//! target, the ROOT is canonicalized too. TS compared the realpath of the
//! target against the raw root string, which false-positives on macOS
//! tmpdirs (`/tmp` → `/private/tmp`); canonicalizing both sides keeps the
//! security property (a symlink inside root whose target escapes is still
//! rejected) without rejecting legitimate reads under symlinked roots.

use std::path::{Component, Path, PathBuf};

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PathEscapeError {
    pub message: String,
    pub requested_path: Option<String>,
    pub workspace_root: Option<String>,
}

impl PathEscapeError {
    fn escape(target: &str, root: &Path) -> Self {
        Self {
            message: format!("Path \"{target}\" resolves outside the workspace root"),
            requested_path: Some(target.to_string()),
            workspace_root: Some(root.display().to_string()),
        }
    }

    fn resolved_escape(resolved: &Path, root: &Path) -> Self {
        Self {
            message: "Resolved real path escapes workspace root (likely a symlink)".to_string(),
            requested_path: Some(resolved.display().to_string()),
            workspace_root: Some(root.display().to_string()),
        }
    }
}

/// Lexically normalize a path the way Node's `path.resolve` does for
/// already-absolute inputs: collapse `.` and `..` WITHOUT touching the
/// filesystem (needed for files that don't exist yet).
pub(crate) fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Is `child` equal to or inside `root`? Component-wise so `/foo/barbaz`
/// doesn't count as inside `/foo/bar`.
fn is_inside(root: &Path, child: &Path) -> bool {
    child.strip_prefix(root).is_ok()
}

/// Resolve a path against the workspace root and verify it's inside;
/// errors with [`PathEscapeError`] on escape. Does NOT resolve symlinks
/// (use [`resolve_and_follow_symlinks`] for read paths). Absolute paths
/// pointing inside the root are accepted, like the TS version.
pub fn resolve_inside_workspace(
    workspace_root: &Path,
    target: &str,
) -> Result<PathBuf, PathEscapeError> {
    let root = lexical_normalize(workspace_root);
    let abs = if Path::new(target).is_absolute() {
        lexical_normalize(Path::new(target))
    } else {
        lexical_normalize(&root.join(target))
    };
    if !is_inside(&root, &abs) {
        return Err(PathEscapeError::escape(target, &root));
    }
    Ok(abs)
}

/// Daemon-owned read annexes (attachment and blob stores): read tools may
/// resolve an ABSOLUTE target into any of them in addition to the workspace.
/// Relative targets stay workspace-scoped — a relative path is workspace
/// vocabulary and must never silently reach into a store. On failure the
/// workspace error is surfaced, since that is the root the model knows.
pub fn resolve_inside_roots(
    workspace_root: &Path,
    annex_roots: &[PathBuf],
    target: &str,
) -> Result<PathBuf, PathEscapeError> {
    if let Ok(abs) = resolve_inside_workspace(workspace_root, target) {
        return Ok(abs);
    }
    if Path::new(target).is_absolute() {
        for annex in annex_roots {
            if let Ok(abs) = resolve_inside_workspace(annex, target) {
                return Ok(abs);
            }
        }
    }
    resolve_inside_workspace(workspace_root, target)
}

/// Daemon-owned write annexes (the knowledge library): write_file may
/// resolve an ABSOLUTE target into them in addition to the workspace —
/// the write-side counterpart of [`resolve_inside_roots`], following the
/// same vocabulary rule: relative targets stay workspace-scoped (a
/// relative path is workspace vocabulary and must never silently reach
/// into a store). The workspace branch is byte-identical to
/// [`resolve_inside_workspace`] — still lexical, still no symlink
/// following, so a brand-new file never trips canonicalize ENOENT.
///
/// An annex-resolved target IS symlink-verified: the canonical path of
/// the target — or, for a file that doesn't exist yet, of its deepest
/// existing ancestor — must land back inside the workspace or the
/// matched annex, so a symlink planted inside the annex cannot redirect
/// the write outside (the write-side mirror of
/// [`resolve_and_follow_symlinks_roots`]' re-verification; edit_file,
/// whose targets must already exist, uses that fn directly).
pub fn resolve_inside_workspace_or_write_annexes(
    workspace_root: &Path,
    write_annex_roots: &[PathBuf],
    target: &str,
) -> Result<PathBuf, PathEscapeError> {
    if let Ok(abs) = resolve_inside_workspace(workspace_root, target) {
        return Ok(abs);
    }
    if Path::new(target).is_absolute() {
        for annex in write_annex_roots {
            if let Ok(abs) = resolve_inside_workspace(annex, target) {
                return verify_write_annex_target(workspace_root, annex, target, abs);
            }
        }
    }
    resolve_inside_workspace(workspace_root, target)
}

/// Symlink defense for one annex-resolved write target. Two cases:
/// - something already exists AT the target: canonicalize it and
///   re-verify against the annex (and workspace). A dangling symlink
///   fails canonicalize and is REFUSED — `fs::write` would otherwise
///   materialize the escaped target;
/// - the target is new: the tail beyond its deepest existing ancestor
///   cannot contain symlinks (nothing exists there), so the ANCESTOR is
///   canonicalized and re-verified instead — closing the
///   new-file-through-parent-symlink hole. Reaching the annex root
///   without an existing node (a not-yet-created library, say) is safe:
///   the caller's `create_dir_all` builds the whole subtree fresh.
///
/// Accepted residual risks (deliberate, not overlooked): there is an
/// inherent check-then-write TOCTOU window — a symlink can be swapped
/// in between the canonicalize here and the caller's later `fs::write`,
/// defeating the re-verification — and hardlinks are not defended at
/// all (a hardlink to a file outside the annex canonicalizes to itself,
/// so it passes verification and redirects the write). Exploiting
/// either requires local-process write access to the user's home
/// directory, which already implies full user-level file write, so
/// closing them would buy no additional security.
fn verify_write_annex_target(
    workspace_root: &Path,
    annex: &Path,
    target: &str,
    abs: PathBuf,
) -> Result<PathBuf, PathEscapeError> {
    let io_error = |e: std::io::Error| PathEscapeError {
        message: format!("Path error: {e}"),
        requested_path: Some(target.to_string()),
        workspace_root: Some(workspace_root.display().to_string()),
    };
    let inside = |real: &Path| {
        assert_resolved_inside(annex, real).is_ok()
            || assert_resolved_inside(workspace_root, real).is_ok()
    };
    if std::fs::symlink_metadata(&abs).is_ok() {
        return match std::fs::canonicalize(&abs) {
            Ok(real) if inside(&real) => Ok(real),
            Ok(real) => Err(PathEscapeError::resolved_escape(&real, annex)),
            Err(e) => Err(io_error(e)),
        };
    }
    // `abs` is lexically normalized; compare the walk against the
    // normalized annex so a non-canonical root spelling still terminates.
    let annex = &lexical_normalize(annex);
    let mut probe = abs.as_path();
    while probe != annex && !probe.exists() {
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break,
        }
    }
    match std::fs::canonicalize(probe) {
        Ok(real) if inside(&real) => Ok(abs),
        Ok(real) => Err(PathEscapeError::resolved_escape(&real, annex)),
        // Vanished mid-call — keep the lexical form, like the read side.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(abs),
        Err(e) => Err(io_error(e)),
    }
}

/// Symlink-following variant of [`resolve_inside_roots`]: resolve, then
/// re-verify the canonical target against the workspace and every annex.
/// Also serves edit_file with the write-annex grant: its targets must
/// already exist, so the read-side re-verification is exactly the write
/// defense needed there.
pub fn resolve_and_follow_symlinks_roots(
    workspace_root: &Path,
    annex_roots: &[PathBuf],
    target: &str,
) -> Result<PathBuf, PathEscapeError> {
    let resolved = resolve_inside_roots(workspace_root, annex_roots, target)?;
    match std::fs::canonicalize(&resolved) {
        Ok(real) => {
            assert_resolved_inside_roots(workspace_root, annex_roots, &real)?;
            Ok(real)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(resolved),
        Err(e) => Err(PathEscapeError {
            message: format!("Path error: {e}"),
            requested_path: Some(target.to_string()),
            workspace_root: Some(workspace_root.display().to_string()),
        }),
    }
}

/// After resolving a real path, verify it is still inside the workspace or
/// one of the read annexes — the symlink defense of
/// [`assert_resolved_inside`], extended to store roots.
pub fn assert_resolved_inside_roots(
    workspace_root: &Path,
    annex_roots: &[PathBuf],
    resolved_abs: &Path,
) -> Result<(), PathEscapeError> {
    if assert_resolved_inside(workspace_root, resolved_abs).is_ok() {
        return Ok(());
    }
    for annex in annex_roots {
        if assert_resolved_inside(annex, resolved_abs).is_ok() {
            return Ok(());
        }
    }
    Err(PathEscapeError::resolved_escape(
        resolved_abs,
        workspace_root,
    ))
}

/// The canonicalized root used for symlink re-verification: canonicalize
/// when possible (existing root), fall back to the lexical form for a
/// root that vanished mid-turn.
fn canonical_root(workspace_root: &Path) -> PathBuf {
    std::fs::canonicalize(workspace_root).unwrap_or_else(|_| lexical_normalize(workspace_root))
}

/// After resolving a real path, verify it's still inside the workspace —
/// defends against a symlink whose link is inside root but whose target
/// escapes.
pub fn assert_resolved_inside(
    workspace_root: &Path,
    resolved_abs: &Path,
) -> Result<(), PathEscapeError> {
    let root = canonical_root(workspace_root);
    if !is_inside(&root, resolved_abs) {
        return Err(PathEscapeError::resolved_escape(resolved_abs, &root));
    }
    Ok(())
}

/// Convenience for read tools: resolve the path AND follow any symlink,
/// re-verifying the target. A target that doesn't exist yet returns the
/// lexical resolution (callers creating files should prefer
/// [`resolve_inside_workspace`]).
pub fn resolve_and_follow_symlinks(
    workspace_root: &Path,
    target: &str,
) -> Result<PathBuf, PathEscapeError> {
    let resolved = resolve_inside_workspace(workspace_root, target)?;
    match std::fs::canonicalize(&resolved) {
        Ok(real) => {
            assert_resolved_inside(workspace_root, &real)?;
            Ok(real)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(resolved),
        Err(e) => Err(PathEscapeError {
            message: format!("Path error: {e}"),
            requested_path: Some(target.to_string()),
            workspace_root: Some(workspace_root.display().to_string()),
        }),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Resolve a target under `~/.claude` or `~/.zcode`, following
/// symlinks + re-verifying; used by read_file for out-of-workspace
/// skill/context files the user explicitly invoked. Windows + macOS are
/// case-insensitive for this comparison, matching the TS.
pub fn resolve_under_skill_root(target: &str) -> Result<PathBuf, PathEscapeError> {
    let Some(home) = home_dir() else {
        return Err(PathEscapeError {
            message: "Resolved path is not under a skill root (~/.claude, ~/.agents or ~/.zcode): "
                .to_string()
                + target,
            requested_path: Some(target.to_string()),
            workspace_root: None,
        });
    };
    let resolved = lexical_normalize(Path::new(target));
    let real = match std::fs::canonicalize(&resolved) {
        Ok(real) => real,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => resolved.clone(),
        Err(e) => {
            return Err(PathEscapeError {
                message: format!("Path error: {e}"),
                requested_path: Some(target.to_string()),
                workspace_root: None,
            })
        }
    };
    let real_home = std::fs::canonicalize(&home).unwrap_or(home);
    let case_insensitive = cfg!(any(target_os = "macos", target_os = "windows"));
    for dir in [".claude", ".agent", ".zcode"] {
        let root = real_home.join(dir);
        let inside = if case_insensitive {
            real.to_string_lossy()
                .to_lowercase()
                .starts_with(&format!("{}/", root.to_string_lossy().to_lowercase()))
                || real.to_string_lossy().to_lowercase() == root.to_string_lossy().to_lowercase()
        } else {
            is_inside(&root, &real)
        };
        if inside {
            return Ok(real);
        }
    }
    Err(PathEscapeError {
        message: format!(
            "Resolved path is not under a skill root (~/.claude, ~/.agents, or ~/.zcode): {target}"
        ),
        requested_path: Some(target.to_string()),
        workspace_root: None,
    })
}

/// Quick non-throwing check: is `target` (absolute) under a skill root?
pub fn is_under_skill_root(target: &str) -> bool {
    resolve_under_skill_root(target).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_normalize_collapses_dots() {
        assert_eq!(
            lexical_normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }

    #[test]
    fn resolve_inside_accepts_relative_and_absolute_inside() {
        let root = Path::new("/tmp/ws");
        assert_eq!(
            resolve_inside_workspace(root, "src/a.ts").unwrap(),
            PathBuf::from("/tmp/ws/src/a.ts")
        );
        assert_eq!(
            resolve_inside_workspace(root, "/tmp/ws/b.ts").unwrap(),
            PathBuf::from("/tmp/ws/b.ts")
        );
        // The root itself is allowed.
        assert_eq!(
            resolve_inside_workspace(root, ".").unwrap(),
            PathBuf::from("/tmp/ws")
        );
    }

    #[test]
    fn resolve_inside_rejects_escapes() {
        let root = Path::new("/tmp/ws");
        assert!(resolve_inside_workspace(root, "../secret").is_err());
        assert!(resolve_inside_workspace(root, "a/../../escape").is_err());
        assert!(resolve_inside_workspace(root, "/etc/passwd").is_err());
        // Component-wise: /tmp/wsx is NOT inside /tmp/ws.
        assert!(resolve_inside_workspace(root, "/tmp/wsx").is_err());
        let e = resolve_inside_workspace(root, "../secret").unwrap_err();
        assert!(e.message.contains("outside the workspace root"));
    }

    #[test]
    fn follow_symlinks_rejects_escaping_link() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real/f.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", root.join("evil")).unwrap();

        assert!(resolve_and_follow_symlinks(&root, "real/f.txt").is_ok());
        #[cfg(unix)]
        {
            let err = resolve_and_follow_symlinks(&root, "evil/passwd").unwrap_err();
            assert!(err.message.contains("symlink"));
        }
    }

    #[test]
    fn follow_symlinks_allows_missing_target_for_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        std::fs::create_dir_all(&root).unwrap();
        let p = resolve_and_follow_symlinks(&root, "new/deep/file.ts").unwrap();
        assert_eq!(p, root.join("new/deep/file.ts"));
    }

    #[test]
    fn skill_root_resolution() {
        let home = home_dir().expect("HOME set in tests");
        let under = home.join(".claude/skills/x/SKILL.md");
        let under_str = under.display().to_string();
        assert!(is_under_skill_root(&under_str));
        let resolved = resolve_under_skill_root(&under_str).unwrap();
        // May canonicalize (e.g. /a/Users → /private/a on mac); stays a skill path.
        assert!(resolved.display().to_string().contains(".claude"));
        assert!(!is_under_skill_root("/etc/passwd"));
        assert!(!is_under_skill_root(&home.display().to_string()));
    }

    #[test]
    fn annex_roots_accept_absolute_store_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let annex = tmp.path().join("attachments");
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        std::fs::create_dir_all(&annex).unwrap();

        let target = annex.join("img.png").display().to_string();
        let resolved = resolve_inside_roots(&ws, &[annex.clone()], &target).unwrap();
        assert_eq!(resolved, annex.join("img.png"));

        // Symlink-following variant keeps the allowance: a link inside the
        // workspace pointing into the store resolves to the store file.
        std::fs::write(annex.join("img.png"), b"png").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, ws.join("sub/link.png")).unwrap();
        #[cfg(unix)]
        let followed =
            resolve_and_follow_symlinks_roots(&ws, &[annex.clone()], "sub/link.png").unwrap();
        #[cfg(unix)]
        assert!(followed.ends_with("img.png"));
    }

    #[test]
    fn annex_roots_reject_relative_and_outside_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let annex = tmp.path().join("attachments");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&annex).unwrap();

        // Relative targets are workspace vocabulary — never annex-resolved
        // (they resolve lexically inside the workspace instead).
        let resolved = resolve_inside_roots(&ws, &[annex.clone()], "img.png").unwrap();
        assert_eq!(resolved, ws.join("img.png"));
        // Escape attempts against the annex itself stay rejected.
        let escape = annex.join("../secret.txt").display().to_string();
        assert!(resolve_inside_roots(&ws, &[annex.clone()], &escape).is_err());
        // A path outside every root keeps the workspace error.
        assert!(resolve_inside_roots(&ws, &[annex], "/etc/passwd").is_err());
    }

    #[test]
    fn write_annex_accepts_absolute_library_paths_only() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let library = tmp.path().join("library");
        std::fs::create_dir_all(library.join("docs")).unwrap();

        // An absolute target inside the annex resolves.
        let doc = library.join("docs/kb.md").display().to_string();
        let resolved =
            resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &doc).unwrap();
        assert_eq!(resolved, library.join("docs/kb.md"));

        // Workspace targets are untouched by the annex grant: the same
        // absolute workspace path resolves identically with and without
        // the annex list (byte-identical inside-workspace behavior).
        let inside = ws.join("src/a.rs");
        std::fs::create_dir_all(ws.join("src")).unwrap();
        let inside = inside.display().to_string();
        assert_eq!(
            resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &inside).unwrap(),
            resolve_inside_workspace(&ws, &inside).unwrap()
        );

        // Relative targets NEVER reach the annex — even one spelling a
        // `../..` walk that would land beside it stays workspace-scoped
        // and is rejected as a workspace escape.
        let rel_walk = format!(
            "../../{}",
            library
                .join("docs/kb.md")
                .display()
                .to_string()
                .trim_start_matches('/')
        );
        let err = resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &rel_walk)
            .unwrap_err();
        assert!(err.message.contains("outside the workspace root"));
    }

    #[test]
    fn write_annex_rejects_sibling_and_outside_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let library = tmp.path().join("library");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&library).unwrap();

        // A sibling of the annex (same parent dir) is not the annex.
        let sibling = tmp.path().join("libraryx/secret.txt").display().to_string();
        assert!(
            resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &sibling).is_err()
        );
        // Escaping the annex itself stays rejected.
        let escape = library.join("../secret.txt").display().to_string();
        assert!(
            resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &escape).is_err()
        );
        // Far-outside targets keep the workspace error.
        assert!(resolve_inside_workspace_or_write_annexes(&ws, &[library], "/etc/passwd").is_err());
    }

    #[test]
    fn write_annex_rejects_symlink_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let library = tmp.path().join("library");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&library).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, library.join("evil")).unwrap();

        #[cfg(unix)]
        {
            // Existing target through the link → canonical target escapes.
            let existing = library.join("evil/secret.txt").display().to_string();
            let err = resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &existing)
                .unwrap_err();
            assert!(err.message.contains("symlink"), "{err:?}");
            // Brand-new file through the same link → the deepest existing
            // ancestor (the link itself) canonicalizes outside → rejected.
            let new_file = library.join("evil/pwned.md").display().to_string();
            assert!(
                resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &new_file)
                    .is_err()
            );
            // A dangling symlink at the target is refused outright —
            // fs::write would otherwise CREATE the escaped target.
            std::os::unix::fs::symlink(tmp.path().join("nowhere"), library.join("dangling.md"))
                .unwrap();
            let dangling = library.join("dangling.md").display().to_string();
            assert!(
                resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &dangling)
                    .is_err()
            );
            // A symlink INSIDE the annex pointing to another spot inside
            // the annex stays allowed (re-verification passes).
            std::fs::write(library.join("real.md"), "y").unwrap();
            std::os::unix::fs::symlink("real.md", library.join("alias.md")).unwrap();
            let alias = library.join("alias.md").display().to_string();
            let resolved =
                resolve_inside_workspace_or_write_annexes(&ws, &[library.clone()], &alias).unwrap();
            assert!(resolved.ends_with("real.md"));
        }
    }

    #[test]
    fn write_annex_allows_first_write_into_missing_annex() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let library = tmp.path().join("library");
        std::fs::create_dir_all(&ws).unwrap();
        // The library root itself doesn't exist yet — nothing in the
        // subtree can be a symlink, so the lexical resolution wins and
        // the caller's create_dir_all builds it.
        let doc = library.join("docs/first.md").display().to_string();
        let resolved = resolve_inside_workspace_or_write_annexes(&ws, &[library], &doc).unwrap();
        assert_eq!(resolved, tmp.path().join("library/docs/first.md"));
    }
}
