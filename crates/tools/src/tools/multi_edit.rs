//! multi_edit — port of `app/core/agent/tools/multi-edit.ts` ().
//! Applies an ordered batch of string-replacement edits to one file
//! atomically: every edit is validated/applied against the in-memory text
//! and the file is written once at the end, so any failing edit index
//! leaves the file untouched. Diffs come from the TS `buildMultiDiff`
//! (contiguous runs of differing lines, 3 lines of context, one hunk per
//! run — coarser than a real diff algorithm but enough for the UI).

use serde_json::json;

use crate::path_safety::resolve_and_follow_symlinks;
use crate::permission::RiskTier;
use crate::{DiffHunk, DiffLine, Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;
use super::edit_file::{eol_bridge, line_of_occurrences};

const DESCRIPTION: &str = "Apply multiple string-replacement edits to a single file in one atomic call. Each edit must have a unique old_string (same rule as edit_file). If any edit fails, the file is left unchanged and the call returns the failing edit index. Edits apply in order: earlier edits can change text that later edits match. Use this instead of N separate edit_file calls for multi-spot refactors. Line endings are bridged per edit, exactly like edit_file: LF old_strings match CRLF files and vice versa.";

pub struct MultiEditTool;

pub(crate) struct EditOp {
    pub(crate) old_string: String,
    pub(crate) new_string: String,
}

pub(crate) fn run_multi_edit(
    rel_path: &str,
    edits: &[EditOp],
    workspace_root: &std::path::Path,
) -> ToolOutcome {
    if rel_path.is_empty() {
        return ToolOutcome::failed("Missing required arg: path");
    }
    if edits.is_empty() {
        return ToolOutcome::failed("Missing or empty required arg: edits");
    }

    let abs = match resolve_and_follow_symlinks(workspace_root, rel_path) {
        Ok(abs) => abs,
        Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
    };

    let original = match std::fs::read_to_string(&abs) {
        Ok(s) => s,
        Err(e) => return ToolOutcome::failed(format!("Cannot read file: {e}")),
    };

    // Apply edits in order to the in-memory text; each old_string must be
    // unique *at apply time* (earlier edits may shift later matches).
    let mut current = original.clone();
    let mut applied: Vec<usize> = Vec::new();
    for (i, op) in edits.iter().enumerate() {
        if op.old_string.is_empty() {
            return ToolOutcome::failed(format!("Edit {i}: missing old_string. File unchanged."));
        }
        // Exact match first; bridge LF<->CRLF (LF args vs autocrlf
        // checkouts) before declaring not-found — same rule as edit_file.
        let not_found = format!(
            "Edit {i} ({}/{}): old_string not found. File unchanged. Check whitespace and indentation.",
            i + 1,
            edits.len()
        );
        let mut occurrences = line_of_occurrences(&current, &op.old_string);
        let (needle, replacement) = if occurrences.is_empty() {
            let Some((needle, replacement)) = eol_bridge(&current, &op.old_string, &op.new_string)
            else {
                return ToolOutcome::failed(not_found);
            };
            occurrences = line_of_occurrences(&current, &needle);
            if occurrences.is_empty() {
                return ToolOutcome::failed(not_found);
            }
            (needle, replacement)
        } else {
            (op.old_string.clone(), op.new_string.clone())
        };
        if occurrences.len() > 1 {
            let lines: Vec<String> = occurrences.iter().map(|l| l.to_string()).collect();
            return ToolOutcome::failed(format!(
                "Edit {i} ({}/{}): old_string not unique — matches at lines {}. Add more context. File unchanged.",
                i + 1,
                edits.len(),
                lines.join(", ")
            ));
        }
        current = current.replacen(&needle, &replacement, 1);
        applied.push(i);
    }

    if let Err(e) = std::fs::write(&abs, &current) {
        return ToolOutcome::failed(format!("Write failed: {e}"));
    }

    let hunks = build_multi_diff(&original, &current, rel_path);
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

    // − is U+2212, matching the TS output byte-for-byte.
    ToolOutcome::executed(format!(
        "Applied {} edits to {rel_path}: +{additions} \u{2212}{deletions} lines.",
        applied.len()
    ))
    .with_meta(format!(
        "{} edits · +{additions} \u{2212}{deletions}",
        applied.len()
    ))
    .with_display(ToolDisplay::Diff {
        path: rel_path.to_string(),
        hunks: hunks.clone(),
        additions,
        deletions,
    })
}

/// Build a diff with one hunk per contiguous run of differing lines — a
/// literal port of the TS `buildMultiDiff` (including the 3-line leading
/// context inside the main walk and the equal-lines-only trailing walk).
pub(crate) fn build_multi_diff(before: &str, after: &str, path: &str) -> Vec<DiffHunk> {
    let before_lines: Vec<&str> = before.split('\n').collect();
    let after_lines: Vec<&str> = after.split('\n').collect();
    let max_len = before_lines.len().max(after_lines.len());
    // Out-of-range on both sides counts as equal (TS: undefined !== undefined
    // is false); one-sided out-of-range counts as differing.
    let differs = |i: usize| before_lines.get(i) != after_lines.get(i);

    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut i = 0;
    while i < max_len {
        if !differs(i) {
            i += 1;
            continue;
        }
        let start = i;
        while i < max_len && differs(i) {
            i += 1;
        }
        let end = i - 1;
        let ctx_start = start.saturating_sub(3);
        let ctx_end = (max_len - 1).min(end + 3);

        let span = end - ctx_start + 1;
        let header = format!(
            "@@ -{},{} +{},{} @@ {path}",
            ctx_start + 1,
            span,
            ctx_start + 1,
            span
        );
        let mut lines: Vec<DiffLine> = Vec::new();
        for j in ctx_start..=end {
            if j < start {
                if let Some(text) = before_lines.get(j) {
                    lines.push(DiffLine::Context {
                        old_no: Some(j as u64 + 1),
                        new_no: Some(j as u64 + 1),
                        text: text.to_string(),
                    });
                }
            } else {
                if let Some(text) = before_lines.get(j) {
                    lines.push(DiffLine::Del {
                        old_no: Some(j as u64 + 1),
                        text: text.to_string(),
                    });
                }
                if let Some(text) = after_lines.get(j) {
                    lines.push(DiffLine::Add {
                        new_no: Some(j as u64 + 1),
                        text: text.to_string(),
                    });
                }
            }
        }
        for j in (end + 1)..=ctx_end {
            if let (Some(b), Some(a)) = (before_lines.get(j), after_lines.get(j)) {
                if b == a {
                    lines.push(DiffLine::Context {
                        old_no: Some(j as u64 + 1),
                        new_no: Some(j as u64 + 1),
                        text: b.to_string(),
                    });
                }
            }
        }
        hunks.push(DiffHunk { header, lines });
    }
    hunks
}

fn parse_edits(args: &serde_json::Value) -> Vec<EditOp> {
    let Some(arr) = args.get("edits").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .map(|e| EditOp {
            old_string: e
                .get("old_string")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            new_string: e
                .get("new_string")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        })
        .collect()
}

impl Tool for MultiEditTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "multi_edit".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path relative to workspace root." },
                    "edits": {
                        "type": "array",
                        "description": "Ordered list of edits to apply.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_string": {
                                    "type": "string",
                                    "description": "Exact text to find (must be unique at apply time; LF/CRLF bridged automatically)."
                                },
                                "new_string": {
                                    "type": "string",
                                    "description": "Replacement text."
                                }
                            },
                            "required": ["old_string", "new_string"]
                        }
                    }
                },
                "required": ["path", "edits"]
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
        Ok(run_multi_edit(
            &arg_str(&args, "path"),
            &parse_edits(&args),
            &ctx.workspace_root,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    fn op(old: &str, new: &str) -> EditOp {
        EditOp {
            old_string: old.to_string(),
            new_string: new.to_string(),
        }
    }

    #[test]
    fn applies_ordered_edits_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("a.ts"),
            "const a = 1;\nconst b = 2;\nconst c = 3;\n",
        )
        .unwrap();
        let out = run_multi_edit(
            "a.ts",
            &[
                op("const a = 1;", "const a = 10;"),
                op("const c = 3;", "const c = 30;"),
            ],
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.ts")).unwrap(),
            "const a = 10;\nconst b = 2;\nconst c = 30;\n"
        );
        assert_eq!(out.output, "Applied 2 edits to a.ts: +2 \u{2212}2 lines.");
        assert_eq!(out.meta.as_deref(), Some("2 edits · +2 −2"));
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
        assert_eq!((additions, deletions), (2, 2));
        // Two separate change regions → two hunks.
        assert_eq!(hunks.len(), 2);
        assert!(hunks[0].header.starts_with("@@ -1,"));
    }

    #[test]
    fn one_bad_edit_leaves_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let original = "alpha\nbeta\ngamma\n";
        std::fs::write(tmp.path().join("x.txt"), original).unwrap();
        let out = run_multi_edit(
            "x.txt",
            &[op("alpha", "ALPHA"), op("nope", "X"), op("gamma", "GAMMA")],
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            "Edit 1 (2/3): old_string not found. File unchanged. Check whitespace and indentation."
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("x.txt")).unwrap(),
            original
        );
    }

    #[test]
    fn non_unique_edit_reports_all_match_lines_and_skips_write() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x.txt"), "foo\nbar\nfoo\n").unwrap();
        let out = run_multi_edit("x.txt", &[op("foo", "z"), op("bar", "y")], tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            "Edit 0 (1/2): old_string not unique — matches at lines 1, 3. Add more context. File unchanged."
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("x.txt")).unwrap(),
            "foo\nbar\nfoo\n"
        );
    }

    #[test]
    fn later_edit_matches_text_created_by_earlier_edit() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("c.txt"), "one two\n").unwrap();
        // Edit 1 renames a token; edit 2 edits the renamed text.
        let out = run_multi_edit(
            "c.txt",
            &[op("two", "three"), op("one three", "1 3")],
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("c.txt")).unwrap(),
            "1 3\n"
        );
    }

    #[test]
    fn missing_args_fail() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_multi_edit("", &[], tmp.path());
        assert!(out.output.contains("Missing required arg: path"));
        std::fs::write(tmp.path().join("e.txt"), "x").unwrap();
        let out = run_multi_edit("e.txt", &[], tmp.path());
        assert!(out.output.contains("Missing or empty required arg: edits"));
        let out = run_multi_edit("e.txt", &[op("", "y")], tmp.path());
        assert_eq!(out.output, "Edit 0: missing old_string. File unchanged.");
    }

    #[test]
    fn diff_hunks_shape() {
        let before = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let after = "a\nb\nC\nd\ne\nf\nG\nh\n";
        let hunks = build_multi_diff(before, after, "f.txt");
        assert_eq!(hunks.len(), 2, "{hunks:#?}");
        assert_eq!(hunks[0].header, "@@ -1,3 +1,3 @@ f.txt");
        let kinds: Vec<&str> = hunks[0]
            .lines
            .iter()
            .map(|l| match l {
                DiffLine::Context { .. } => "context",
                DiffLine::Add { .. } => "add",
                DiffLine::Del { .. } => "del",
                DiffLine::Hunk { .. } => "hunk",
            })
            .collect();
        // Change at line 3 (start=2, ctxStart=0): lines 1-2 leading context,
        // del+add at 3, then equal trailing context through ctxEnd (line 6).
        assert_eq!(
            kinds,
            vec!["context", "context", "del", "add", "context", "context", "context"]
        );
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("t.txt"), "aaa\n").unwrap();
        let tool = MultiEditTool;
        assert_eq!(tool.spec().name, "multi_edit");
        assert_eq!(tool.risk_tier(), RiskTier::Write);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({
                    "path": "t.txt",
                    "edits": [{ "old_string": "aaa", "new_string": "bbb" }]
                }),
            )
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("t.txt")).unwrap(),
            "bbb\n"
        );
    }

    #[test]
    fn lf_edits_apply_to_a_crlf_file_and_keep_crlf() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("a.ts"),
            "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n",
        )
        .unwrap();
        let out = run_multi_edit(
            "a.ts",
            &[
                op("const a = 1;\nconst b = 2;", "const a = 10;\nconst b = 20;"),
                op("const c = 3;", "const c = 30;"),
            ],
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.ts")).unwrap(),
            "const a = 10;\r\nconst b = 20;\r\nconst c = 30;\r\n"
        );
    }

    #[test]
    fn bridged_failure_leaves_crlf_file_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x.txt"), "alpha\r\nbeta\r\n").unwrap();
        let out = run_multi_edit(
            "x.txt",
            &[op("alpha\nbeta", "ALPHA\nBETA"), op("nope", "X")],
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            "Edit 1 (2/2): old_string not found. File unchanged. Check whitespace and indentation."
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("x.txt")).unwrap(),
            "alpha\r\nbeta\r\n"
        );
    }
}
