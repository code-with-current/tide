//! read_file — port of `app/core/agent/tools/read-file.ts` (91ec558).
//! Reads a file from the workspace (sandboxed; skill-root fallback for
//! `~/.claude`/`~/.agent`/`~/.zcode` entries), capped at 256 KB / 2000
//! lines (maxLines overridable).

use serde_json::json;

use crate::path_safety::{resolve_and_follow_symlinks, resolve_under_skill_root};
use crate::permission::RiskTier;
use crate::{
    redact, Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec,
};

use super::{arg_str, arg_u64};

pub(crate) const DEFAULT_MAX_LINES: u64 = 2000;
pub(crate) const MAX_BYTES: u64 = 256 * 1024;

const DESCRIPTION: &str = "Read a file from the workspace. Returns its contents as text. Paths are relative to the workspace root. Files outside the root, Large files are capped at 2000 lines.";

pub struct ReadFileTool;

pub(crate) fn run_read_file(
    rel_path: &str,
    max_lines: u64,
    workspace_root: &std::path::Path,
) -> ToolOutcome {
    if rel_path.is_empty() {
        return ToolOutcome::failed("Missing required arg: path");
    }

    // Not inside the workspace → allow reads of skill/agent/context files
    // under ~/.claude | ~/.agent | ~/.zcode (trusted entries the user
    // invoked); anything else stays rejected (no arbitrary fs access).
    let abs = match resolve_and_follow_symlinks(workspace_root, rel_path) {
        Ok(abs) => abs,
        Err(e) => match resolve_under_skill_root(rel_path) {
            Ok(skill_abs) => skill_abs,
            Err(_) => return ToolOutcome::failed(format!("Path error: {e}")),
        },
    };

    let meta = match std::fs::metadata(&abs) {
        Ok(m) => m,
        Err(_) => {
            return ToolOutcome::failed(format!(
                "File not found: {rel_path} (resolved: {}; workspace root: {}). Use list_dir to see what's actually in the workspace.",
                abs.display(),
                workspace_root.display()
            ))
        }
    };
    if !meta.is_file() {
        return ToolOutcome::failed(format!(
            "Not a regular file: {rel_path} (resolved: {})",
            abs.display()
        ));
    }

    let size = meta.len();
    let byte_truncated = size > MAX_BYTES;

    let read = match read_prefix(&abs, MAX_BYTES) {
        Ok(b) => b,
        Err(e) => return ToolOutcome::failed(format!("Read failed: {e}")),
    };
    let mut content = String::from_utf8_lossy(&read).to_string();
    if content.starts_with('\u{feff}') {
        content = content.strip_prefix('\u{feff}').unwrap().to_string();
    }

    let all_lines: Vec<&str> = content.split('\n').collect();
    let total_lines = all_lines.len() as u64;
    let over_line_cap = total_lines > max_lines;
    if over_line_cap {
        content = all_lines[..max_lines as usize].join("\n");
    }

    let mut notes: Vec<String> = Vec::new();
    if byte_truncated {
        notes.push(format!(
            "truncated at {MAX_BYTES} bytes (file is {size} bytes)"
        ));
    }
    if over_line_cap {
        notes.push(format!(
            "truncated at {max_lines} lines (file has {total_lines})"
        ));
    }

    let meta_line = format!("{size} bytes · {total_lines} lines");
    let note_suffix = if notes.is_empty() {
        String::new()
    } else {
        format!("\n\n[{}]", notes.join("; "))
    };
    let display_text = format!("{content}{note_suffix}");

    ToolOutcome::executed(redact(content))
        .with_display(ToolDisplay::Text { text: display_text })
        .with_meta(meta_line)
}

/// Read up to `cap` bytes from the start of the file (partial read of the
/// first 256 KB for large files, like the TS `Buffer.alloc(min(size, cap))`).
fn read_prefix(path: &std::path::Path, cap: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let mut buf = Vec::with_capacity(cap.min(1 << 20) as usize);
    let mut taken = file.take(cap);
    taken.read_to_end(&mut buf)?;
    Ok(buf)
}

impl Tool for ReadFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read_file".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path relative to workspace root." },
                    "maxLines": { "type": "number", "description": "Maximum number of lines to return. Default 2000." }
                },
                "required": ["path"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(&self, ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        let path = arg_str(&args, "path");
        let max_lines = arg_u64(&args, "maxLines").unwrap_or(DEFAULT_MAX_LINES);
        Ok(run_read_file(&path, max_lines, &ctx.workspace_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(root: &std::path::Path) -> ToolContext {
        ToolContext::new(root.to_path_buf())
    }

    #[test]
    fn reads_file_with_content_and_meta() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "line1\nline2\n").unwrap();
        let out = run_read_file("a.txt", DEFAULT_MAX_LINES, tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(out.output, "line1\nline2\n");
        assert_eq!(out.meta.as_deref(), Some("12 bytes · 3 lines"));
        assert!(matches!(out.display, Some(ToolDisplay::Text { .. })));
    }

    #[test]
    fn strips_bom() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("bom.txt"), "\u{feff}hello").unwrap();
        let out = run_read_file("bom.txt", DEFAULT_MAX_LINES, tmp.path());
        assert_eq!(out.output, "hello");
    }

    #[test]
    fn missing_required_path_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_read_file("", DEFAULT_MAX_LINES, tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Missing required arg"));
    }

    #[test]
    fn missing_file_fails_with_resolution_hint() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_read_file("nope.txt", DEFAULT_MAX_LINES, tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("File not found"));
        assert!(out.output.contains("workspace root"));
    }

    #[test]
    fn directory_target_fails() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("dir")).unwrap();
        let out = run_read_file("dir", DEFAULT_MAX_LINES, tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Not a regular file"));
    }

    #[test]
    fn line_cap_truncates_and_notes() {
        let tmp = tempfile::tempdir().unwrap();
        let body = (0..50).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        std::fs::write(tmp.path().join("many.txt"), body).unwrap();
        let out = run_read_file("many.txt", 10, tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(out.output.matches('\n').count(), 9);
        assert_eq!(out.meta.as_deref(), Some("139 bytes · 50 lines"));
        let ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert!(text.contains("[truncated at 10 lines (file has 50)]"));
    }

    #[test]
    fn byte_cap_truncates() {
        let tmp = tempfile::tempdir().unwrap();
        let big = "x".repeat(MAX_BYTES as usize + 100);
        std::fs::write(tmp.path().join("big.txt"), &big).unwrap();
        let out = run_read_file("big.txt", DEFAULT_MAX_LINES, tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(out.output.len(), MAX_BYTES as usize);
        let ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert!(text.contains("truncated at 262144 bytes (file is 262244 bytes)"));
    }

    #[test]
    fn path_traversal_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        let rel = pathdiff(&outside.path().join("secret.txt"), tmp.path());
        let out = run_read_file(&rel, DEFAULT_MAX_LINES, tmp.path());
        assert!(out.output.contains("Path error") || out.output.contains("File not found"));
        assert_ne!(out.status, crate::OutcomeStatus::Executed);
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x.txt"), "hi").unwrap();
        let tool = ReadFileTool;
        let spec = tool.spec();
        assert_eq!(spec.name, "read_file");
        assert_eq!(spec.parameters["required"][0], "path");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(&ctx(tmp.path()), json!({ "path": "x.txt" }))
            .unwrap();
        assert_eq!(out.output, "hi");
    }

    /// Relative path from `to` to `from` (../../style) for traversal tests.
    fn pathdiff(from: &std::path::Path, to: &std::path::Path) -> String {
        let from_comps: Vec<_> = from.components().collect();
        let to_comps: Vec<_> = to.components().collect();
        let mut common = 0;
        while common < from_comps.len()
            && common < to_comps.len()
            && from_comps[common] == to_comps[common]
        {
            common += 1;
        }
        let ups = to_comps.len() - common;
        let mut parts: Vec<String> = (0..ups).map(|_| "..".to_string()).collect();
        for c in &from_comps[common..] {
            parts.push(c.as_os_str().to_string_lossy().to_string());
        }
        parts.join("/")
    }
}
