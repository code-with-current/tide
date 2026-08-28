//! grep — port of `app/core/agent/tools/grep.ts` (). Content search
//! using ripgrep when installed, falling back to a built-in walker. Caps
//! at maxResults (default 100) matching lines.
//!
//! Faithful quirks kept from the TS: the rg path is case-sensitive while
//! the fallback walker is case-insensitive (`new RegExp(pattern, 'i')`),
//! and the fallback glob filter tests the file's BASE NAME.

use std::path::Path;
use std::time::Duration;

use regex::{Regex, RegexBuilder};
use serde_json::json;

use crate::path_safety::resolve_inside_workspace;
use crate::permission::RiskTier;
use crate::{redact, Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;
use super::arg_u64;
use super::proc::{run_with_deadline, RunError};

pub(crate) const MAX_RESULTS: usize = 100;
const TIMEOUT_MS: u64 = 10_000;

const DESCRIPTION: &str = "Search file contents with a regular expression. Uses ripgrep if installed for speed; falls back to a Node implementation. Returns matching lines with file:line prefixes. Defaults to searching the whole workspace; pass `path` to scope to a subdirectory. Use `glob` to filter file patterns (e.g. \"*.ts\").";

pub struct GrepTool;

pub(crate) fn run_grep(
    pattern: &str,
    rel_path: &str,
    glob: &str,
    max_results: usize,
    workspace_root: &Path,
    timeout_ms: u64,
) -> ToolOutcome {
    if pattern.is_empty() {
        return ToolOutcome::failed("Missing required arg: pattern");
    }

    let abs = match resolve_inside_workspace(
        workspace_root,
        if rel_path.is_empty() { "." } else { rel_path },
    ) {
        Ok(abs) => abs,
        Err(e) => return ToolOutcome::failed(format!("Path error: {e}")),
    };

    // Try ripgrep first — same flag set as the TS. Exit 1 (no matches) with
    // empty stdout falls through to the built-in walker, exactly like the
    // TS `status === 0 || result.stdout` check.
    let mut cmd = std::process::Command::new("rg");
    cmd.args([
        "--line-number",
        "--no-heading",
        "--color=never",
        "--max-count",
        &max_results.to_string(),
    ]);
    if !glob.is_empty() {
        cmd.arg("--glob").arg(glob);
    }
    cmd.arg("--").arg(pattern).arg(&abs);
    match run_with_deadline(&mut cmd, Duration::from_millis(timeout_ms), 1024 * 1024) {
        Ok(result) if result.exit == Some(0) || !result.stdout.is_empty() => {
            let out = result.stdout.trim();
            let text = if out.is_empty() { "(no matches)".to_string() } else { out.to_string() };
            let matches = if out.is_empty() { 0 } else { out.split('\n').count() };
            return ToolOutcome::executed(text.clone())
                .with_display(ToolDisplay::Text { text })
                .with_meta(format!("{matches} matches"));
        }
        Ok(_) => { /* rg ran, found nothing — fall through */ }
        Err(RunError::Spawn(_)) => { /* rg not installed — fall through */ }
        Err(RunError::Io(e)) => return ToolOutcome::failed(format!("rg error: {e}")),
    }

    // Built-in fallback (the TS "Node impl"): case-insensitive, abs
    // `path:line:text` lines.
    let re = match RegexBuilder::new(pattern).case_insensitive(true).build() {
        Ok(re) => re,
        Err(e) => return ToolOutcome::failed(format!("Bad regex: {e}")),
    };
    let glob_re = if glob.is_empty() {
        None
    } else {
        match Regex::new(&grep_glob_to_regex(glob)) {
            Ok(re) => Some(re),
            Err(e) => return ToolOutcome::failed(format!("Bad regex: {e}")),
        }
    };
    let matches = grep_walk(&abs, &re, glob_re.as_ref(), max_results);
    let body = matches.join("\n");
    let text = if body.is_empty() { "(no matches)".to_string() } else { redact(body) };
    ToolOutcome::executed(text.clone())
        .with_display(ToolDisplay::Text { text })
        .with_meta(format!("{} matches", matches.len()))
}

/// Skip-list for the fallback walker (TS `grepNode`).
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "release",
    "next",
    ".cache",
];

/// Recursive fallback — returns `abs:line:match` strings.
fn grep_walk(root: &Path, re: &Regex, glob_re: Option<&Regex>, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    walk(root, &mut |path, name| {
        if out.len() >= max {
            return false;
        }
        if let Some(g) = glob_re {
            if !g.is_match(name) {
                return true;
            }
        }
        if let Ok(bytes) = std::fs::read(path) {
            let content = String::from_utf8_lossy(&bytes);
            for (i, line) in content.split('\n').enumerate() {
                if out.len() >= max {
                    return false;
                }
                if re.is_match(line) {
                    out.push(format!("{}:{}:{}", path.display(), i + 1, line));
                }
            }
        }
        true
    });
    out
}

fn walk(dir: &Path, visit: &mut dyn FnMut(&Path, &str) -> bool) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(&entry.path(), visit);
        } else if file_type.is_file()
            && !(name.starts_with('.') && name != ".agent")
            && !visit(&entry.path(), &name)
        {
            return;
        }
    }
}

/// The grep-side glob→regex conversion (TS grep.ts `globToRegex`): escape
/// regex specials, `**` → `.*`, `*` → `[^/]*`. Applied UNanchored against
/// the base file name.
fn grep_glob_to_regex(glob: &str) -> String {
    let mut re = String::new();
    let mut chars = glob.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    re.push_str(".*");
                } else {
                    re.push_str("[^/]*");
                }
            }
            c if ".+^${}()|[]\\".contains(c) => {
                re.push('\\');
                re.push(c);
            }
            c => re.push(c),
        }
    }
    re
}

impl Tool for GrepTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "grep".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Regular expression to search for." },
                    "path": { "type": "string", "description": "Directory or file to search. Defaults to workspace root." },
                    "glob": { "type": "string", "description": "File glob filter, e.g. \"*.ts\" or \"**/*.test.ts\"." },
                    "maxResults": { "type": "number", "description": "Max matching lines to return. Default 100." }
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
        let glob = arg_str(&args, "glob");
        let max_results = arg_u64(&args, "maxResults")
            .map(|n| n as usize)
            .unwrap_or(MAX_RESULTS);
        Ok(run_grep(
            &pattern,
            &path,
            &glob,
            max_results,
            &ctx.workspace_root,
            TIMEOUT_MS,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("src")).unwrap();
        std::fs::create_dir_all(tmp.path().join("node_modules/pkg")).unwrap();
        std::fs::write(tmp.path().join("src/a.ts"), "hello world\nnope\nhello again\n").unwrap();
        std::fs::write(tmp.path().join("src/b.rs"), "rust hello\n").unwrap();
        std::fs::write(tmp.path().join("node_modules/pkg/c.js"), "hello ignored\n").unwrap();
        std::fs::write(tmp.path().join(".hidden.txt"), "hello hidden\n").unwrap();
        // rg honors .gitignore; the fallback walker skips by name. Both
        // paths must agree on ignoring node_modules + dotfiles.
        std::fs::write(tmp.path().join(".gitignore"), "node_modules/\n.hidden.txt\n").unwrap();
        // rg honors .gitignore only inside a git repo — init one so the rg
        // path and the fallback agree on ignores.
        let _ = std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(tmp.path())
            .status();
        tmp
    }

    #[test]
    fn missing_pattern_fails() {
        let tmp = workspace();
        let out = run_grep("", "", "", MAX_RESULTS, tmp.path(), TIMEOUT_MS);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Missing required arg"));
    }

    #[test]
    fn finds_matches_with_file_line_prefixes() {
        let tmp = workspace();
        // Lowercase-only content so the rg (case-sensitive) and fallback
        // (case-insensitive) paths agree.
        let out = run_grep("hello", "", "", MAX_RESULTS, tmp.path(), TIMEOUT_MS);
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        let a = tmp.path().join("src/a.ts").display().to_string();
        let b = tmp.path().join("src/b.rs").display().to_string();
        assert!(out.output.contains(&format!("{a}:1:hello world")));
        assert!(out.output.contains(&format!("{b}:1:rust hello")));
        assert_eq!(out.meta.as_deref(), Some("3 matches"));
    }

    #[test]
    fn no_matches_reports_cleanly() {
        let tmp = workspace();
        let out = run_grep("zzzznotfound", "", "", MAX_RESULTS, tmp.path(), TIMEOUT_MS);
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(out.output, "(no matches)");
        assert!(out.meta.as_deref().unwrap().ends_with("0 matches"));
    }

    #[test]
    fn respects_max_results_cap_on_single_file() {
        let tmp = workspace();
        // rg's --max-count is per file while the fallback caps globally —
        // scope to one file so both agree.
        let out = run_grep("hello", "src/a.ts", "", 1, tmp.path(), TIMEOUT_MS);
        assert_eq!(out.status, crate::OutcomeStatus::Executed);
        assert_eq!(out.meta.as_deref(), Some("1 matches"));
        assert_eq!(out.output.split('\n').count(), 1);
    }

    #[test]
    fn path_scope_and_ignores() {
        let tmp = workspace();
        let out = run_grep("hello", "src", "", MAX_RESULTS, tmp.path(), TIMEOUT_MS);
        assert!(out.output.contains("src/a.ts"));
        assert!(!out.output.contains("node_modules"));
        // Fallback walker skips dotfiles; rg skips hidden by default too.
        assert!(!out.output.contains(".hidden.txt"));
    }

    #[test]
    fn traversal_rejected() {
        let tmp = workspace();
        let out = run_grep("x", "../../etc", "", MAX_RESULTS, tmp.path(), TIMEOUT_MS);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Path error"));
    }

    #[test]
    fn bad_regex_fails() {
        let tmp = workspace();
        let out = run_grep("[unclosed", "", "", MAX_RESULTS, tmp.path(), TIMEOUT_MS);
        assert_eq!(out.status, crate::OutcomeStatus::Failed);
        assert!(out.output.contains("Bad regex") || out.output.contains("rg error"));
    }

    #[test]
    fn fallback_walker_is_case_insensitive_and_glob_filters() {
        let tmp = workspace();
        // Direct walker test: uppercase pattern must still match.
        let re = RegexBuilder::new("HELLO").case_insensitive(true).build().unwrap();
        let glob_re = Regex::new(&grep_glob_to_regex("*.ts")).unwrap();
        let matches = grep_walk(tmp.path(), &re, Some(&glob_re), MAX_RESULTS);
        assert!(matches.iter().any(|m| m.contains("src/a.ts:1")));
        assert!(matches.iter().all(|m| m.contains(".ts:")));
        assert!(!matches.iter().any(|m| m.contains("b.rs")));
        // Skips node_modules and dotfiles.
        assert!(!matches.iter().any(|m| m.contains("node_modules")));
        assert!(!matches.iter().any(|m| m.contains(".hidden.txt")));
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = workspace();
        let tool = GrepTool;
        assert_eq!(tool.spec().name, "grep");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let out = tool
            .execute(
                &ToolContext::new(tmp.path().to_path_buf()),
                json!({ "pattern": "rust hello" }),
            )
            .unwrap();
        assert!(out.output.contains("b.rs"));
    }
}
