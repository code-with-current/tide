//! load_skill — port of `app/core/agent/tools/load-skill.ts` ().
//! Reads a skill's SKILL.md (via read_file + the skill-root allowlist) and
//! returns the body as instructions to follow; "execute" = load the
//! prompt-based skill, not run code. `builtin:<name>` ids resolve against
//! the embedded [`builtin_skills`] catalog (generated from
//! `src/lib/prompts/skills/` by `build/promptMarkdownUtils.mjs`) without
//! touching disk.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::read_file::{run_read_file, DEFAULT_MAX_LINES};

const DESCRIPTION: &str = "Load and activate a skill by reading its SKILL.md file. Call this when the user invokes a skill via /name, or when a skill matches the task. Returns the skill's full instructions — read and follow them before proceeding with any other action.";

/// One skill from the workspace scan, for the load_skill tool-description
/// catalog (TS `SkillSummary`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub abs_path: String,
}

/// TS `BuiltinSkill` — the embedded catalog entry shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuiltinSkill {
    pub name: String,
    pub description: String,
    pub body: String,
}

const BUILTIN_SKILLS_JSON: &str = include_str!("builtin-skills.json");

/// The bundled skills (virtual `builtin:<name>` ids, never on disk).
pub fn builtin_skills() -> &'static [BuiltinSkill] {
    static SKILLS: OnceLock<Vec<BuiltinSkill>> = OnceLock::new();
    SKILLS.get_or_init(|| {
        serde_json::from_str(BUILTIN_SKILLS_JSON).expect("builtin-skills.json is valid JSON")
    })
}

pub fn get_builtin_skill(name: &str) -> Option<&'static BuiltinSkill> {
    builtin_skills().iter().find(|s| s.name == name)
}

pub(crate) fn run_load_skill(skill_path: &str, workspace_root: &std::path::Path) -> ToolOutcome {
    if skill_path.is_empty() {
        return ToolOutcome::failed("Missing required arg: path");
    }

    // Builtin skills resolve in memory via virtual ids — never touch disk.
    if let Some(name) = skill_path.strip_prefix("builtin:") {
        let Some(skill) = get_builtin_skill(name) else {
            return ToolOutcome::failed(format!("'{name}' is not a builtin skill"));
        };
        return skill_loaded(name, skill_path, &skill.body);
    }

    let res = run_read_file(skill_path, DEFAULT_MAX_LINES, workspace_root, &[]);
    if res.status != crate::OutcomeStatus::Executed {
        return ToolOutcome::failed(format!(
            "Failed to load skill at {skill_path}: {}",
            res.output
        ));
    }

    let body = res.output;
    // Extract the skill name from frontmatter (name: xxx) for the card + meta.
    let name = skill_name_from_frontmatter(&body)
        .or_else(|| parent_dir_name(skill_path))
        .unwrap_or_else(|| "skill".to_string());
    skill_loaded(&name, skill_path, &body)
}

fn skill_loaded(name: &str, path: &str, body: &str) -> ToolOutcome {
    ToolOutcome::executed(format!(
        "Skill \"{name}\" loaded ({} chars). Read and follow its instructions before taking any other action on the task.",
        body.chars().count()
    ))
    .with_meta(format!("{} · {} chars", name, body.chars().count()))
    .with_display(ToolDisplay::FileLoaded {
        path: path.to_owned(),
        lines: body.split('\n').count() as u64,
        bytes: body.len() as u64,
        description: None,
        body: body.to_owned(),
    })
}

/// TS `body.match(/^---\s*\n[\s\S]*?^name:\s*(.+)/m)` — the frontmatter
/// `name:` value, quotes stripped.
fn skill_name_from_frontmatter(body: &str) -> Option<String> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?m)^---\s*\n[\s\S]*?^name:\s*(.+)").unwrap());
    re.captures(body)
        .map(|c| c[1].trim().trim_matches(['\'', '"']).to_string())
}

/// TS fallback `skillPath.split('/').slice(-2, -1)[0]` — the skill's
/// directory name.
fn parent_dir_name(skill_path: &str) -> Option<String> {
    std::path::Path::new(skill_path)
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
}

/// Char budget for full (name + path + description) catalog lines. Past it,
/// entries degrade to name + path only — matching Claude Code's policy of
/// dropping descriptions first rather than omitting skills outright.
const CATALOG_FULL_BUDGET: usize = 4_000;
/// Hard entry cap. Beyond this the catalog ends with an omission count —
/// the model can't load what it can't name, so names go as far as possible.
const CATALOG_MAX_ENTRIES: usize = 120;
/// Per-description clamp. Descriptions are the file's first line and
/// usually short, but a stray heading-less paragraph must not eat the
/// whole budget.
const CATALOG_DESC_CLAMP: usize = 160;

/// Render the skill catalog for the load_skill tool description, budgeted:
/// full lines while under [`CATALOG_FULL_BUDGET`], name+path lines after,
/// and an omission note past [`CATALOG_MAX_ENTRIES`]. Pure and
/// deterministic. (The static tool spec the registry freezes carries no
/// catalog; the orchestrator appends this when it builds the SDK-side
/// description from the workspace's enabled skills.)
pub fn build_skill_catalog_md(skills: &[SkillSummary]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut full = true;
    for (i, s) in skills.iter().enumerate() {
        if i >= CATALOG_MAX_ENTRIES {
            lines.push(format!(
                "(+{} more skills not listed)",
                skills.len() - CATALOG_MAX_ENTRIES
            ));
            break;
        }
        let desc: String = s
            .description
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let desc: String = desc.chars().take(CATALOG_DESC_CLAMP).collect();
        let full_line = if desc.is_empty() {
            format!("- **{}** ({})", s.name, s.abs_path)
        } else {
            format!("- **{}** ({}): {}", s.name, s.abs_path, desc)
        };
        if full && used + full_line.chars().count() > CATALOG_FULL_BUDGET {
            full = false;
        }
        let line = if full {
            full_line
        } else {
            format!("- **{}** ({})", s.name, s.abs_path)
        };
        used += line.chars().count() + 1;
        lines.push(line);
    }
    lines.join("\n")
}

pub struct LoadSkillTool;

impl Tool for LoadSkillTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "load_skill".into(),
            description: DESCRIPTION.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the skill's SKILL.md file, or a `builtin:<name>` id from the Available skills list."
                    }
                },
                "required": ["path"]
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
        let path = super::arg_str(&args, "path");
        Ok(run_load_skill(&path, &ctx.workspace_root))
    }
}

/// Builtin catalog summaries (`builtin:<name>` virtual paths) — the TS
/// `builtinSkillSummaries`.
pub fn builtin_skill_summaries() -> Vec<SkillSummary> {
    builtin_skills()
        .iter()
        .map(|s| SkillSummary {
            name: s.name.clone(),
            description: s.description.clone(),
            abs_path: format!("builtin:{}", s.name),
        })
        .collect()
}

/// Append builtins after scanned ones — scanned keep their full catalog
/// lines longer (budget) and win name collisions. Disabled names filter
/// builtins only; scanned entries are pre-filtered by the caller.
pub fn merge_builtin_skills(scanned: &[SkillSummary], disabled: &[String]) -> Vec<SkillSummary> {
    let scanned_names: HashMap<&str, ()> = scanned.iter().map(|s| (s.name.as_str(), ())).collect();
    let mut merged = scanned.to_vec();
    merged.extend(
        builtin_skill_summaries().into_iter().filter(|b| {
            !disabled.contains(&b.name) && !scanned_names.contains_key(b.name.as_str())
        }),
    );
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;
    use serde_json::json;

    fn skill(name: &str, description: &str, abs_path: &str) -> SkillSummary {
        SkillSummary {
            name: name.into(),
            description: description.into(),
            abs_path: abs_path.into(),
        }
    }

    #[test]
    fn builtin_ids_resolve_in_memory() {
        let res = run_load_skill(
            "builtin:brainstorming",
            std::path::Path::new("/nonexistent/workspace"),
        );
        assert_eq!(res.status, OutcomeStatus::Executed);
        let ToolDisplay::FileLoaded { path, body, .. } = res.display.unwrap() else {
            panic!("file_loaded display");
        };
        assert_eq!(path, "builtin:brainstorming");
        assert!(body.contains("# Brainstorming"));
        assert!(res.meta.as_deref().unwrap().starts_with("brainstorming · "));
        assert!(res.output.starts_with("Skill \"brainstorming\" loaded ("));
    }

    #[test]
    fn unknown_builtin_fails_cleanly() {
        let res = run_load_skill(
            "builtin:nope",
            std::path::Path::new("/nonexistent/workspace"),
        );
        assert_eq!(res.status, OutcomeStatus::Failed);
        assert_eq!(res.output, "'nope' is not a builtin skill");
    }

    #[test]
    fn missing_path_arg_fails() {
        let res = run_load_skill("", std::path::Path::new("/w"));
        assert_eq!(res.status, OutcomeStatus::Failed);
        assert_eq!(res.output, "Missing required arg: path");
    }

    #[test]
    fn disk_paths_still_read_through_read_file() {
        let res = run_load_skill(
            "/nonexistent/SKILL.md",
            std::path::Path::new("/nonexistent/workspace"),
        );
        assert_eq!(res.status, OutcomeStatus::Failed);
        assert!(res.output.contains("Failed to load skill"));
    }

    #[test]
    fn disk_skill_extracts_frontmatter_name() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join("my-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: \"Custom Skill\"\ndescription: \"d\"\n---\n# Custom\nBody",
        )
        .unwrap();
        let res = run_load_skill(&skill_dir.join("SKILL.md").to_string_lossy(), tmp.path());
        assert_eq!(res.status, OutcomeStatus::Executed);
        assert!(res.output.starts_with("Skill \"Custom Skill\" loaded ("));
        let ToolDisplay::FileLoaded {
            lines, bytes, body, ..
        } = res.display.unwrap()
        else {
            panic!("file_loaded display");
        };
        assert!(body.contains("# Custom"));
        assert!(lines >= 1);
        assert_eq!(bytes as usize, body.len());
    }

    #[test]
    fn disk_skill_falls_back_to_directory_name() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join("dir-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "# No frontmatter\nBody").unwrap();
        let res = run_load_skill(&skill_dir.join("SKILL.md").to_string_lossy(), tmp.path());
        assert!(res.output.starts_with("Skill \"dir-skill\" loaded ("));
    }

    #[test]
    fn catalog_renders_full_lines_for_a_small_set() {
        let md = build_skill_catalog_md(&[
            skill(
                "verify",
                "Runtime verification of changes.",
                "/skills/verify/SKILL.md",
            ),
            skill(
                "debug",
                "Systematic debugging loop.",
                "/skills/debug/SKILL.md",
            ),
        ]);
        assert_eq!(
            md,
            "- **verify** (/skills/verify/SKILL.md): Runtime verification of changes.\n- **debug** (/skills/debug/SKILL.md): Systematic debugging loop."
        );
    }

    #[test]
    fn catalog_omits_separator_without_description() {
        let md = build_skill_catalog_md(&[skill("bare", "", "/skills/bare/SKILL.md")]);
        assert_eq!(md, "- **bare** (/skills/bare/SKILL.md)");
    }

    #[test]
    fn catalog_collapses_whitespace_and_clamps_descriptions() {
        let md =
            build_skill_catalog_md(&[skill("long", &"word ".repeat(60), "/skills/long/SKILL.md")]);
        assert!(!md.contains("word  word"));
        assert!(md.chars().count() < 300);
    }

    #[test]
    fn catalog_degrades_to_name_path_past_budget() {
        let skills: Vec<_> = (0..80)
            .map(|i| {
                skill(
                    &format!("skill-{:02}", i),
                    &"x".repeat(100),
                    &format!("/skills/skill-{i:02}/SKILL.md"),
                )
            })
            .collect();
        let md = build_skill_catalog_md(&skills);
        let lines: Vec<&str> = md.split('\n').collect();
        let full_lines = lines.iter().filter(|l| l.contains(": ")).count();
        let bare_lines = lines.iter().filter(|l| !l.contains(": ")).count();
        assert!(full_lines > 0);
        assert!(full_lines < skills.len());
        assert_eq!(bare_lines, skills.len() - full_lines);
        let bare_re =
            regex::Regex::new(r"^- \*\*skill-\d+\*\* \(/skills/skill-\d+/SKILL\.md\)$").unwrap();
        for l in lines.iter().filter(|l| !l.contains(": ")) {
            assert!(bare_re.is_match(l));
        }
    }

    #[test]
    fn catalog_caps_entries_and_reports_omission_count() {
        let skills: Vec<_> = (0..130)
            .map(|i| skill(&format!("s{i}"), "", &format!("/s/{i}/SKILL.md")))
            .collect();
        let md = build_skill_catalog_md(&skills);
        let lines: Vec<&str> = md.split('\n').collect();
        assert_eq!(lines.len(), 121);
        assert_eq!(lines[120], "(+10 more skills not listed)");
    }

    #[test]
    fn catalog_empty_for_no_skills() {
        assert_eq!(build_skill_catalog_md(&[]), "");
    }

    #[test]
    fn builtin_catalog_matches_bundled_set() {
        let all = builtin_skills();
        assert_eq!(all.len(), 13);
        assert!(all.iter().all(|s| !s.body.is_empty()));
        let summaries = builtin_skill_summaries();
        assert_eq!(summaries.len(), all.len());
        assert_eq!(
            summaries[0].abs_path,
            format!("builtin:{}", summaries[0].name)
        );
        // merge: scanned wins collisions, disabled filters builtins.
        let scanned = vec![skill(
            "brainstorming",
            "scanned",
            "/ws/brainstorming/SKILL.md",
        )];
        let merged = merge_builtin_skills(&scanned, &["writing-plans".to_string()]);
        assert_eq!(merged[0].description, "scanned");
        assert!(merged
            .iter()
            .any(|s| s.abs_path == "builtin:executing-plans"));
        assert!(!merged.iter().any(|s| s.name == "writing-plans"));
        assert_eq!(merged.len(), all.len() - 1); // writing-plans filtered, brainstorming shadowed
    }

    #[test]
    fn execute_routes_through_trait() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = LoadSkillTool;
        assert_eq!(tool.spec().name, "load_skill");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);
        let ctx = ToolContext::new(tmp.path().to_path_buf());
        let out = tool
            .execute(&ctx, json!({ "path": "builtin:brainstorming" }))
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Executed);
    }
}
