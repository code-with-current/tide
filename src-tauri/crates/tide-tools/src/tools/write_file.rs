//! write_file — port of `app/core/agent/tools/write-file.ts` (91ec558).
//! Create or fully replace a file (edit_file targets a unique match in an
//! existing file instead). Parent directories are created; a missing
//! workspace root fails loudly rather than resurrecting a deleted folder.

use std::path::Path;

use serde_json::json;

use crate::path_safety::resolve_inside_workspace;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::{arg_str};

const DESCRIPTION: &str = "Create a new file or fully replace an existing file's contents. For targeted changes to an existing file, prefer edit_file. The parent directory is created if it doesn't exist.";

pub struct WriteFileTool;

pub(crate) fn run_write_file(
    rel_path: &str,
    content: &str,
    workspace_root: &Path,
) -> ToolOutcome {
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
    ToolOutcome::executed(format!(
        "{verb} {rel_path} ({line_count} lines, {} bytes).",
        content.len()
    ))
    .with_display(ToolDisplay::Text {
        text: content.to_string(),
    })
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

    fn execute(&self, ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
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
        assert!(out.output.starts_with("Created src/new.ts (2 lines, 3 bytes)."));
        assert_eq!(out.meta.as_deref(), Some("2 lines · 3 bytes"));
        assert_eq!(std::fs::read_to_string(tmp.path().join("src/new.ts")).unwrap(), "a\nb");

        let out = run_write_file("src/new.ts", "z", tmp.path());
        assert!(out.output.starts_with("Overwrote src/new.ts (1 lines, 1 bytes)."));
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
        assert_eq!(std::fs::read_to_string(tmp.path().join("empty.txt")).unwrap(), "");
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
        assert!(matches!(out.display, Some(ToolDisplay::Text { .. })));
    }
}
