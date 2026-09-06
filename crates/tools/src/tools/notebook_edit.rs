//! notebook_edit — port of `app/core/agent/tools/notebook-edit.ts` ().
//! Edits Jupyter (.ipynb) cells by index through serde_json: the model
//! passes `source` as a plain string, the tool splits it into the array-of-
//! lines shape real notebooks use (trailing `\n` on every line but the
//! last). Modes: replace / insert / delete / append.
//!
//! Serialization notes vs TS `JSON.stringify(nb, null, 1)`: object keys come
//! out alphabetically (serde_json's BTree-backed Value) rather than in
//! insertion order — semantically neutral for .ipynb consumers.

use serde::Serialize;
use serde_json::json;

use crate::path_safety::resolve_and_follow_symlinks;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

const DESCRIPTION: &str = "Edit a Jupyter notebook (.ipynb) cell by index. Handles the JSON shape so the source can be provided as a plain string. Modes: replace (overwrite cell), insert (add before index), delete (remove cell), append (add at end). New cells default to code type unless cell_type is specified.";

pub struct NotebookEditTool;

/// Jupyter source keeps trailing newlines on every line except the last.
fn source_as_array(s: &str) -> Vec<String> {
    let lines: Vec<&str> = s.split('\n').collect();
    let last = lines.len() - 1;
    lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| {
            if i < last {
                format!("{line}\n")
            } else {
                line.to_string()
            }
        })
        .collect()
}

fn new_cell(cell_type: &str, source: Option<&str>) -> serde_json::Value {
    let mut cell = json!({
        "cell_type": cell_type,
        "metadata": {},
        "source": source.map(source_as_array).unwrap_or_default(),
    });
    // Code cells carry execution_count/outputs so viewers don't choke.
    if cell_type == "code" {
        cell["execution_count"] = json!(null);
        cell["outputs"] = json!([]);
    }
    cell
}

pub(crate) fn run_notebook_edit(
    rel_path: &str,
    mode: &str,
    cell_type: &str,
    source: Option<&str>,
    cell_index: i64,
    workspace_root: &std::path::Path,
) -> ToolOutcome {
    if rel_path.is_empty() {
        return ToolOutcome::failed("Missing required arg: path");
    }
    if !rel_path.ends_with(".ipynb") {
        return ToolOutcome::failed(format!("Path must end in .ipynb (got: {rel_path})"));
    }
    if matches!(mode, "replace" | "insert" | "append") && source.is_none() {
        return ToolOutcome::failed(format!("source is required for mode=\"{mode}\""));
    }
    if matches!(mode, "replace" | "insert" | "delete") && cell_index < 0 {
        return ToolOutcome::failed(format!("cell_index is required for mode=\"{mode}\""));
    }

    let abs = match resolve_and_follow_symlinks(workspace_root, rel_path) {
        Ok(abs) => abs,
        Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
    };

    let raw = match std::fs::read_to_string(&abs) {
        Ok(s) => s,
        Err(e) => return ToolOutcome::failed(format!("Cannot read notebook: {e}")),
    };
    let mut nb: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return ToolOutcome::failed(format!("Cannot read notebook: {e}")),
    };
    let Some(cells) = nb.get_mut("cells").and_then(|c| c.as_array_mut()) else {
        return ToolOutcome::failed("Notebook has no cells array — malformed .ipynb");
    };

    let idx = cell_index as usize;
    let action: String = match mode {
        "replace" => {
            if idx >= cells.len() {
                return ToolOutcome::failed(format!(
                    "cell_index {cell_index} out of range (have {} cells)",
                    cells.len()
                ));
            }
            cells[idx] = new_cell(cell_type, source);
            format!("replaced cell {cell_index}")
        }
        "insert" => {
            if idx > cells.len() {
                return ToolOutcome::failed(format!(
                    "cell_index {cell_index} out of range (have {} cells)",
                    cells.len()
                ));
            }
            cells.insert(idx, new_cell(cell_type, source));
            format!("inserted cell at {cell_index}")
        }
        "delete" => {
            if idx >= cells.len() {
                return ToolOutcome::failed(format!(
                    "cell_index {cell_index} out of range (have {} cells)",
                    cells.len()
                ));
            }
            cells.remove(idx);
            format!("deleted cell {cell_index}")
        }
        "append" => {
            cells.push(new_cell(cell_type, source));
            format!("appended cell at {}", cells.len() - 1)
        }
        _ => return ToolOutcome::failed(format!("Unknown edit_mode: {mode}")),
    };

    let rendered = to_string_indent_1(&nb);
    if let Err(e) = std::fs::write(&abs, rendered) {
        return ToolOutcome::failed(format!("Write failed: {e}"));
    }

    let count = nb
        .get("cells")
        .and_then(|c| c.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    ToolOutcome::executed(format!(
        "Edited {rel_path}: {action}. Notebook now has {count} cells."
    ))
    .with_meta(format!("{count} cells"))
}

/// `JSON.stringify(nb, null, 1)` — serde's pretty printer with a 1-space
/// indent instead of the default 2.
fn to_string_indent_1(v: &serde_json::Value) -> String {
    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(
        &mut buf,
        serde_json::ser::PrettyFormatter::with_indent(b" "),
    );
    v.serialize(&mut ser)
        .expect("Value serialization is infallible");
    let mut out = String::from_utf8(buf).expect("serde emits valid UTF-8");
    out.push('\n');
    out
}

impl Tool for NotebookEditTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "notebook_edit".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the .ipynb file, relative to workspace root."
                    },
                    "cell_index": {
                        "type": "number",
                        "description": "0-based cell index. Required for replace/insert/delete; ignored for append."
                    },
                    "cell_type": {
                        "type": "string",
                        "enum": ["code", "markdown", "raw"],
                        "description": "Type for new/inserted cells. Defaults to code."
                    },
                    "edit_mode": {
                        "type": "string",
                        "enum": ["replace", "insert", "delete", "append"],
                        "description": "How to apply the edit. Defaults to replace."
                    },
                    "source": {
                        "type": "string",
                        "description": "New cell source as a string. Required for replace/insert/append."
                    }
                },
                "required": ["path", "edit_mode"]
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
        let mode = arg_str(&args, "edit_mode");
        let mode = if mode.is_empty() {
            "replace".to_string()
        } else {
            mode
        };
        let cell_type = {
            let ct = arg_str(&args, "cell_type");
            if ct.is_empty() {
                "code".to_string()
            } else {
                ct
            }
        };
        let source = args.get("source").and_then(|v| v.as_str());
        let cell_index = args
            .get("cell_index")
            .and_then(|v| v.as_i64())
            .unwrap_or(-1);
        Ok(run_notebook_edit(
            &arg_str(&args, "path"),
            &mode,
            &cell_type,
            source,
            cell_index,
            &ctx.workspace_root,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    fn notebook(cells: usize) -> String {
        let cells: Vec<String> = (0..cells)
            .map(|i| format!("{{\"cell_type\":\"code\",\"metadata\":{{}},\"source\":[\"cell {i}\\n\"],\"outputs\":[],\"execution_count\":null}}"))
            .collect();
        format!(
            "{{\"cells\":[{}],\"metadata\":{{}},\"nbformat\":4,\"nbformat_minor\":5}}",
            cells.join(",")
        )
    }

    #[test]
    fn round_trip_replace_keeps_shape_and_splits_source() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("n.ipynb"), notebook(2)).unwrap();
        let out = run_notebook_edit(
            "n.ipynb",
            "replace",
            "code",
            Some("line one\nline two"),
            0,
            tmp.path(),
        );
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            out.output,
            "Edited n.ipynb: replaced cell 0. Notebook now has 2 cells."
        );
        assert_eq!(out.meta.as_deref(), Some("2 cells"));

        let nb: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path().join("n.ipynb")).unwrap())
                .unwrap();
        assert_eq!(nb["cells"][0]["source"], json!(["line one\n", "line two"]));
        assert_eq!(nb["cells"][0]["execution_count"], json!(null));
        assert_eq!(nb["cells"][0]["outputs"], json!([]));
        // Untouched cell survives.
        assert_eq!(nb["cells"][1]["source"], json!(["cell 1\n"]));
        assert_eq!(nb["nbformat"], json!(4));
        // 1-space indent, trailing newline (JSON.stringify(nb, null, 1)+'\n').
        let raw = std::fs::read_to_string(tmp.path().join("n.ipynb")).unwrap();
        assert!(raw.ends_with("}\n"));
        assert!(raw.contains("\n \"cells\": ["));
    }

    #[test]
    fn insert_delete_append() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("n.ipynb"), notebook(2)).unwrap();

        let out = run_notebook_edit("n.ipynb", "insert", "markdown", Some("# hi"), 1, tmp.path());
        assert!(out.output.contains("inserted cell at 1"));
        let out = run_notebook_edit("n.ipynb", "append", "raw", Some("log line"), -1, tmp.path());
        assert!(out.output.contains("appended cell at 3"));
        let out = run_notebook_edit("n.ipynb", "delete", "code", None, 0, tmp.path());
        assert!(out.output.contains("deleted cell 0"));
        assert!(out.output.contains("now has 3 cells"));

        let nb: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path().join("n.ipynb")).unwrap())
                .unwrap();
        assert_eq!(nb["cells"].as_array().unwrap().len(), 3);
        assert_eq!(nb["cells"][0]["cell_type"], json!("markdown"));
        assert_eq!(nb["cells"][0]["source"], json!(["# hi"]));
        assert_eq!(nb["cells"][2]["cell_type"], json!("raw"));
    }

    #[test]
    fn code_cell_defaults_and_normalization() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("n.ipynb"), notebook(1)).unwrap();
        run_notebook_edit("n.ipynb", "append", "code", Some("x = 1"), -1, tmp.path());
        let nb: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.path().join("n.ipynb")).unwrap())
                .unwrap();
        let cell = &nb["cells"][1];
        assert_eq!(cell["cell_type"], json!("code"));
        assert_eq!(cell["execution_count"], json!(null));
        assert_eq!(cell["outputs"], json!([]));
        assert_eq!(cell["source"], json!(["x = 1"]));
    }

    #[test]
    fn validation_errors_match_ts_text() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("n.ipynb"), notebook(1)).unwrap();

        let out = run_notebook_edit("", "replace", "code", Some("x"), 0, tmp.path());
        assert_eq!(out.output, "Missing required arg: path");
        let out = run_notebook_edit("n.txt", "replace", "code", Some("x"), 0, tmp.path());
        assert_eq!(out.output, "Path must end in .ipynb (got: n.txt)");
        let out = run_notebook_edit("n.ipynb", "replace", "code", None, 0, tmp.path());
        assert_eq!(out.output, "source is required for mode=\"replace\"");
        let out = run_notebook_edit("n.ipynb", "delete", "code", None, -1, tmp.path());
        assert_eq!(out.output, "cell_index is required for mode=\"delete\"");
        let out = run_notebook_edit("n.ipynb", "replace", "code", Some("x"), 5, tmp.path());
        assert_eq!(out.output, "cell_index 5 out of range (have 1 cells)");
        // insert at len is allowed; beyond is not.
        let out = run_notebook_edit("n.ipynb", "insert", "code", Some("x"), 2, tmp.path());
        assert_eq!(out.output, "cell_index 2 out of range (have 1 cells)");
    }

    #[test]
    fn malformed_notebooks_fail() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("bad.ipynb"), "not json").unwrap();
        let out = run_notebook_edit("bad.ipynb", "append", "code", Some("x"), -1, tmp.path());
        assert!(out.output.starts_with("Cannot read notebook:"));

        std::fs::write(tmp.path().join("nocells.ipynb"), "{\"nbformat\":4}").unwrap();
        let out = run_notebook_edit("nocells.ipynb", "append", "code", Some("x"), -1, tmp.path());
        assert_eq!(out.output, "Notebook has no cells array — malformed .ipynb");

        let out = run_notebook_edit("ghost.ipynb", "append", "code", Some("x"), -1, tmp.path());
        assert!(out.output.starts_with("Cannot read notebook:"));
    }

    #[test]
    fn traversal_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let out = run_notebook_edit("../n.ipynb", "append", "code", Some("x"), -1, tmp.path());
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert!(out.output.contains("Path error"));
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("t.ipynb"), notebook(1)).unwrap();
        let tool = NotebookEditTool;
        assert_eq!(tool.spec().name, "notebook_edit");
        assert_eq!(tool.risk_tier(), RiskTier::Write);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "path": "t.ipynb", "edit_mode": "append", "source": "new" }),
            )
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("appended cell at 1"));
    }
}
