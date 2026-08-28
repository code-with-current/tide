//! list_dir — port of `app/core/agent/tools/list-dir.ts` ().
//! Non-recursive directory listing (dirs first, alphabetical), capped at
//! 500 entries, surfaced to the renderer as a `file_list` display.

use serde_json::json;

use crate::path_safety::resolve_inside_workspace;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

const MAX_ENTRIES: usize = 500;

const DESCRIPTION: &str = "List the entries in a directory (non-recursive). Use this to discover the structure of a folder before reading specific files. Returns names and kinds (file/dir). Hidden entries (starting with .) are included.";

pub struct ListDirTool;

/// Dirs first, then files; alphabetical within each group (the TS
/// `localeCompare` approximated by case-insensitive order with the raw
/// bytes as tiebreak).
pub(crate) fn sort_entries(entries: &mut [(String, bool)]) {
    entries.sort_by(|(a_name, a_dir), (b_name, b_dir)| {
        a_dir
            .cmp(b_dir)
            .reverse()
            .then_with(|| a_name.to_lowercase().cmp(&b_name.to_lowercase()))
            .then_with(|| a_name.cmp(b_name))
    });
}

pub(crate) fn run_list_dir(rel_path: &str, workspace_root: &std::path::Path) -> ToolOutcome {
    let abs = match resolve_inside_workspace(workspace_root, rel_path) {
        Ok(abs) => abs,
        Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
    };

    let rd = match std::fs::read_dir(&abs) {
        Ok(rd) => rd,
        Err(e) => return ToolOutcome::failed(format!("Cannot read dir: {e}")),
    };

    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in rd.flatten() {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push((entry.file_name().to_string_lossy().into_owned(), is_dir));
    }
    sort_entries(&mut entries);

    let total = entries.len();
    let over_cap = total > MAX_ENTRIES;
    let shown = &entries[..total.min(MAX_ENTRIES)];

    let names: Vec<String> = shown
        .iter()
        .map(|(name, is_dir)| {
            if *is_dir {
                format!("{name}/")
            } else {
                name.clone()
            }
        })
        .collect();
    let note = if over_cap {
        format!("\n\n(truncated at {MAX_ENTRIES} entries; {total} total)")
    } else {
        String::new()
    };

    ToolOutcome::executed(format!("{}{}", names.join("\n"), note))
        .with_meta(format!("{total} entries"))
        .with_display(ToolDisplay::FileList { paths: names })
}

impl Tool for ListDirTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "list_dir".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path relative to workspace root. Defaults to root."
                    }
                },
                "required": []
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(&self, ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        Ok(run_list_dir(&arg_str(&args, "path"), &ctx.workspace_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    #[test]
    fn lists_dirs_first_then_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("zed")).unwrap();
        std::fs::create_dir(tmp.path().join("alpha")).unwrap();
        std::fs::write(tmp.path().join("beta.txt"), "x").unwrap();
        std::fs::write(tmp.path().join("gamma.ts"), "x").unwrap();

        let out = run_list_dir("", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            out.output,
            "alpha/\nzed/\nbeta.txt\ngamma.ts",
            "dirs first, alphabetical within groups"
        );
        assert_eq!(out.meta.as_deref(), Some("4 entries"));
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert_eq!(paths, vec!["alpha/", "zed/", "beta.txt", "gamma.ts"]);
    }

    #[test]
    fn hidden_entries_included() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".hidden"), "x").unwrap();
        let out = run_list_dir(".", tmp.path());
        assert!(out.output.contains(".hidden"));
    }

    #[test]
    fn empty_dir_lists_zero_entries() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("empty")).unwrap();
        let out = run_list_dir("empty", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.output, "");
        assert_eq!(out.meta.as_deref(), Some("0 entries"));
    }

    #[test]
    fn missing_dir_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_list_dir("ghost", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.contains("Cannot read dir"));
    }

    #[test]
    fn traversal_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_list_dir("../outside", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.contains("Path error"));
    }

    #[test]
    fn caps_at_500_entries_with_note() {
        let tmp = tempfile::tempdir().unwrap();
        let deep = tmp.path().join("many");
        std::fs::create_dir(&deep).unwrap();
        for i in 0..502 {
            std::fs::write(deep.join(format!("f{i:03}.txt")), "x").unwrap();
        }
        let out = run_list_dir("many", tmp.path());
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("(truncated at 500 entries; 502 total)"));
        assert_eq!(out.meta.as_deref(), Some("502 entries"));
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert_eq!(paths.len(), 500);
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x"), "1").unwrap();
        let tool = ListDirTool;
        assert_eq!(tool.spec().name, "list_dir");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(&ToolContext::new(tmp.path().to_path_buf()), json!({}))
            .unwrap();
        assert!(out.output.contains("x"));
    }
}
