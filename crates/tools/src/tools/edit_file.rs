//! edit_file — port of `app/core/agent/tools/edit-file.ts` ().
//! Replace a unique exact string match in a file; refuses (with all match
//! line numbers) when old_string isn't unique. Returns a minimal unified
//! diff for the UI card. Multi-line matches are EOL-bridged: an LF
//! old_string matches a CRLF file and vice versa (Windows autocrlf
//! checkouts), so callers never need to hand-escape \r\n.

use serde_json::json;

use crate::path_safety::resolve_and_follow_symlinks;
use crate::permission::RiskTier;
use crate::{DiffHunk, DiffLine, Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

const DESCRIPTION: &str = "Edit a file by replacing a unique exact string match. If old_string appears more than once, the call fails with the line numbers of all matches — provide more context in old_string to disambiguate. The file must already exist; use write_file for new files. Line endings are bridged automatically: an old_string with LF newlines matches CRLF files and vice versa, so never hand-escape \\r\\n.";

pub struct EditFileTool;

pub(crate) fn run_edit_file(
    rel_path: &str,
    old_str: &str,
    new_str: &str,
    workspace_root: &std::path::Path,
) -> ToolOutcome {
    if rel_path.is_empty() {
        return ToolOutcome::failed("Missing required arg: path");
    }
    if old_str.is_empty() {
        return ToolOutcome::failed("Missing required arg: old_string");
    }

    let abs = match resolve_and_follow_symlinks(workspace_root, rel_path) {
        Ok(abs) => abs,
        Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
    };

    let original = match std::fs::read_to_string(&abs) {
        Ok(s) => s,
        Err(e) => return ToolOutcome::failed(format!("Cannot read file: {e}")),
    };

    // Find all occurrences with their 1-based line numbers. Exact match
    // first; when that finds nothing, bridge LF↔CRLF (tool args carry LF
    // while autocrlf checkouts are CRLF) before declaring not-found.
    let not_found = format!(
        "old_string not found in {rel_path}. Check whitespace, indentation, and exact characters."
    );
    let mut occurrences = line_of_occurrences(&original, old_str);
    let (needle, replacement) = if occurrences.is_empty() {
        let Some((needle, replacement)) = eol_bridge(&original, old_str, new_str) else {
            return ToolOutcome::failed(not_found);
        };
        occurrences = line_of_occurrences(&original, &needle);
        if occurrences.is_empty() {
            return ToolOutcome::failed(not_found);
        }
        (needle, replacement)
    } else {
        (old_str.to_owned(), new_str.to_owned())
    };

    if occurrences.len() > 1 {
        let lines: Vec<String> = occurrences.iter().map(|l| l.to_string()).collect();
        return ToolOutcome::failed(format!(
            "old_string is not unique — matches at lines: {}. Add more surrounding context to old_string to make it unique.",
            lines.join(", ")
        ));
    }

    let updated = original.replacen(&needle, &replacement, 1);
    if let Err(e) = std::fs::write(&abs, &updated) {
        return ToolOutcome::failed(format!("Write failed: {e}"));
    }

    let hunks = build_unified_diff(&original, &updated, rel_path);
    let additions: u64 = hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| matches!(l, DiffLine::Add { .. }))
        .count() as u64;
    let deletions: u64 = hunks
        .iter()
        .flat_map(|h| &h.lines)
        .filter(|l| matches!(l, DiffLine::Del { .. }))
        .count() as u64;

    let display = ToolDisplay::Diff {
        path: rel_path.to_string(),
        hunks: hunks.clone(),
        additions,
        deletions,
    };
    // − is U+2212, matching the TS output byte-for-byte.
    ToolOutcome::executed(format!(
        "Edited {rel_path}: replaced 1 occurrence, +{additions} \u{2212}{deletions} lines."
    ))
    .with_meta(format!("+{additions} \u{2212}{deletions}"))
    .with_display(display)
}

/// All 1-based line numbers where `needle` occurs in `text` (overlapping
/// matches included — the original scan semantics).
pub(crate) fn line_of_occurrences(text: &str, needle: &str) -> Vec<usize> {
    let mut occurrences: Vec<usize> = Vec::new();
    let mut idx = text.find(needle);
    while let Some(i) = idx {
        occurrences.push(text[..i].split('\n').count());
        idx = text[i + 1..].find(needle).map(|next| i + 1 + next);
    }
    occurrences
}

/// Bridge the LF↔CRLF mismatch behind most spurious "old_string not
/// found" failures on Windows: tool args carry LF while autocrlf
/// checkouts are CRLF (and the reverse when a needle echoes read-back
/// CRLF into an LF file). Rewrites the needle/replacement pair into the
/// text's dominant line ending so untouched lines keep their bytes.
/// None when the needle already matches the file's style — the
/// not-found is genuine.
pub(crate) fn eol_bridge(text: &str, old_str: &str, new_str: &str) -> Option<(String, String)> {
    if !old_str.contains('\n') {
        return None;
    }
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    if crlf > lf {
        if old_str.contains('\r') {
            return None;
        }
        Some((old_str.replace('\n', "\r\n"), new_str.replace('\n', "\r\n")))
    } else if old_str.contains("\r\n") {
        Some((old_str.replace("\r\n", "\n"), new_str.replace("\r\n", "\n")))
    } else {
        None
    }
}

/// Build a minimal unified-diff view: one hunk with 3 lines of context
/// above/below the changed region. Ported literally from the TS
/// `buildUnifiedDiff` (including the trailing-context walk) so hunks match.
pub(crate) fn build_unified_diff(before: &str, after: &str, path: &str) -> Vec<DiffHunk> {
    // Empty text is ZERO lines, not one empty line — otherwise a new-file
    // diff (write_file) opens with a spurious `-` on a phantom empty line.
    let before_lines: Vec<&str> = if before.is_empty() {
        Vec::new()
    } else {
        before.split('\n').collect()
    };
    let after_lines: Vec<&str> = if after.is_empty() {
        Vec::new()
    } else {
        after.split('\n').collect()
    };

    let mut start_old: usize = 0;
    let max = before_lines.len().min(after_lines.len());
    while start_old < max && before_lines[start_old] == after_lines[start_old] {
        start_old += 1;
    }

    let mut end_old = before_lines.len() as i64 - 1;
    let mut end_new = after_lines.len() as i64 - 1;
    while end_old > start_old as i64
        && end_new > start_old as i64
        && before_lines[end_old as usize] == after_lines[end_new as usize]
    {
        end_old -= 1;
        end_new -= 1;
    }

    let ctx_start = start_old.saturating_sub(3);
    let header_old_no = ctx_start + 1;
    let header_new_no = ctx_start + 1;

    let mut trailing_ctx: Vec<&str> = Vec::new();
    let mut k = end_new;
    let mut j = end_old;
    while j > start_old as i64
        && k > start_old as i64
        && before_lines[j as usize] == after_lines[k as usize]
    {
        trailing_ctx.insert(0, after_lines[k as usize]);
        j -= 1;
        k -= 1;
    }
    let added_lines = &after_lines[start_old..(k + 1) as usize];

    let mut lines: Vec<DiffLine> = Vec::new();
    let header = format!(
        "@@ -{header_old_no},{} +{header_new_no},{} @@ {path}",
        end_old - ctx_start as i64 + 1,
        end_new - ctx_start as i64 + 1
    );
    lines.push(DiffLine::Hunk {
        text: header.clone(),
    });
    for (i, text) in before_lines
        .iter()
        .enumerate()
        .take(start_old)
        .skip(ctx_start)
    {
        lines.push(DiffLine::Context {
            old_no: Some(i as u64 + 1),
            new_no: Some(i as u64 + 1),
            text: text.to_string(),
        });
    }
    // Pure insertions can leave end_old below start_old — the TS loop then
    // runs zero iterations (no del lines at all).
    if end_old >= start_old as i64 {
        for (i, text) in before_lines
            .iter()
            .enumerate()
            .take(end_old as usize + 1)
            .skip(start_old)
        {
            lines.push(DiffLine::Del {
                old_no: Some(i as u64 + 1),
                text: text.to_string(),
            });
        }
    }
    for ln in added_lines {
        lines.push(DiffLine::Add {
            new_no: Some(0),
            text: (*ln).to_string(),
        });
    }
    for ln in &trailing_ctx {
        lines.push(DiffLine::Context {
            old_no: None,
            new_no: None,
            text: (*ln).to_string(),
        });
    }

    // The hunk `header` field repeats the @@ line without the first entry.
    vec![DiffHunk {
        header,
        lines: lines[1..].to_vec(),
    }]
}

impl Tool for EditFileTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "edit_file".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path relative to workspace root." },
                    "old_string": { "type": "string", "description": "Exact text to find (must be unique; LF/CRLF bridged automatically)." },
                    "new_string": { "type": "string", "description": "Text to replace it with." }
                },
                "required": ["path", "old_string", "new_string"]
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
        let old_string = arg_str(&args, "old_string");
        let new_string = arg_str(&args, "new_string");
        Ok(run_edit_file(
            &path,
            &old_string,
            &new_string,
            &ctx.workspace_root,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_unique_match() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.ts"), "const a = 1;\nconst b = 2;\n").unwrap();
        let out = run_edit_file("a.ts", "const a = 1;", "const a = 2;", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert!(out
            .output
            .starts_with("Edited a.ts: replaced 1 occurrence, +1 −1 lines."));
        assert_eq!(out.meta.as_deref(), Some("+1 −1"));
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.ts")).unwrap(),
            "const a = 2;\nconst b = 2;\n"
        );
        let ToolDisplay::Diff {
            path,
            additions,
            deletions,
            hunks,
        } = out.display.unwrap()
        else {
            panic!("diff display");
        };
        assert_eq!(path, "a.ts");
        assert_eq!((additions, deletions), (1, 1));
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].header.starts_with("@@ -1,"));
    }

    #[test]
    fn missing_args_fail() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(run_edit_file("", "a", "b", tmp.path())
            .output
            .contains("Missing required arg: path"));
        std::fs::write(tmp.path().join("x"), "y").unwrap();
        assert!(run_edit_file("x", "", "b", tmp.path())
            .output
            .contains("Missing required arg: old_string"));
    }

    #[test]
    fn not_found_and_not_unique_report_lines() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x.txt"), "foo\nbar\nfoo\nbaz\nfoo\n").unwrap();
        let out = run_edit_file("x.txt", "nope", "z", tmp.path());
        assert!(out.output.contains("old_string not found"));
        let out = run_edit_file("x.txt", "foo", "z", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("matches at lines: 1, 3, 5"));
        // File untouched on failure.
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("x.txt")).unwrap(),
            "foo\nbar\nfoo\nbaz\nfoo\n"
        );
    }

    #[test]
    fn missing_file_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_edit_file("ghost.txt", "a", "b", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Cannot read file"));
    }

    #[test]
    fn traversal_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_edit_file("../../etc/passwd", "a", "b", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Path error"));
    }

    #[test]
    fn diff_hunk_shape_matches_renderer_contract() {
        let before = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";
        let after = "l1\nl2\nl3\nl4\nL5-changed\nl6\nl7\nl8\n";
        let hunks = build_unified_diff(before, after, "f.txt");
        assert_eq!(hunks.len(), 1);
        let hunk = &hunks[0];
        assert_eq!(hunk.header, "@@ -2,4 +2,4 @@ f.txt");
        let kinds: Vec<&str> = hunk
            .lines
            .iter()
            .map(|l| match l {
                DiffLine::Context { .. } => "context",
                DiffLine::Add { .. } => "add",
                DiffLine::Del { .. } => "del",
                DiffLine::Hunk { .. } => "hunk",
            })
            .collect();
        // 3 context above, 1 del, 1 add, then trailing context per the TS walk.
        assert_eq!(kinds[0], "context");
        assert!(kinds.contains(&"del"));
        assert!(kinds.contains(&"add"));
        let v = serde_json::to_value(hunk).unwrap();
        assert!(v["header"].is_string());
        assert!(v["lines"].is_array());
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("t.txt"), "aaa").unwrap();
        let tool = EditFileTool;
        assert_eq!(tool.spec().name, "edit_file");
        assert_eq!(tool.risk_tier(), RiskTier::Write);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "path": "t.txt", "old_string": "aaa", "new_string": "bbb" }),
            )
            .unwrap();
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("t.txt")).unwrap(),
            "bbb"
        );
    }

    #[test]
    fn lf_old_string_edits_a_crlf_file_and_keeps_crlf() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("c.txt"), "alpha\r\nbeta\r\ngamma\r\n").unwrap();
        let out = run_edit_file("c.txt", "beta\ngamma", "BETA\nGAMMA", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("c.txt")).unwrap(),
            "alpha\r\nBETA\r\nGAMMA\r\n"
        );
    }

    #[test]
    fn crlf_old_string_edits_an_lf_file_and_keeps_lf() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("l.txt"), "one\ntwo\n").unwrap();
        let out = run_edit_file("l.txt", "one\r\ntwo", "ONE\r\nTWO", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("l.txt")).unwrap(),
            "ONE\nTWO\n"
        );
    }

    #[test]
    fn bridged_match_still_requires_uniqueness() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x.txt"), "a\r\nx\r\na\r\nx\r\n").unwrap();
        let out = run_edit_file("x.txt", "a\nx", "z", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("matches at lines: 1, 3"));
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("x.txt")).unwrap(),
            "a\r\nx\r\na\r\nx\r\n"
        );
    }

    #[test]
    fn no_bridge_for_single_line_needles_or_absent_text() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("c.txt"), "a\r\nb\r\n").unwrap();
        // No newline in the needle — nothing to bridge, genuine not-found.
        let out = run_edit_file("c.txt", "zzz", "z", tmp.path());
        assert!(out.output.contains("old_string not found"));
        // Present as a single line, so the exact match already worked:
        let out = run_edit_file("c.txt", "b", "B", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
    }
}
