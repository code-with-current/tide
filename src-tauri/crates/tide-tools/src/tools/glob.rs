//! glob — port of `app/core/agent/tools/glob.ts` (). Find files by
//! pattern (`*`, `**`, `?`, `[abc]`), capped at 200 results, ignoring the
//! common build/dependency dirs. Returns workspace-relative, forward-slash
//! paths.

use std::path::Path;

use regex::Regex;
use serde_json::json;

use crate::path_safety::resolve_and_follow_symlinks;
use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

pub(crate) const MAX_RESULTS: usize = 200;
const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "dist-electron",
    "release",
    ".next",
    ".cache",
];

const DESCRIPTION: &str = "Find files matching a glob pattern. Supports * (single segment), ** (any depth), ? (single char), and [abc] (char class). Returns up to 200 paths relative to the workspace root. Ignores node_modules/.git/dist by default. Faster than list_dir when you know the extension or naming pattern.";

pub struct GlobTool;

pub(crate) fn run_glob(pattern: &str, rel_path: &str, workspace_root: &Path) -> ToolOutcome {
    if pattern.is_empty() {
        return ToolOutcome::failed("Missing required arg: pattern");
    }

    let root = if rel_path.is_empty() {
        workspace_root.to_path_buf()
    } else {
        match resolve_and_follow_symlinks(workspace_root, rel_path) {
            Ok(root) => root,
            Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
        }
    };

    let meta = match std::fs::metadata(&root) {
        Ok(m) => m,
        Err(_) => {
            return ToolOutcome::failed(format!(
                "Directory not found: {}",
                if rel_path.is_empty() { "(root)" } else { rel_path }
            ))
        }
    };
    if !meta.is_dir() {
        return ToolOutcome::failed(format!(
            "Not a directory: {}",
            if rel_path.is_empty() { "(root)" } else { rel_path }
        ));
    }

    let regex = glob_to_anchored_regex(pattern);
    let mut matches: Vec<String> = Vec::new();
    walk(&root, "", &mut |rel| {
        if matches.len() >= MAX_RESULTS {
            return false;
        }
        // Normalize to forward slashes for matching + display.
        let normalized = rel.replace(std::path::MAIN_SEPARATOR, "/");
        if regex.is_match(&normalized) {
            matches.push(normalized);
        }
        true
    });

    if matches.is_empty() {
        return ToolOutcome::executed(format!(
            "No files matching \"{pattern}\" in {}.",
            if rel_path.is_empty() { "." } else { rel_path }
        ))
        .with_meta("0 matches")
        .with_display(ToolDisplay::FileList { paths: Vec::new() });
    }

    matches.sort();
    let shown: Vec<&str> = matches.iter().take(50).map(|s| s.as_str()).collect();
    let mut output = format!(
        "{} match{} for \"{pattern}\":\n{}",
        matches.len(),
        if matches.len() == 1 { "" } else { "es" },
        shown.join("\n")
    );
    if matches.len() > 50 {
        output.push_str(&format!("\n…and {} more", matches.len() - 50));
    }
    ToolOutcome::executed(output)
        .with_meta(format!("{} files", matches.len()))
        .with_display(ToolDisplay::FileList {
            paths: matches.clone(),
        })
}

/// Walk collecting file paths relative to `root` (forward slashes), with
/// the TS visitor-returns-false early stop. Dotfiles ARE visited; only the
/// IGNORE_DIRS set is skipped (glob.ts semantics — unlike grep's walker).
fn walk(dir: &Path, rel_dir: &str, visit: &mut dyn FnMut(&str) -> bool) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            if IGNORE_DIRS.contains(&name.as_str()) {
                continue;
            }
            let child_rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            walk(&entry.path(), &child_rel, visit);
        } else if file_type.is_file() {
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            if !visit(&rel) {
                return;
            }
        }
    }
}

/// Glob pattern → anchored regex, ported from glob.ts `globToRegex`:
/// `**` (consuming one following `/`) spans any depth, `*` stays within a
/// segment, `?` is one char, `[abc]` passes through, specials are escaped.
fn glob_to_anchored_regex(pattern: &str) -> Regex {
    let mut re = String::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    if chars.peek() == Some(&'/') {
                        chars.next();
                    }
                    re.push_str(".*");
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            '[' => {
                // Pass character classes through; an unterminated '[' is literal.
                let rest: String = chars.clone().collect();
                if let Some(end) = rest.find(']') {
                    re.push('[');
                    re.push_str(&rest[..=end]);
                    for _ in 0..=end {
                        chars.next();
                    }
                } else {
                    re.push_str("\\[");
                }
            }
            c if ".+^${}()|\\".contains(c) => {
                re.push('\\');
                re.push(c);
            }
            c => re.push(c),
        }
    }
    let anchored = format!("^{re}$");
    Regex::new(&anchored).unwrap_or_else(|_| Regex::new("^$").unwrap())
}

impl Tool for GlobTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "glob".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern, e.g. \"src/**/*.tsx\", \"**/*.test.ts\", \"lib/*.md\"." },
                    "path": { "type": "string", "description": "Subdirectory to search in (relative to workspace root). Defaults to workspace root." }
                },
                "required": ["pattern"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(&self, ctx: &ToolContext, args: serde_json::Value) -> Result<ToolOutcome, ToolError> {
        let pattern = arg_str(&args, "pattern");
        let path = arg_str(&args, "path");
        Ok(run_glob(&pattern, &path, &ctx.workspace_root))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src/components/ui")).unwrap();
        std::fs::create_dir_all(tmp.path().join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(tmp.path().join("dist")).unwrap();
        std::fs::write(tmp.path().join("src/a.ts"), "x").unwrap();
        std::fs::write(tmp.path().join("src/components/b.tsx"), "x").unwrap();
        std::fs::write(tmp.path().join("src/components/ui/c.tsx"), "x").unwrap();
        std::fs::write(tmp.path().join("README.md"), "x").unwrap();
        std::fs::write(tmp.path().join("node_modules/pkg/d.js"), "x").unwrap();
        std::fs::write(tmp.path().join("dist/e.js"), "x").unwrap();
        tmp
    }

    #[test]
    fn missing_pattern_fails() {
        let tmp = workspace();
        let out = run_glob("", "", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Missing required arg"));
    }

    #[test]
    fn star_within_segment_only() {
        let tmp = workspace();
        let out = run_glob("src/*.ts", "", tmp.path());
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert_eq!(paths, vec!["src/a.ts"]);
    }

    #[test]
    fn double_star_spans_depths() {
        let tmp = workspace();
        let out = run_glob("src/**/*.tsx", "", tmp.path());
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert_eq!(paths, vec!["src/components/b.tsx", "src/components/ui/c.tsx"]);
        assert_eq!(out.meta.as_deref(), Some("2 files"));
        assert!(out.output.contains("2 matches for \"src/**/*.tsx\""));
    }

    #[test]
    fn question_mark_and_char_class() {
        let tmp = workspace();
        let out = run_glob("?.?", "", tmp.path());
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert!(paths.is_empty());

        let out = run_glob("READ[M]E.md", "", tmp.path());
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert_eq!(paths, vec!["README.md"]);
    }

    #[test]
    fn ignores_common_dirs() {
        let tmp = workspace();
        let out = run_glob("**/*.js", "", tmp.path());
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert!(paths.is_empty(), "node_modules/dist must be ignored: {paths:?}");
        assert!(out.output.starts_with("No files matching"));
        assert_eq!(out.meta.as_deref(), Some("0 matches"));
    }

    #[test]
    fn results_sorted_and_capped_display() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..60 {
            std::fs::write(tmp.path().join(format!("f{i:02}.txt")), "x").unwrap();
        }
        let out = run_glob("*.txt", "", tmp.path());
        assert!(out.output.contains("60 matches"));
        assert!(out.output.contains("…and 10 more"));
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert_eq!(paths.len(), 60);
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn path_scope_resolves_subdir() {
        let tmp = workspace();
        let out = run_glob("**/*.tsx", "src/components", tmp.path());
        let ToolDisplay::FileList { paths } = out.display.unwrap() else {
            panic!("file_list display");
        };
        assert_eq!(paths, vec!["b.tsx", "ui/c.tsx"]);
    }

    #[test]
    fn missing_dir_and_traversal_fail() {
        let tmp = workspace();
        let out = run_glob("*", "ghost", tmp.path());
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Directory not found"));
        let out = run_glob("*", "../../etc", tmp.path());
        assert!(out.output.contains("Path error") || out.output.contains("Directory not found"));
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = workspace();
        let tool = GlobTool;
        assert_eq!(tool.spec().name, "glob");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "pattern": "*.md" }),
            )
            .unwrap();
        assert!(out.output.contains("README.md"));
    }
}
