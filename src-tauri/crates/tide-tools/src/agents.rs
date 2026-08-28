//! Built-in sub-agent catalog — port of `app/core/agent/agents/`
//! (registry + prompts). The agent definitions ARE the renderer's prompt
//! files (`src/lib/prompts/agents/*.md`, HTML-comment frontmatter + body),
//! include_str!'d straight from the renderer tree so the catalog can never
//! drift from what the TS bundle shipped: adding a `.md` there and listing
//! it in [`SOURCES`] adds an agent here (the TS "add a file + rebuild" flow).
//!
//! Consumed by [`crate::tools::dispatch_agent`] (the tool's name enum) and
//! by the app crate's dispatch runner (system prompt, tool subset, step
//! budget, recursion grants).

use std::sync::OnceLock;

use crate::permission::{risk_tier_for, RiskTier};

/// Max nesting depth for recursive dispatch (TS `MAX_AGENT_DEPTH`).
pub const MAX_AGENT_DEPTH: u32 = 3;

/// Default step budget when an agent sets no `maxSteps` (TS default 10).
pub const DEFAULT_MAX_STEPS: u32 = 10;

const SOURCES: &[(&str, &str)] = &[
    ("code-reviewer", include_str!("../../../../src/lib/prompts/agents/code-reviewer.md")),
    ("codebase-orchestrator", include_str!("../../../../src/lib/prompts/agents/codebase-orchestrator.md")),
    ("commit-writer", include_str!("../../../../src/lib/prompts/agents/commit-writer.md")),
    ("explore", include_str!("../../../../src/lib/prompts/agents/explore.md")),
    ("general-purpose", include_str!("../../../../src/lib/prompts/agents/general-purpose.md")),
    ("pr-creator", include_str!("../../../../src/lib/prompts/agents/pr-creator.md")),
    ("security-reviewer", include_str!("../../../../src/lib/prompts/agents/security-reviewer.md")),
    ("simplifier", include_str!("../../../../src/lib/prompts/agents/simplifier.md")),
    ("web-research", include_str!("../../../../src/lib/prompts/agents/web-research.md")),
];

/// One dispatchable agent — the TS `AgentDef`. `thinking_level` stays a
/// string ("low"/"medium"/"high"); the app crate maps it onto the engine's
/// enum (this crate is engine-agnostic).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentDef {
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    pub system_prompt: String,
    /// Empty = single-shot (one completion, no tool loop).
    pub allowed_tools: Vec<String>,
    pub max_steps: Option<u32>,
    pub thinking_level: Option<String>,
    /// Targets this agent may dispatch; `can_dispatch_all` grants any.
    pub can_dispatch: Vec<String>,
    pub can_dispatch_all: bool,
}

/// The parsed catalog, in file (alphabetical) order — the order the TS
/// bundle and the `dispatch_agent` schema enum shipped.
pub fn builtin_agents() -> &'static [AgentDef] {
    static CATALOG: OnceLock<Vec<AgentDef>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        SOURCES
            .iter()
            .map(|(name, raw)| parse_agent(name, raw))
            .collect()
    })
}

pub fn get_agent(name: &str) -> Option<&'static AgentDef> {
    builtin_agents().iter().find(|a| a.name == name)
}

/// Stable name list — builds the `dispatch_agent` tool's enum.
pub fn agent_names() -> Vec<&'static str> {
    builtin_agents().iter().map(|a| a.name.as_str()).collect()
}

/// May `agent` dispatch `target`? False unless canDispatch explicitly
/// grants it (declarative recursion — TS `canDispatchTo`).
pub fn can_dispatch_to(agent: &AgentDef, target: &str) -> bool {
    agent.can_dispatch_all || agent.can_dispatch.iter().any(|t| t == target)
}

/// The tool list a child built from this agent actually gets — includes
/// `dispatch_agent` only when canDispatch grants it, and strips any stray
/// entry otherwise (remove-don't-fail: the model never sees a tool it is
/// not allowed to call). TS `effectiveChildTools`.
pub fn effective_child_tools(agent: &AgentDef) -> Vec<String> {
    let mut tools = agent.allowed_tools.clone();
    if agent.can_dispatch_all || !agent.can_dispatch.is_empty() {
        if !tools.iter().any(|t| t == "dispatch_agent") {
            tools.push("dispatch_agent".to_owned());
        }
        tools
    } else {
        tools.retain(|t| t != "dispatch_agent");
        tools
    }
}

/// The effective risk of dispatching this agent: the highest risk tier
/// among its allowed tools. Drives the plan-mode dispatch gate — a parent
/// in plan mode must not spawn an agent that can write or run shell
/// commands without an explicit escalation. TS `agentRiskTier`.
pub fn agent_risk_tier(agent: &AgentDef) -> RiskTier {
    let rank = |t: &RiskTier| match t {
        RiskTier::ReadOnly => 0,
        RiskTier::Write => 1,
        RiskTier::Destructive => 2,
    };
    let mut max = 0;
    for tool in &agent.allowed_tools {
        max = max.max(rank(&risk_tier_for(tool)));
    }
    match max {
        2 => RiskTier::Destructive,
        1 => RiskTier::Write,
        _ => RiskTier::ReadOnly,
    }
}

// ── frontmatter parsing ─────────────────────────────────────────────────────

/// Parse one `.md` source: `<!-- key: "value" ... -->` frontmatter +
/// everything after it as the system prompt. Panics only on catalog
/// corruption (a missing required field) — these are compile-time-embedded
/// files, not user input.
fn parse_agent(fallback_name: &str, raw: &str) -> AgentDef {
    let (frontmatter, body) = match raw.split_once("-->") {
        Some((head, tail)) => (head.trim_start_matches("<!--\n").trim_start_matches("<!--"), tail.trim()),
        None => ("", raw.trim()),
    };
    let mut fields: Vec<(String, String)> = Vec::new();
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        fields.push((key.trim().to_owned(), unquote(value.trim())));
    }
    let field = |key: &str| fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    let csv = |key: &str| {
        field(key)
            .map(|v| v.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default()
    };

    let name = field("name").filter(|v| !v.is_empty()).unwrap_or_else(|| fallback_name.to_owned());
    let can_dispatch: Vec<String> = csv("canDispatch");
    let can_dispatch_all = can_dispatch.iter().any(|t| t == "all");
    AgentDef {
        name,
        description: field("description").unwrap_or_default(),
        when_to_use: field("whenToUse").unwrap_or_default(),
        system_prompt: body.to_owned(),
        allowed_tools: csv("allowedTools"),
        max_steps: field("maxSteps").and_then(|v| v.parse().ok()),
        thinking_level: field("thinkingLevel").filter(|v| !v.is_empty()),
        can_dispatch: can_dispatch.into_iter().filter(|t| t != "all").collect(),
        can_dispatch_all,
    }
}

fn unquote(value: &str) -> String {
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str) -> &'static AgentDef {
        get_agent(name).unwrap_or_else(|| panic!("missing agent {name}"))
    }

    #[test]
    fn catalog_names_match_the_schema_enum() {
        assert_eq!(
            agent_names(),
            vec![
                "code-reviewer",
                "codebase-orchestrator",
                "commit-writer",
                "explore",
                "general-purpose",
                "pr-creator",
                "security-reviewer",
                "simplifier",
                "web-research",
            ]
        );
    }

    #[test]
    fn frontmatter_fields_parse() {
        let reviewer = agent("code-reviewer");
        assert_eq!(reviewer.description, "Finds correctness bugs in a diff with finder angles and three-state verification. Read-only.");
        assert!(reviewer.when_to_use.starts_with("Reviewing a diff"));
        assert_eq!(
            reviewer.allowed_tools,
            vec!["read_file", "grep", "glob", "list_dir", "directory_tree", "git_repo"]
        );
        assert_eq!(reviewer.max_steps, Some(20));
        assert_eq!(reviewer.thinking_level.as_deref(), Some("medium"));
        assert!(reviewer.can_dispatch.is_empty() && !reviewer.can_dispatch_all);
        assert!(reviewer.system_prompt.starts_with("You are a code-review specialist"));
        assert!(!reviewer.system_prompt.contains("whenToUse"), "frontmatter stripped");
    }

    #[test]
    fn every_agent_is_tool_enabled_with_a_prompt() {
        for a in builtin_agents() {
            assert!(!a.description.is_empty(), "{}", a.name);
            assert!(!a.when_to_use.is_empty(), "{}", a.name);
            assert!(a.system_prompt.starts_with("You are"), "{}", a.name);
            assert!(!a.allowed_tools.is_empty(), "{}: live catalog is all multi-step", a.name);
            assert!(a.max_steps.unwrap_or(0) > 0, "{}", a.name);
        }
    }

    #[test]
    fn can_dispatch_grants_are_declarative() {
        let gp = agent("general-purpose");
        assert!(can_dispatch_to(gp, "explore"));
        assert!(!can_dispatch_to(gp, "simplifier"));
        let orchestrator = agent("codebase-orchestrator");
        assert!(can_dispatch_to(orchestrator, "explore"));
        assert!(can_dispatch_to(orchestrator, "general-purpose"));
        assert!(!can_dispatch_to(agent("explore"), "explore"));
    }

    #[test]
    fn effective_tools_add_dispatch_only_when_granted() {
        let gp = effective_child_tools(agent("general-purpose"));
        assert!(gp.contains(&"dispatch_agent".to_owned()));
        assert!(gp.contains(&"edit_file".to_owned()));
        let explore = effective_child_tools(agent("explore"));
        assert!(!explore.contains(&"dispatch_agent".to_owned()));
    }

    #[test]
    fn risk_tiers_rank_the_tool_subsets() {
        assert_eq!(agent_risk_tier(agent("code-reviewer")), RiskTier::ReadOnly);
        assert_eq!(agent_risk_tier(agent("web-research")), RiskTier::ReadOnly);
        assert_eq!(agent_risk_tier(agent("general-purpose")), RiskTier::Destructive, "bash in subset");
        assert_eq!(agent_risk_tier(agent("simplifier")), RiskTier::Write);
        assert_eq!(agent_risk_tier(agent("commit-writer")), RiskTier::Destructive, "git tool");
    }
}
