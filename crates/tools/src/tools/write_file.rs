//! write_file — port of `app/core/agent/tools/write-file.ts` ().
//! Create or fully replace a file (edit_file targets a unique match in an
//! existing file instead). Parent directories are created; a missing
//! workspace root fails loudly rather than resurrecting a deleted folder.

use std::path::Path;

use serde_json::json;

use crate::path_safety::resolve_inside_workspace;
use crate::permission::RiskTier;
use crate::{DiffLine, Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;
use super::edit_file::build_unified_diff;

const DESCRIPTION: &str = "Create a new file or fully replace an existing file's contents. For targeted changes to an existing file, prefer edit_file. The parent directory is created if it doesn't exist.";

pub struct WriteFileTool;

pub(crate) fn run_write_file(rel_path: &str, content: &str, workspace_root: &Path) -> ToolOutcome {
    if rel_path.is_empty() {
        return ToolOutcome::failed("Missing required arg: path");
    }

    // Refuse to write if the workspace root is missing — otherwise the
    // recursive mkdir below would silently resurrect a deleted workspace
    // and the agent would report success against a phantom dir.
    if !workspace_root.exists() {
        return ToolOutcome::failed(format!(
            "Workspace root does not exist: {}. The project folder may have been moved or deleted. Re-add the workspace or restore the folder.",
            workspace_root.display()
        ));
    }

    // resolve_inside (not follow_symlinks) so creating a file where nothing
    // exists yet doesn't trip canonicalize ENOENT.
    let abs = match resolve_inside_workspace(workspace_root, rel_path) {
        Ok(abs) => abs,
        Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
    };

    let existed = abs.exists();
    // Before/after for the diff body. A brand-new file diffs against "";
    // an unreadable (binary) original falls back to the plain-text card
    // rather than a misleading all-add diff.
    let original = if existed {
        std::fs::read_to_string(&abs).ok()
    } else {
        Some(String::new())
    };
    if let Some(parent) = abs.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return ToolOutcome::failed(format!("Write failed: {e}"));
        }
    }
    if let Err(e) = std::fs::write(&abs, content) {
        return ToolOutcome::failed(format!("Write failed: {e}"));
    }

    let line_count = content.split('\n').count();
    let verb = if existed { "Overwrote" } else { "Created" };
    let display = match original {
        Some(original) => {
            let hunks = build_unified_diff(&original, content, rel_path);
            let additions = hunks
                .iter()
                .flat_map(|h| &h.lines)
                .filter(|l| matches!(l, DiffLine::Add { .. }))
                .count() as u64;
            let deletions = hunks
                .iter()
                .flat_map(|h| &h.lines)
                .filter(|l| matches!(l, DiffLine::Del { .. }))
                .count() as u64;
            ToolDisplay::Diff {
                path: rel_path.to_string(),
                hunks,
                additions,
                deletions,
            }
        }
        None => ToolDisplay::Text {
            text: content.to_string(),
        },
    };
    ToolOutcome::executed(format!(
        "{verb} {rel_path} ({line_count} lines, {} bytes).",
        content.len()
    ))
    .with_display(display)
    .with_meta(format!("{line_count} lines · {} bytes", content.len()))
}

impl Tool for WriteFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "write_file".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path relative to workspace root." },
                    "content": { "type": "string", "description": "Full file contents to write." }
                },
                "required": ["path", "content"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::Write
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        let path = arg_str(&args, "path");
        let content = arg_str(&args, "content");
        Ok(run_write_file(&path, &content, &ctx.workspace_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_write_file("src/new.ts", "a\nb", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(out
            .output
            .starts_with("Created src/new.ts (2 lines, 3 bytes)."));
        assert_eq!(out.meta.as_deref(), Some("2 lines · 3 bytes"));
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("src/new.ts")).unwrap(),
            "a\nb"
        );

        let out = run_write_file("src/new.ts", "z", tmp.path());
        assert!(out
            .output
            .starts_with("Overwrote src/new.ts (1 lines, 1 bytes)."));
    }

    #[test]
    fn missing_path_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_write_file("", "x", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Missing required arg"));
    }

    #[test]
    fn missing_workspace_root_fails_loudly() {
        let tmp = tempfile::tempdir().unwrap();
        let ghost = tmp.path().join("ghost");
        let out = run_write_file("a.txt", "x", &ghost);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Workspace root does not exist"));
        assert!(!ghost.exists(), "must not resurrect the deleted root");
    }

    #[test]
    fn traversal_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_write_file("../outside.txt", "x", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Path error"));
        assert!(!tmp.path().parent().unwrap().join("outside.txt").exists());
    }

    #[test]
    fn empty_content_is_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_write_file("empty.txt", "", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("empty.txt")).unwrap(),
            ""
        );
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = WriteFileTool;
        assert_eq!(tool.spec().name, "write_file");
        assert_eq!(tool.risk_tier(), RiskTier::Write);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "path": "t.txt", "content": "body" }),
            )
            .unwrap();
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(matches!(out.display, Some(ToolDisplay::Diff { .. })));
    }

    #[test]
    fn new_file_diff_is_all_adds() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_write_file("new.txt", "a\nb\n", tmp.path());
        let Some(crate::ToolDisplay::Diff {
            path,
            hunks,
            additions,
            deletions,
        }) = out.display
        else {
            panic!("diff display, got {:?}", out.display);
        };
        assert_eq!(path, "new.txt");
        assert_eq!(deletions, 0, "brand-new file has no deletions: {hunks:?}");
        assert_eq!(additions, 3, "a, b and the trailing-newline empty line");
        assert!(
            hunks[0].header.starts_with("@@ -1,0 +1,"),
            "zero old lines: {}",
            hunks[0].header
        );
    }

    #[test]
    fn overwrite_diff_shows_before_and_after() {
        let tmp = tempfile::tempdir().unwrap();
        run_write_file("f.txt", "one\ntwo\nthree", tmp.path());
        let out = run_write_file("f.txt", "one\nTWO\nthree", tmp.path());
        let Some(crate::ToolDisplay::Diff {
            hunks,
            additions,
            deletions,
            ..
        }) = out.display
        else {
            panic!("diff display, got {:?}", out.display);
        };
        assert_eq!((additions, deletions), (1, 1));
        let texts: Vec<&str> = hunks
            .iter()
            .flat_map(|h| &h.lines)
            .map(|l| match l {
                crate::DiffLine::Add { text, .. }
                | crate::DiffLine::Del { text, .. }
                | crate::DiffLine::Context { text, .. }
                | crate::DiffLine::Hunk { text } => text.as_str(),
            })
            .collect();
        assert!(texts.contains(&"two"), "old line rides as del: {texts:?}");
        assert!(texts.contains(&"TWO"), "new line rides as add: {texts:?}");
    }
}
