//! Permission gate — port of `app/core/agent/permission.ts` +
//! `permission-wrapper.ts` (91ec558), adapted to the Rust architecture:
//! instead of wrapping tool execution, the orchestrator consults
//! [`PermissionGate::check`] BEFORE executing a tool call. `Ask` outcomes
//! become a renderer `permission_required` event (FloatingPermissionCard)
//! and the orchestrator awaits `permission_respond`; a user-approved mode
//! escalation (plan→edit) sticks for the rest of the turn by mutating the
//! session's mode — the same semantics as the TS wrapper mutating
//! `ctx.autonomyMode`.

pub mod rules;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use rules::{
    derive_rule_spec, evaluate_rules, load_permission_rules, merge_rules, parse_rule, primary_arg,
    Rule, RuleOutcome, RuleSet,
};

/// Session autonomy mode — the TS `AutonomyMode` strings
/// ('plan' | 'ask' | 'edit' | 'full'; the renderer's mode selector uses
/// 'full-access' for full).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AutonomyMode {
    Plan,
    Ask,
    Edit,
    #[serde(rename = "full")]
    FullAccess,
}

impl AutonomyMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            AutonomyMode::Plan => "plan",
            AutonomyMode::Ask => "ask",
            AutonomyMode::Edit => "edit",
            AutonomyMode::FullAccess => "full",
        }
    }
}

/// Tool risk tier (TS `RiskTier`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskTier {
    ReadOnly,
    Write,
    Destructive,
}

/// The autonomy-matrix outcome before rules are applied — port of the TS
/// `GateDecision` ('auto' | 'ask' | 'blocked').
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    Auto,
    Ask,
    Blocked,
}

/// Port of the TS `checkPermission` matrix:
/// - plan blocks all mutation outright (reads still auto);
/// - ask auto-runs reads, prompts for writes/destructive;
/// - edit auto-runs reads+writes, still prompts destructive (wider blast
///   radius);
/// - full trusts everything.
pub fn check_permission(risk_tier: RiskTier, autonomy_mode: AutonomyMode) -> GateDecision {
    match autonomy_mode {
        AutonomyMode::Plan => {
            if risk_tier == RiskTier::ReadOnly {
                GateDecision::Auto
            } else {
                GateDecision::Blocked
            }
        }
        AutonomyMode::Ask => {
            if risk_tier == RiskTier::ReadOnly {
                GateDecision::Auto
            } else {
                GateDecision::Ask
            }
        }
        AutonomyMode::Edit => match risk_tier {
            RiskTier::ReadOnly | RiskTier::Write => GateDecision::Auto,
            RiskTier::Destructive => GateDecision::Ask,
        },
        AutonomyMode::FullAccess => GateDecision::Auto,
    }
}

/// The gate's answer for one tool call. The orchestrator executes on
/// [`Decision::Allow`], surfaces [`Decision::Ask`] to the renderer, and
/// short-circuits with a rejected tool result on [`Decision::Deny`].
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Allow,
    Deny {
        reason: String,
    },
    Ask {
        risk: RiskTier,
        reason: String,
        /// Pre-derived "always allow" rule spec for the card's session-rule
        /// action (TS sent `ruleSpec: deriveRuleSpec(...)` on the
        /// permission event).
        allow_rule: String,
    },
}

/// Risk tier per tool name — port of the TS `toolMeta` sidecar entries for
/// the built-in tools. Unknown tools are treated as destructive (the
/// conservative tier: asks in everything but full mode).
pub fn risk_tier_for(tool_name: &str) -> RiskTier {
    match tool_name {
        "read_file" | "grep" | "glob" | "list_dir" | "directory_tree" | "read_media_file"
        | "bash_output" | "git_repo" => RiskTier::ReadOnly,
        "write_file" | "edit_file" | "multi_edit" | "notebook_edit" | "kill_shell" => {
            RiskTier::Write
        }
        // The git tool executes a whole subcommand per call; the static
        // sidecar tier is destructive (TS toolMeta). [`risk_tier_for_call`]
        // refines it per subcommand at gate time.
        "git" => RiskTier::Destructive,
        _ => RiskTier::Destructive,
    }
}

/// Args-aware tier for one concrete call. The `git` tool's tier follows
/// its first `args` element: reads (status/diff/log/show/branch) are
/// read_only, index/commit mutations (add/commit/restore/reset) are
/// write, anything else keeps the destructive default. All other tools
/// are name-keyed like the TS sidecar.
pub fn risk_tier_for_call(tool_name: &str, args: &Value) -> RiskTier {
    if tool_name == "git" {
        if let Some(sub) = args
            .get("args")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
        {
            return crate::tools::git::subcommand_tier(sub);
        }
    }
    risk_tier_for(tool_name)
}

/// The synchronous permission gate. Holds the merged rule set (session
/// rules + project `.agents/settings.json` rules); re-check any time with
/// [`PermissionGate::set_rules`].
#[derive(Debug, Clone, Default)]
pub struct PermissionGate {
    rules: RuleSet,
}

impl PermissionGate {
    pub fn new(rules: RuleSet) -> Self {
        Self { rules }
    }

    /// Gate with project rules loaded fresh from the workspace (the TS
    /// wrapper re-read the file at gate time so mid-turn rule writes are
    /// visible; do the same by constructing per turn — or per call).
    pub fn from_workspace(workspace_root: &std::path::Path) -> Self {
        Self {
            rules: load_permission_rules(workspace_root),
        }
    }

    pub fn set_rules(&mut self, rules: RuleSet) {
        self.rules = rules;
    }

    pub fn rules(&self) -> &RuleSet {
        &self.rules
    }

    /// Decide for one tool call. Semantics ported from the TS wrapper:
    /// 1. a matching deny rule → [`Decision::Deny`];
    /// 2. autonomy matrix (risk tier × mode) → auto / ask / blocked;
    /// 3. a matching allow rule upgrades ask → allow, but never bypasses
    ///    plan-mode blocking;
    /// 4. everything else → [`Decision::Ask`] (plan-mode blocks included —
    ///    the TS still surfaced a card so the user could escalate).
    pub fn check(&self, mode: AutonomyMode, tool_name: &str, args: &Value) -> Decision {
        if evaluate_rules(&self.rules, tool_name, args) == Some(RuleOutcome::Deny) {
            return Decision::Deny {
                reason:
                    "Denied by permission rule (.agent/settings.json or session)."
                        .to_string(),
            };
        }

        let tier = risk_tier_for_call(tool_name, args);
        let allow_by_rule = evaluate_rules(&self.rules, tool_name, args) == Some(RuleOutcome::Allow);
        match check_permission(tier, mode) {
            GateDecision::Auto => Decision::Allow,
            GateDecision::Ask if allow_by_rule => Decision::Allow,
            GateDecision::Ask => Decision::Ask {
                risk: tier,
                reason: format!(
                    "{} needs approval (risk tier: {}).",
                    tool_name,
                    tier.label()
                ),
                allow_rule: derive_rule_spec(tool_name, args),
            },
            GateDecision::Blocked => Decision::Ask {
                risk: tier,
                reason: format!(
                    "Plan mode is read-only — {} (risk tier: {}) is blocked. Escalate the mode to run it.",
                    tool_name,
                    tier.label()
                ),
                allow_rule: derive_rule_spec(tool_name, args),
            },
        }
    }
}

impl RiskTier {
    pub fn label(&self) -> &'static str {
        match self {
            RiskTier::ReadOnly => "read_only",
            RiskTier::Write => "write",
            RiskTier::Destructive => "destructive",
        }
    }
}

/// Human-readable label for a matrix decision — port of the TS `gateLabel`
/// (used for UI badges).
pub fn gate_label(decision: GateDecision) -> &'static str {
    match decision {
        GateDecision::Auto => "auto-approved",
        GateDecision::Ask => "needs approval",
        GateDecision::Blocked => "blocked by mode",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gate(rules: RuleSet) -> PermissionGate {
        PermissionGate::new(rules)
    }

    #[test]
    fn check_permission_matrix() {
        use AutonomyMode::*;
        use RiskTier::*;
        // plan: reads auto, everything else blocked.
        assert_eq!(check_permission(ReadOnly, Plan), GateDecision::Auto);
        assert_eq!(check_permission(Write, Plan), GateDecision::Blocked);
        assert_eq!(check_permission(Destructive, Plan), GateDecision::Blocked);
        // ask: reads auto, rest ask.
        assert_eq!(check_permission(ReadOnly, Ask), GateDecision::Auto);
        assert_eq!(check_permission(Write, Ask), GateDecision::Ask);
        assert_eq!(check_permission(Destructive, Ask), GateDecision::Ask);
        // edit: reads+writes auto, destructive ask.
        assert_eq!(check_permission(ReadOnly, Edit), GateDecision::Auto);
        assert_eq!(check_permission(Write, Edit), GateDecision::Auto);
        assert_eq!(check_permission(Destructive, Edit), GateDecision::Ask);
        // full: everything auto.
        for tier in [ReadOnly, Write, Destructive] {
            assert_eq!(check_permission(tier, FullAccess), GateDecision::Auto);
        }
    }

    #[test]
    fn mode_tool_matrix_via_gate() {
        let g = gate(RuleSet::default());
        let read = json!({"path": "a.ts"});
        let write = json!({"path": "a.ts", "content": "x"});
        let cmd = json!({"command": "ls"});

        // read-only tools auto-approve in every mode.
        for mode in [AutonomyMode::Plan, AutonomyMode::Ask, AutonomyMode::Edit, AutonomyMode::FullAccess] {
            assert_eq!(g.check(mode, "read_file", &read), Decision::Allow, "{mode:?}");
            assert_eq!(g.check(mode, "grep", &json!({"pattern": "x"})), Decision::Allow);
        }
        // write tools: blocked-ish in plan (Ask with escalation reason), ask in ask, auto in edit/full.
        assert!(matches!(g.check(AutonomyMode::Plan, "write_file", &write), Decision::Ask { .. }));
        assert!(matches!(g.check(AutonomyMode::Ask, "write_file", &write), Decision::Ask { .. }));
        assert_eq!(g.check(AutonomyMode::Edit, "edit_file", &write), Decision::Allow);
        assert_eq!(g.check(AutonomyMode::FullAccess, "write_file", &write), Decision::Allow);
        // bash (destructive): ask everywhere except full.
        assert!(matches!(g.check(AutonomyMode::Ask, "bash", &cmd), Decision::Ask { .. }));
        assert!(matches!(g.check(AutonomyMode::Edit, "bash", &cmd), Decision::Ask { .. }));
        assert_eq!(g.check(AutonomyMode::FullAccess, "bash", &cmd), Decision::Allow);
    }

    #[test]
    fn ask_carries_risk_reason_and_allow_rule() {
        let g = gate(RuleSet::default());
        let Decision::Ask { risk, reason, allow_rule } =
            g.check(AutonomyMode::Ask, "bash", &json!({"command": "pnpm test"}))
        else {
            panic!("expected ask");
        };
        assert_eq!(risk, RiskTier::Destructive);
        assert!(reason.contains("needs approval"));
        assert_eq!(allow_rule, "bash(pnpm test)");

        let Decision::Ask { reason, .. } = g.check(
            AutonomyMode::Plan,
            "write_file",
            &json!({"path": "src/x.ts", "content": ""}),
        ) else {
            panic!("expected ask");
        };
        assert!(reason.contains("Plan mode is read-only"));
    }

    #[test]
    fn deny_rule_blocks_even_in_full_mode() {
        let rules = RuleSet {
            allow: vec![],
            deny: vec![parse_rule("bash(curl *)").unwrap()],
        };
        let g = gate(rules);
        let Decision::Deny { reason } =
            g.check(AutonomyMode::FullAccess, "bash", &json!({"command": "curl --version -X"}))
        else {
            panic!("expected deny");
        };
        assert!(reason.contains("Denied by permission rule"));
        // Non-matching command still allowed.
        assert_eq!(g.check(AutonomyMode::FullAccess, "bash", &json!({"command": "ls"})), Decision::Allow);
    }

    #[test]
    fn allow_rule_upgrades_ask_but_not_plan_block() {
        let rules = RuleSet {
            allow: vec![parse_rule("bash(pnpm test)").unwrap()],
            deny: vec![],
        };
        let g = gate(rules);
        // ask mode: allow rule upgrades to auto.
        assert_eq!(
            g.check(AutonomyMode::Ask, "bash", &json!({"command": "pnpm test --ci"})),
            Decision::Allow
        );
        // plan mode: the block still surfaces (explicit escalation needed).
        assert!(matches!(
            g.check(AutonomyMode::Plan, "bash", &json!({"command": "pnpm test"})),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn session_and_file_rules_merge() {
        let session = RuleSet {
            allow: vec![parse_rule("bash(cargo)").unwrap()],
            deny: vec![],
        };
        let file = RuleSet {
            allow: vec![],
            deny: vec![parse_rule("bash(git push*)").unwrap()],
        };
        let g = gate(merge_rules(&session, &file));
        assert_eq!(
            g.check(AutonomyMode::Ask, "bash", &json!({"command": "cargo build"})),
            Decision::Allow
        );
        assert!(matches!(
            g.check(AutonomyMode::FullAccess, "bash", &json!({"command": "git push origin main"})),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn from_workspace_loads_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".agents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"permissions": {"allow": ["read_file"]}}"#,
        )
        .unwrap();
        let g = PermissionGate::from_workspace(tmp.path());
        assert_eq!(g.rules().allow.len(), 1);
    }

    #[test]
    fn unknown_tool_is_destructive() {
        assert_eq!(risk_tier_for("some_mcp_tool"), RiskTier::Destructive);
        let g = gate(RuleSet::default());
        assert!(matches!(
            g.check(AutonomyMode::Ask, "some_mcp_tool", &json!({})),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn git_tier_refines_per_subcommand() {
        use RiskTier::*;
        // Reads auto-approve even in plan mode.
        for sub in ["status", "diff", "log", "show", "branch"] {
            let args = json!({"args": [sub]});
            assert_eq!(risk_tier_for_call("git", &args), ReadOnly, "{sub}");
        }
        // Index/commit mutations are write tier.
        for sub in ["add", "commit", "restore", "reset"] {
            assert_eq!(risk_tier_for_call("git", &args_for(sub)), Write, "{sub}");
        }
        // Everything else keeps the destructive default.
        assert_eq!(risk_tier_for_call("git", &json!({"args": ["push"]})), Destructive);
        assert_eq!(risk_tier_for_call("git", &json!({"args": []})), Destructive);
        assert_eq!(risk_tier_for_call("git", &json!({})), Destructive);
        // Static sidecar tier stays destructive (matches TS toolMeta).
        assert_eq!(risk_tier_for("git"), Destructive);

        let g = gate(RuleSet::default());
        assert_eq!(
            g.check(AutonomyMode::Plan, "git", &json!({"args": ["status", "--short"]})),
            Decision::Allow
        );
        assert!(matches!(
            g.check(AutonomyMode::Plan, "git", &json!({"args": ["add", "a.ts"]})),
            Decision::Ask { .. }
        ));
        assert!(matches!(
            g.check(AutonomyMode::Edit, "git", &json!({"args": ["commit", "-m", "x"]})),
            Decision::Allow
        ));
        assert!(matches!(
            g.check(AutonomyMode::Edit, "git", &json!({"args": ["push"]})),
            Decision::Ask { .. }
        ));
        // git_repo is read-only everywhere (TS toolMeta).
        assert_eq!(risk_tier_for("git_repo"), RiskTier::ReadOnly);
        assert_eq!(
            g.check(AutonomyMode::Plan, "git_repo", &json!({"op": "info", "repo": "https://github.com/o/r"})),
            Decision::Allow
        );
    }

    fn args_for(sub: &str) -> Value {
        json!({"args": [sub]})
    }

    #[test]
    fn git_and_git_repo_rules_match_on_primary_arg() {
        let rules = RuleSet {
            allow: vec![parse_rule("git(status)").unwrap()],
            deny: vec![parse_rule("git_repo(https://github.com/evil/*)").unwrap()],
        };
        let g = gate(rules);
        assert_eq!(
            g.check(AutonomyMode::Ask, "git", &json!({"args": ["status", "--short"]})),
            Decision::Allow
        );
        assert!(matches!(
            g.check(
                AutonomyMode::FullAccess,
                "git_repo",
                &json!({"op": "read", "repo": "https://github.com/evil/r", "file": "x"})
            ),
            Decision::Deny { .. }
        ));
        assert_eq!(
            g.check(
                AutonomyMode::FullAccess,
                "git_repo",
                &json!({"op": "read", "repo": "https://github.com/fine/r"})
            ),
            Decision::Allow
        );
    }

    #[test]
    fn gate_labels() {
        assert_eq!(gate_label(GateDecision::Auto), "auto-approved");
        assert_eq!(gate_label(GateDecision::Ask), "needs approval");
        assert_eq!(gate_label(GateDecision::Blocked), "blocked by mode");
    }

    #[test]
    fn mode_serialization() {
        assert_eq!(serde_json::to_value(AutonomyMode::FullAccess).unwrap(), json!("full"));
        assert_eq!(serde_json::to_value(AutonomyMode::Plan).unwrap(), json!("plan"));
        assert_eq!(
            serde_json::to_value(RiskTier::ReadOnly).unwrap(),
            json!("read_only")
        );
    }
}
