//! Rule-based permission rules — port of `app/core/agent/permissions/rules.ts`
//! (91ec558). Spec format: `"ToolName(argPattern)"` — bare tool name matches
//! any args; `prefix`, glob (`*`/`?`/`[`) patterns match the tool's primary
//! arg. Precedence: deny wins; allow upgrades ask→auto (never bypasses plan
//! mode). Project rules persist in `.agents/settings.json`.

use std::path::Path;

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    /// Tool-name pattern: `'*'` | `'bash'` | `'edit:*'` (case-insensitive).
    pub tool: String,
    /// Pattern on the tool's primary arg; `None` = match any args.
    pub arg_pattern: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RuleSet {
    pub allow: Vec<Rule>,
    pub deny: Vec<Rule>,
}

/// Parse `"ToolName(argPattern)"` or `"ToolName"`.
pub fn parse_rule(spec: &str) -> Option<Rule> {
    let s = spec.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(open) = s.find('(') {
        if s.ends_with(')') && open > 0 {
            let tool = s[..open].trim();
            // TS `^([^()]+)\(` — the tool segment itself must be paren-free.
            if tool.is_empty() || tool.contains('(') || tool.contains(')') {
                return None;
            }
            let arg = s[open + 1..s.len() - 1].trim();
            return Some(Rule {
                tool: tool.to_string(),
                arg_pattern: if arg.is_empty() { None } else { Some(arg.to_string()) },
            });
        }
        return None;
    }
    Some(Rule {
        tool: s.to_string(),
        arg_pattern: None,
    })
}

fn parse_list(raw: Option<&Value>) -> Vec<Rule> {
    raw.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .filter_map(parse_rule)
                .collect()
        })
        .unwrap_or_default()
}

fn load_file(path: &Path) -> RuleSet {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return RuleSet::default();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return RuleSet::default();
    };
    let perms = parsed.get("permissions").cloned().unwrap_or(Value::Null);
    RuleSet {
        allow: parse_list(perms.get("allow")),
        deny: parse_list(perms.get("deny")),
    }
}

/// Load project rules from `<root>/.agents/settings.json`. Missing or
/// malformed files yield an empty set (the gate falls back to modes).
pub fn load_permission_rules(workspace_root: &Path) -> RuleSet {
    load_file(&workspace_root.join(".agents").join("settings.json"))
}

/// The primary arg used for argPattern matching, per tool (TS `primaryArg`).
pub fn primary_arg(tool_name: &str, args: &Value) -> Option<String> {
    let get_str = |key: &str| args.get(key).and_then(|v| v.as_str()).map(String::from);
    match tool_name {
        "bash" => get_str("command"),
        "dispatch_agent" => get_str("name"),
        "git_repo" => get_str("repo"),
        "git" => args.get("args").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        }),
        "web_fetch" => get_str("url"),
        "web_search" => get_str("query"),
        "edit_file" | "multi_edit" | "write_file" | "notebook_edit" | "read_file"
        | "list_dir" | "glob" | "grep" => get_str("path").or_else(|| get_str("pattern")),
        _ => None,
    }
}

fn tool_name_matches(pattern: &str, tool_name: &str) -> bool {
    let p = pattern.to_lowercase();
    let t = tool_name.to_lowercase();
    if p == "*" || p == t {
        return true;
    }
    if let Some(prefix) = p.strip_suffix(":*") {
        return t.starts_with(prefix);
    }
    false
}

/// Does an arg pattern match a value? Glob chars (`* ? [`) get wildcard
/// matching (`*`/`?` stay within a path segment, minimatch-style); other
/// patterns are plain prefix matches.
fn arg_pattern_matches(pattern: &str, value: &str) -> bool {
    if pattern.contains(['*', '?', '[']) {
        return wildcard_match(value, pattern);
    }
    value.starts_with(pattern)
}

/// minimatch-subset wildcard matcher (the TS used minimatch with `dot: true`).
fn wildcard_match(value: &str, pattern: &str) -> bool {
    let v: Vec<char> = value.chars().collect();
    let p: Vec<char> = pattern.chars().collect();
    wc(&v, 0, &p, 0)
}

fn wc(v: &[char], mut vi: usize, p: &[char], mut pi: usize) -> bool {
    while pi < p.len() {
        match p[pi] {
            '*' => {
                // Collapse consecutive stars; `*` does not cross '/'.
                while pi < p.len() && p[pi] == '*' {
                    pi += 1;
                }
                if pi == p.len() {
                    return !v[vi..].contains(&'/');
                }
                for next in vi..=v.len() {
                    if v.get(next) == Some(&'/') {
                        break;
                    }
                    if wc(v, next, p, pi) {
                        return true;
                    }
                }
                return false;
            }
            '?' => {
                if vi >= v.len() || v[vi] == '/' {
                    return false;
                }
                vi += 1;
                pi += 1;
            }
            '[' => {
                let Some(end) = p[pi..].iter().position(|&c| c == ']') else {
                    // Unterminated class: literal '[' comparison.
                    if v.get(vi) == Some(&'[') {
                        vi += 1;
                        pi += 1;
                        continue;
                    }
                    return false;
                };
                let end = pi + end;
                let vi_char = match v.get(vi) {
                    Some(&c) => c,
                    None => return false,
                };
                if vi_char == '/' {
                    return false;
                }
                let (negated, class) = match p.get(pi + 1) {
                    Some('!') | Some('^') => (true, &p[pi + 2..end]),
                    _ => (false, &p[pi + 1..end]),
                };
                let mut matched = false;
                let mut ci = 0;
                while ci < class.len() {
                    if ci + 2 < class.len() && class[ci + 1] == '-' {
                        if vi_char >= class[ci] && vi_char <= class[ci + 2] {
                            matched = true;
                        }
                        ci += 3;
                    } else {
                        if vi_char == class[ci] {
                            matched = true;
                        }
                        ci += 1;
                    }
                }
                if matched == negated {
                    return false;
                }
                vi += 1;
                pi = end + 1;
            }
            c => {
                if v.get(vi) != Some(&c) {
                    return false;
                }
                vi += 1;
                pi += 1;
            }
        }
    }
    vi == v.len()
}

/// Does a rule match a specific tool call?
pub fn rule_matches(rule: &Rule, tool_name: &str, args: &Value) -> bool {
    if !tool_name_matches(&rule.tool, tool_name) {
        return false;
    }
    let Some(pattern) = &rule.arg_pattern else {
        return true;
    };
    match primary_arg(tool_name, args) {
        Some(arg) => arg_pattern_matches(pattern, &arg),
        None => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleOutcome {
    Deny,
    Allow,
}

/// Evaluate rules. Deny wins; else allow; else `None`.
pub fn evaluate_rules(rules: &RuleSet, tool_name: &str, args: &Value) -> Option<RuleOutcome> {
    for r in &rules.deny {
        if rule_matches(r, tool_name, args) {
            return Some(RuleOutcome::Deny);
        }
    }
    for r in &rules.allow {
        if rule_matches(r, tool_name, args) {
            return Some(RuleOutcome::Allow);
        }
    }
    None
}

/// Merge rule sets — session rules first (added this turn take precedence
/// in evaluation order), then file rules, per the TS wrapper's merge.
pub fn merge_rules(session: &RuleSet, file: &RuleSet) -> RuleSet {
    RuleSet {
        allow: session
            .allow
            .iter()
            .chain(file.allow.iter())
            .cloned()
            .collect(),
        deny: session
            .deny
            .iter()
            .chain(file.deny.iter())
            .cloned()
            .collect(),
    }
}

/// Derive an "Always Allow" rule spec from an approved call: smart globs
/// for bash (`npx:*`, package-manager heads) and file tools (dir/*).
pub fn derive_rule_spec(tool_name: &str, args: &Value) -> String {
    let Some(arg) = primary_arg(tool_name, args) else {
        return tool_name.to_string();
    };

    if tool_name == "bash" {
        let tokens: Vec<&str> = arg.split_whitespace().collect();
        if let Some(first) = tokens.first() {
            if *first == "npx" {
                // "npx package-name" → "bash(npx package-name:*)"
                let pkg: Vec<&str> = tokens.iter().take(2).copied().collect();
                return format!("{tool_name}({}:*)", pkg.join(" "));
            }
            if matches!(*first, "npm" | "yarn" | "pnpm" | "bun" | "deno") && tokens.len() >= 2 {
                let head: Vec<&str> = tokens.iter().take(2).copied().collect();
                return format!("{tool_name}({})", head.join(" "));
            }
        }
        let head = arg.split_whitespace().next().unwrap_or("");
        return format!("{tool_name}({head})");
    }

    if let Some(idx) = arg.rfind('/') {
        let dir = &arg[..idx];
        return format!("{tool_name}({dir}/*)");
    }

    format!("{tool_name}({arg})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_rule_bare_and_with_arg() {
        assert_eq!(
            parse_rule("bash"),
            Some(Rule { tool: "bash".into(), arg_pattern: None })
        );
        assert_eq!(
            parse_rule("bash(npm test)"),
            Some(Rule {
                tool: "bash".into(),
                arg_pattern: Some("npm test".into())
            })
        );
        assert_eq!(parse_rule("read_file()").unwrap().arg_pattern, None);
        assert_eq!(parse_rule("  edit:* ( src/* ) ").unwrap().tool, "edit:*");
        assert_eq!(parse_rule(""), None);
        assert_eq!(parse_rule("(x)"), None);
    }

    #[test]
    fn primary_arg_resolution() {
        assert_eq!(primary_arg("bash", &json!({"command": "ls"})), Some("ls".into()));
        assert_eq!(
            primary_arg("git", &json!({"args": ["status", "--short"]})),
            Some("status --short".into())
        );
        assert_eq!(
            primary_arg("read_file", &json!({"path": "src/a.ts"})),
            Some("src/a.ts".into())
        );
        assert_eq!(
            primary_arg("grep", &json!({"pattern": "foo"})),
            Some("foo".into())
        );
        assert_eq!(primary_arg("bash", &json!({})), None);
        assert_eq!(primary_arg("unknown_tool", &json!({"x": 1})), None);
    }

    #[test]
    fn tool_name_pattern_matching() {
        assert!(tool_name_matches("bash", "bash"));
        assert!(tool_name_matches("BASH", "bash"));
        assert!(tool_name_matches("*", "anything"));
        assert!(tool_name_matches("edit:*", "edit_file"));
        assert!(!tool_name_matches("edit:*", "write_file"));
        assert!(!tool_name_matches("bas", "bash"));
    }

    #[test]
    fn arg_pattern_prefix_and_glob() {
        assert!(arg_pattern_matches("npm test", "npm test --watch"));
        assert!(!arg_pattern_matches("npm test", "npmx test"));
        // Quirk kept from the TS (minimatch): ':' is a LITERAL in glob
        // patterns, so the derived "npx cowsay:*" spec matches commands
        // containing that literal colon — never real "npx cowsay -f x"
        // invocations. An allow rule that never fires is the safe direction.
        assert!(!arg_pattern_matches("npx cowsay:*", "npx cowsay -f x"));
        assert!(arg_pattern_matches("npx cowsay:*", "npx cowsay:extra"));
        // `*` does not cross path separators (minimatch semantics).
        assert!(!arg_pattern_matches("src/*", "src/a/b.ts"));
        assert!(arg_pattern_matches("src/*", "src/a.ts"));
        assert!(arg_pattern_matches("*.test.ts", "a.test.ts"));
        assert!(arg_pattern_matches("[a-c]?", "ax"));
        assert!(!arg_pattern_matches("[a-c]?", "dx"));
    }

    #[test]
    fn evaluate_rules_deny_wins_over_allow() {
        let rules = RuleSet {
            allow: vec![parse_rule("bash").unwrap()],
            deny: vec![parse_rule("bash(rm *)").unwrap()],
        };
        assert_eq!(
            evaluate_rules(&rules, "bash", &json!({"command": "rm x"})),
            Some(RuleOutcome::Deny)
        );
        assert_eq!(
            evaluate_rules(&rules, "bash", &json!({"command": "ls"})),
            Some(RuleOutcome::Allow)
        );
        assert_eq!(evaluate_rules(&rules, "grep", &json!({"pattern": "x"})), None);
    }

    #[test]
    fn derive_rule_spec_smart_globs() {
        assert_eq!(
            derive_rule_spec("bash", &json!({"command": "npx cowsay -f moo"})),
            "bash(npx cowsay:*)"
        );
        assert_eq!(
            derive_rule_spec("bash", &json!({"command": "pnpm install --filter pkg"})),
            "bash(pnpm install)"
        );
        assert_eq!(
            derive_rule_spec("bash", &json!({"command": "cargo build --release"})),
            "bash(cargo)"
        );
        assert_eq!(
            derive_rule_spec("edit_file", &json!({"path": "src/lib/a.ts"})),
            "edit_file(src/lib/*)"
        );
        assert_eq!(
            derive_rule_spec("read_file", &json!({"path": "README.md"})),
            "read_file(README.md)"
        );
        assert_eq!(derive_rule_spec("bash", &json!({})), "bash");
    }

    #[test]
    fn loads_rules_from_agents_settings_json() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".agents").join("settings.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            r#"{"permissions": {"allow": ["bash(pnpm test)"], "deny": ["bash(sudo*)"]}}"#,
        )
        .unwrap();
        let rules = load_permission_rules(tmp.path());
        assert_eq!(rules.allow.len(), 1);
        assert_eq!(rules.deny.len(), 1);

        assert_eq!(
            evaluate_rules(&rules, "bash", &json!({"command": "sudo rm x"})),
            Some(RuleOutcome::Deny)
        );
        assert_eq!(
            evaluate_rules(&rules, "bash", &json!({"command": "pnpm test --ci"})),
            Some(RuleOutcome::Allow)
        );
    }

    #[test]
    fn missing_or_malformed_file_yields_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load_permission_rules(tmp.path()), RuleSet::default());
        let file = tmp.path().join(".agents").join("settings.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(load_permission_rules(tmp.path()), RuleSet::default());
        std::fs::write(&file, r#"{"permissions": "nope"}"#).unwrap();
        assert_eq!(load_permission_rules(tmp.path()), RuleSet::default());
    }

    #[test]
    fn merge_puts_session_rules_first() {
        let session = RuleSet {
            allow: vec![Rule { tool: "bash".into(), arg_pattern: None }],
            deny: vec![],
        };
        let file = RuleSet {
            allow: vec![Rule { tool: "grep".into(), arg_pattern: None }],
            deny: vec![],
        };
        let merged = merge_rules(&session, &file);
        assert_eq!(merged.allow.len(), 2);
        assert_eq!(merged.allow[0].tool, "bash");
    }
}
