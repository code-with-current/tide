//! directory_tree — port of `app/core/agent/tools/directory-tree.ts`
//! (). Recursive tree view formatted like the `tree` command
//! (dirs-first ordering, `├──`/`└──` connectors, dirs suffixed `/`),
//! bounded at depth 10 / 2000 entries. No display payload — the TS emitted
//! plain text output only.

use serde_json::json;

use crate::path_safety::resolve_inside_roots;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;
use super::list_dir::sort_entries;

const MAX_DEPTH: usize = 10;
const MAX_ENTRIES: usize = 2000;

const DESCRIPTION: &str = "Get a recursive tree view of files and directories as JSON. Use for understanding project structure at a glance. Respects workspace boundaries. Max depth 10, max 2000 entries.";

pub struct DirectoryTreeTool;

struct TreeNode {
    name: String,
    is_dir: bool,
    children: Vec<TreeNode>,
}

pub(crate) fn run_directory_tree(
    rel_path: &str,
    workspace_root: &std::path::Path,
    extra_read_roots: &[std::path::PathBuf],
) -> ToolOutcome {
    let abs = match resolve_inside_roots(workspace_root, extra_read_roots, rel_path) {
        Ok(abs) => abs,
        Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
    };

    // Read failures inside the walk yield empty children (TS `buildTree`
    // swallowed readdir errors); only resolution errors fail the call.
    let mut entry_count: usize = 0;
    let mut truncated = false;
    let tree = build_tree(&abs, 0, &mut entry_count, &mut truncated);

    let note = if truncated {
        format!("\n\n(truncated at {MAX_ENTRIES} entries)")
    } else {
        String::new()
    };
    ToolOutcome::executed(format!("{}{}", format_tree(&tree), note))
        .with_meta(format!("{entry_count} entries"))
}

fn build_tree(
    dir: &std::path::Path,
    depth: usize,
    entry_count: &mut usize,
    truncated: &mut bool,
) -> Vec<TreeNode> {
    if depth >= MAX_DEPTH || *truncated {
        return Vec::new();
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<(String, bool)> = rd
        .flatten()
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (e.file_name().to_string_lossy().into_owned(), is_dir)
        })
        .collect();
    sort_entries(&mut entries);

    let mut nodes: Vec<TreeNode> = Vec::new();
    for (name, is_dir) in entries {
        if *entry_count >= MAX_ENTRIES {
            *truncated = true;
            break;
        }
        *entry_count += 1;
        let children = if is_dir {
            build_tree(&dir.join(&name), depth + 1, entry_count, truncated)
        } else {
            Vec::new()
        };
        nodes.push(TreeNode {
            name,
            is_dir,
            children,
        });
    }
    nodes
}

/// Indented `tree`-style rendering: `├── `/`└── ` connectors, `│   ` and
/// `    ` continuation prefixes, dirs end with `/`.
fn format_tree(nodes: &[TreeNode]) -> String {
    let mut lines: Vec<String> = Vec::new();
    walk_all(nodes, "", &mut lines);
    lines.join("\n")
}

fn walk_all(nodes: &[TreeNode], prefix: &str, lines: &mut Vec<String>) {
    for (i, node) in nodes.iter().enumerate() {
        let is_last = i == nodes.len() - 1;
        let connector = if is_last { "└── " } else { "├── " };
        let suffix = if node.is_dir { "/" } else { "" };
        lines.push(format!("{prefix}{connector}{}{suffix}", node.name));
        let child_prefix = format!("{prefix}{}", if is_last { "    " } else { "│   " });
        walk_all(&node.children, &child_prefix, lines);
    }
}

impl Tool for DirectoryTreeTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "directory_tree".into(),
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

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        Ok(run_directory_tree(
            &arg_str(&args, "path"),
            &ctx.workspace_root,
            &ctx.extra_read_roots,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    #[test]
    fn renders_tree_with_connectors_and_dir_suffix() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src/lib")).unwrap();
        std::fs::write(tmp.path().join("src/lib/util.ts"), "x").unwrap();
        std::fs::write(tmp.path().join("src/main.ts"), "x").unwrap();
        std::fs::write(tmp.path().join("package.json"), "{}").unwrap();

        let out = run_directory_tree("", tmp.path(), &[]);
        assert_eq!(out.status, OutcomeStatus::Executed);
        let expected = "\
├── src/
│   ├── lib/
│   │   └── util.ts
│   └── main.ts
└── package.json";
        assert_eq!(out.output, expected);
        // 5 entries: src + its 3 descendants + package.json.
        assert_eq!(out.meta.as_deref(), Some("5 entries"));
    }

    #[test]
    fn subpath_rooted_tree() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("a/b")).unwrap();
        std::fs::write(tmp.path().join("a/b/c.txt"), "x").unwrap();
        let out = run_directory_tree("a", tmp.path(), &[]);
        assert_eq!(out.output, "└── b/\n    └── c.txt");
        assert_eq!(out.meta.as_deref(), Some("2 entries"));
    }

    #[test]
    fn depth_capped_at_ten() {
        let tmp = tempfile::tempdir().unwrap();
        let mut dir = tmp.path().to_path_buf();
        for i in 0..15 {
            dir = dir.join(format!("d{i}"));
            std::fs::create_dir(&dir).unwrap();
        }
        std::fs::write(dir.join("deep.txt"), "x").unwrap();
        let out = run_directory_tree("", tmp.path(), &[]);
        // 10 nested dirs render (d0..d9); deeper levels are cut off.
        assert_eq!(out.output.lines().count(), 10, "output:\n{}", out.output);
        assert!(out.output.contains("d9/"));
        assert!(!out.output.contains("d10/"));
        assert!(!out.output.contains("deep.txt"));
        assert_eq!(out.meta.as_deref(), Some("10 entries"));
    }

    #[test]
    fn entry_cap_truncates() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..2050 {
            std::fs::write(tmp.path().join(format!("f{i:04}")), "x").unwrap();
        }
        let out = run_directory_tree("", tmp.path(), &[]);
        assert!(out.output.contains("(truncated at 2000 entries)"));
        assert_eq!(out.meta.as_deref(), Some("2000 entries"));
        // 2000 tree lines + the blank line from the "\n\n" note separator.
        assert_eq!(out.output.lines().count(), 2002);
    }

    #[test]
    fn missing_dir_renders_empty_like_ts() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_directory_tree("ghost", tmp.path(), &[]);
        // TS swallowed readdir failures inside buildTree: executed, empty.
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.output, "");
        assert_eq!(out.meta.as_deref(), Some("0 entries"));
    }

    #[test]
    fn traversal_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_directory_tree("..", tmp.path(), &[]);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.contains("Path error"));
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("x"), "1").unwrap();
        let tool = DirectoryTreeTool;
        assert_eq!(tool.spec().name, "directory_tree");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "path": "" }),
            )
            .unwrap();
        assert!(out.output.contains("x"));
    }
}
