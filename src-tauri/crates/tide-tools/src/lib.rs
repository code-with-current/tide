//! tide-tools — Tide's built-in agent tools plus the permission gate that
//! guards them. Engine-agnostic by design: nothing here imports rig or
//! tide-engine; the orchestrator (app crate) adapts [`ToolSpec`] into the
//! engine's tool definitions and consults [`permission::PermissionGate`]
//! BEFORE calling [`Tool::execute`].
//!
//! Ports of the TS stack at `91ec558`:
//! - tool bodies: `app/core/agent/tools/{read-file,write-file,edit-file,bash,grep,glob,list-dir,directory-tree,read-media-file,multi-edit,notebook-edit,background-shell,git,git-repo,web-fetch,web-search,todo-write,slash-command,init,memory,load-skill}.ts`
//! - path sandboxing: `app/core/agent/path-safety.ts` → [`path_safety`]
//! - permission gate: `app/core/agent/permission.ts` + `permissions/rules.ts`
//!   + `permission-wrapper.ts` → [`permission`]
//!
//! [`ToolOutcome`] mirrors the TS `ToolResult` (status/output/display/
//! durationMs/meta) so the orchestrator can persist v2 tool parts
//! (`{toolName, input, output, status, durationMs}`) and emit
//! `tool_result` AgentEvents carrying `display`/`meta` without adaptation.

pub mod agents;
pub mod http;
pub mod path_safety;
pub mod permission;
pub mod shell_registry;
pub mod tools;

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub use agents::{
    agent_risk_tier, agent_names, builtin_agents, can_dispatch_to, effective_child_tools,
    get_agent, AgentDef, DEFAULT_MAX_STEPS, MAX_AGENT_DEPTH,
};
pub use permission::{AutonomyMode, Decision, PermissionGate, RiskTier};
pub use tools::{
    core_tools, BashOutputTool, BashTool, DirectoryTreeTool, DispatchAgentTool, EditFileTool,
    GitRepoTool, GitTool, GlobTool, GrepTool, InitTool, KillShellTool, ListDirTool, LoadSkillTool,
    MemoryIndex, MemoryTool, MultiEditTool, NotebookEditTool, ReadFileTool, ReadMediaFileTool,
    SlashCommandTool, TodoWriteTool, WebFetchTool, WebSearchTool, WriteFileTool,
};
pub use tools::load_skill::{build_skill_catalog_md, builtin_skills, SkillSummary};
pub use tools::memory::{MemoryHit, rrf_fuse};
pub use tools::todo_write::{TodoItem, TodoPriority, TodoState, TodoStatus, TodosUpdated};

/// A tool offered to the model — shape mirrors the engine's `ToolSpec`
/// (field-for-field) and the entries in
/// `tide-engine/fixtures/schemas/tools.json`. Defined locally so this crate
/// stays independent of tide-engine/rig; the orchestrator converts trivially.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema (object) describing the tool's arguments.
    pub parameters: serde_json::Value,
}

/// Turn-abort flag shared between the orchestrator and running tools.
/// The orchestrator holds a clone and calls [`AbortFlag::abort`] on
/// `chat_abort`; long-running tools (bash) poll [`AbortFlag::is_aborted`]
/// and terminate early with [`OutcomeStatus::Aborted`].
#[derive(Clone, Debug, Default)]
pub struct AbortFlag(Arc<AtomicBool>);

impl AbortFlag {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn abort(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn is_aborted(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Everything a tool needs at execution time. Port of the TS `ToolContext`
/// fields the built-in tools actually consumed: workspace root, session id,
/// workspace id (the memory tool's store key), the shared [`TodoState`]
/// side-channel (todo_write stores + broadcasts through it), and the parent
/// turn's abort signal. Mutable per-turn state the TS version carried
/// (autonomy mode escalation) lives in the orchestrator instead — the gate
/// runs before execute here, not inside it.
#[derive(Clone, Debug)]
pub struct ToolContext {
    pub session_id: String,
    pub workspace_root: PathBuf,
    /// The memory tool's workspace store key; empty until the orchestrator
    /// wires the active workspace id (memory then reports "no active
    /// workspace", matching the TS behavior for a missing id).
    pub workspace_id: String,
    /// Session-scoped todo store + change bus shared by every turn of the
    /// app. todo_write REPLACES the session's list and notifies
    /// subscribers — the orchestrator forwards those as `todosUpdated`
    /// renderer pushes (see [`TodoState`] docs for the T7 wiring).
    pub todo_state: Arc<TodoState>,
    pub abort: AbortFlag,
}

impl ToolContext {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            session_id: String::new(),
            workspace_root: workspace_root.into(),
            workspace_id: String::new(),
            todo_state: TodoState::shared(),
            abort: AbortFlag::new(),
        }
    }
}

/// Status line for a finished tool call. Serializes to the renderer's
/// `ToolCallStatus` strings (`src/types/index.ts`); the v2 tool part's
/// `status` field uses the same vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutcomeStatus {
    Executed,
    Failed,
    Rejected,
    Timeout,
    Aborted,
}

/// One line of a [`ToolDisplay::Diff`] hunk. Field-compatible with the
/// renderer's `DiffLine` (`{ type, oldNo?, newNo?, text }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum DiffLine {
    Context {
        #[serde(skip_serializing_if = "Option::is_none")]
        old_no: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        new_no: Option<u64>,
        text: String,
    },
    Add {
        #[serde(skip_serializing_if = "Option::is_none")]
        new_no: Option<u64>,
        text: String,
    },
    Del {
        #[serde(skip_serializing_if = "Option::is_none")]
        old_no: Option<u64>,
        text: String,
    },
    Hunk {
        text: String,
    },
}

/// Field-compatible with the renderer's `DiffHunk` (`{ header, lines }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// Richer UI-facing payload for the renderer's tool chips — field-compatible
/// with the `ToolDisplay` union in `src/types/index.ts` (tagged `kind`,
/// camelCase fields), restricted to the kinds the built-in tools emit.
/// Rides the live `tool_result` AgentEvent; it is NOT part of the persisted
/// v2 tool part data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ToolDisplay {
    Diff {
        path: String,
        hunks: Vec<DiffHunk>,
        additions: u64,
        deletions: u64,
    },
    Command {
        command: String,
    },
    FileList {
        paths: Vec<String>,
    },
    Text {
        text: String,
    },
    /// Compact "loaded <path> · N lines · N bytes" card with the body
    /// collapsible (slash_command + load_skill).
    FileLoaded {
        path: String,
        lines: u64,
        bytes: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        body: String,
    },
    Media {
        data_url: String,
        mime_type: String,
    },
    /// Live sub-agent report for dispatch_agent — the renderer's AgentDetail
    /// row (`{ kind: 'agent', agentName, title?, task, report, reasoning?,
    /// dispatchId? }`; the TS runtime never populated `usage`/`background*`).
    /// `dispatch_id` is the child session id — what `resumeFrom` refers to.
    Agent {
        agent_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        task: String,
        report: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dispatch_id: Option<String>,
    },
}

/// Result of a tool execution — the TS `ToolResult` contract. `output` is
/// the short model-facing summary; `display`, `meta` and `duration_ms`
/// feed the renderer's tool-result event and the v2 part data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcome {
    pub status: OutcomeStatus,
    pub output: String,
    pub display: Option<ToolDisplay>,
    pub meta: Option<String>,
    pub duration_ms: Option<u64>,
}

impl ToolOutcome {
    pub fn executed(output: impl Into<String>) -> Self {
        Self {
            status: OutcomeStatus::Executed,
            output: output.into(),
            display: None,
            meta: None,
            duration_ms: None,
        }
    }

    pub fn failed(output: impl Into<String>) -> Self {
        Self {
            status: OutcomeStatus::Failed,
            output: output.into(),
            display: None,
            meta: None,
            duration_ms: None,
        }
    }

    pub fn rejected(output: impl Into<String>) -> Self {
        Self {
            status: OutcomeStatus::Rejected,
            output: output.into(),
            display: None,
            meta: None,
            duration_ms: None,
        }
    }

    pub fn with_display(mut self, display: ToolDisplay) -> Self {
        self.display = Some(display);
        self
    }

    pub fn with_meta(mut self, meta: impl Into<String>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn with_duration_ms(mut self, ms: u64) -> Self {
        self.duration_ms = Some(ms);
        self
    }
}

/// Errors for contract-level failures the orchestrator turns into error
/// events. Ordinary operational failures (missing file, non-zero exit,
/// path escape) are [`ToolOutcome`]s with a failed/rejected status — the
/// TS tools returned those as values too, so the model sees the reason.
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid arguments for {tool}: {message}")]
    InvalidArgs { tool: String, message: String },
    #[error("execution aborted")]
    Aborted,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
}

/// The engine-agnostic tool contract. The orchestrator lists [`Tool::spec`]
/// for the model, gates each call via [`permission::PermissionGate::check`],
/// and only then calls [`Tool::execute`].
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn risk_tier(&self) -> RiskTier;
    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError>;
}

/// Secret-blocklist + inline-content redaction hook (TS `redaction.ts`).
/// Currently a passthrough exactly like the TS version — every read tool
/// routes through it so a future scanner slots in without touching
/// call sites.
pub fn redact(content: impl Into<String>) -> String {
    content.into()
}

#[cfg(test)]
mod tests {
    #[test]
    fn crate_version_matches_workspace() {
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.4.0");
    }

    use super::*;

    #[test]
    fn core_registry_has_the_core_tools_with_meta() {
        let tools = core_tools();
        let names: Vec<String> = tools.iter().map(|t| t.spec().name).collect();
        assert_eq!(
            names,
            vec![
                "read_file",
                "list_dir",
                "directory_tree",
                "read_media_file",
                "glob",
                "grep",
                "edit_file",
                "multi_edit",
                "write_file",
                "notebook_edit",
                "bash",
                "bash_output",
                "kill_shell",
                "git",
                "git_repo",
                "web_fetch",
                "web_search",
                "dispatch_agent",
                "todo_write",
                "slash_command",
                "memory",
                "init",
                "load_skill",
            ]
        );
        for t in &tools {
            let spec = t.spec();
            assert!(!spec.description.is_empty());
            assert_eq!(spec.parameters["type"], "object");
            assert!(spec.parameters["required"].is_array() || spec.parameters.get("required").is_none());
            assert_eq!(t.risk_tier(), permission::risk_tier_for(&spec.name));
        }
        // Spot-check the tiers the TS tool-meta sidecar assigned.
        assert_eq!(tools[0].risk_tier(), RiskTier::ReadOnly);
        assert_eq!(tools[3].risk_tier(), RiskTier::ReadOnly);
        assert_eq!(tools[7].risk_tier(), RiskTier::Write);
        assert_eq!(tools[9].risk_tier(), RiskTier::Write);
        assert_eq!(tools[10].risk_tier(), RiskTier::Destructive);
        assert_eq!(tools[11].risk_tier(), RiskTier::ReadOnly);
        assert_eq!(tools[12].risk_tier(), RiskTier::Write);
        assert_eq!(tools[13].risk_tier(), RiskTier::Destructive);
        assert_eq!(tools[14].risk_tier(), RiskTier::ReadOnly);
        // M3 T4 web tools: read-tier per TS toolMeta.
        assert_eq!(tools[15].risk_tier(), RiskTier::ReadOnly);
        assert_eq!(tools[16].risk_tier(), RiskTier::ReadOnly);
        // M3 T6 dispatch_agent: read-tier (the target agent's effective
        // tier is gated separately at dispatch time).
        assert_eq!(tools[17].risk_tier(), RiskTier::ReadOnly);
        // M3 T3 batch: all read-tier per TS toolMeta.
        for t in &tools[18..=22] {
            assert_eq!(t.risk_tier(), RiskTier::ReadOnly);
        }
    }

    /// Guard drift against the frozen tool schemas the TS stack shipped
    /// (tide-engine fixtures). Skips silently when the sibling crate's
    /// fixture file isn't present (e.g. published builds).
    #[test]
    fn specs_match_engine_fixture_schemas() {
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tide-engine/fixtures/schemas/tools.json");
        let Ok(raw) = std::fs::read_to_string(&fixture_path) else {
            return;
        };
        let fixtures: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let by_name = |name: &str| {
            fixtures
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .cloned()
                .unwrap()
        };
        for tool in core_tools() {
            let spec = tool.spec();
            let fixture = by_name(&spec.name);
            assert_eq!(spec.description, fixture["description"], "{}", spec.name);
            assert_eq!(spec.parameters, fixture["schema"], "{}", spec.name);
        }
    }

    /// The full orchestrator flow T4 will drive: gate consult → (ask →
    /// approve) → execute → v2 tool part + tool_result event assembly.
    #[test]
    fn orchestrator_flow_gate_ask_execute_and_map_to_v2_part() {
        let tmp = tempfile::tempdir().unwrap();
        let gate = permission::PermissionGate::default();

        // 1. Gate consult BEFORE execution (ask mode + bash = destructive).
        let args = serde_json::json!({"command": "echo gated-flow"});
        let decision = gate.check(AutonomyMode::Ask, "bash", &args);
        let permission::Decision::Ask {
            risk,
            allow_rule,
            ..
        } = &decision
        else {
            panic!("expected ask, got {decision:?}");
        };
        assert_eq!(*risk, RiskTier::Destructive);
        assert_eq!(allow_rule, "bash(echo)");

        // 2. User approves (renderer permission_respond → Allow).
        let approved = matches!(decision, permission::Decision::Ask { .. });

        // 3. Execute via the registry lookup the orchestrator performs.
        let tool = core_tools()
            .into_iter()
            .find(|t| t.spec().name == "bash")
            .unwrap();
        let ctx = ToolContext::new(tmp.path().to_path_buf());
        let outcome = tool
            .execute(&ctx, args.clone())
            .expect("execute must succeed when approved");
        assert_eq!(outcome.status, OutcomeStatus::Executed);
        assert!(approved);

        // 4. v2 tool part data (persisted; display/meta do NOT ride here).
        let part_data = serde_json::json!({
            "toolName": tool.spec().name,
            "input": args,
            "output": outcome.output,
            "status": outcome.status,
            "durationMs": outcome.duration_ms,
        });
        assert_eq!(part_data["toolName"], "bash");
        assert_eq!(part_data["input"]["command"], "echo gated-flow");
        assert_eq!(part_data["status"], "executed");
        assert!(part_data["durationMs"].is_u64());
        assert!(part_data.get("display").is_none());

        // 5. tool_result AgentEvent fields (live stream carries display+meta).
        let event = serde_json::json!({
            "type": "tool_result",
            "status": outcome.status,
            "output": outcome.output,
            "display": outcome.display,
            "meta": outcome.meta,
            "durationMs": outcome.duration_ms,
        });
        assert_eq!(event["status"], "executed");
        assert_eq!(event["display"]["kind"], "command");
        assert_eq!(event["display"]["command"], "echo gated-flow");
        assert!(event["meta"].as_str().unwrap().starts_with("exit 0"));
    }

    #[test]
    fn orchestrator_flow_denied_by_rule_maps_to_rejected_result() {
        let tmp = tempfile::tempdir().unwrap();
        let rules = permission::RuleSet {
            allow: vec![],
            deny: vec![permission::parse_rule("bash(rm *)").unwrap()],
        };
        let gate = permission::PermissionGate::new(rules);
        let args = serde_json::json!({"command": "rm -rf build"});
        match gate.check(AutonomyMode::FullAccess, "bash", &args) {
            permission::Decision::Deny { reason } => {
                let outcome = ToolOutcome::rejected(reason);
                assert_eq!(outcome.status, OutcomeStatus::Rejected);
                assert!(outcome.output.contains("Denied by permission rule"));
            }
            other => panic!("expected deny, got {other:?}"),
        }
        // Nothing executed — the workspace stays empty.
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    #[test]
    fn abort_flag_roundtrip() {
        let flag = AbortFlag::new();
        assert!(!flag.is_aborted());
        let clone = flag.clone();
        clone.abort();
        assert!(flag.is_aborted());
    }

    #[test]
    fn outcome_status_serializes_to_tool_call_status_strings() {
        assert_eq!(
            serde_json::to_value(OutcomeStatus::Executed).unwrap(),
            serde_json::json!("executed")
        );
        assert_eq!(
            serde_json::to_value(OutcomeStatus::Timeout).unwrap(),
            serde_json::json!("timeout")
        );
    }

    #[test]
    fn tool_display_serializes_to_renderer_shape() {
        let display = ToolDisplay::Diff {
            path: "src/a.ts".into(),
            hunks: vec![DiffHunk {
                header: "@@ -1,2 +1,2 @@ src/a.ts".into(),
                lines: vec![
                    DiffLine::Hunk {
                        text: "@@ -1,2 +1,2 @@ src/a.ts".into(),
                    },
                    DiffLine::Del {
                        old_no: Some(1),
                        text: "old".into(),
                    },
                    DiffLine::Add {
                        new_no: Some(0),
                        text: "new".into(),
                    },
                ],
            }],
            additions: 1,
            deletions: 1,
        };
        let v = serde_json::to_value(&display).unwrap();
        assert_eq!(v["kind"], "diff");
        assert_eq!(v["path"], "src/a.ts");
        assert_eq!(v["additions"], 1);
        assert_eq!(v["hunks"][0]["lines"][1]["type"], "del");
        assert_eq!(v["hunks"][0]["lines"][1]["oldNo"], 1);
        assert_eq!(v["hunks"][0]["lines"][2]["type"], "add");
        assert_eq!(v["hunks"][0]["lines"][2]["newNo"], 0);

        let cmd = ToolDisplay::FileList {
            paths: vec!["a/b.ts".into()],
        };
        let v = serde_json::to_value(&cmd).unwrap();
        assert_eq!(v["kind"], "file_list");
        assert_eq!(v["paths"][0], "a/b.ts");

        let media = ToolDisplay::Media {
            data_url: "data:image/png;base64,AAA".into(),
            mime_type: "image/png".into(),
        };
        let v = serde_json::to_value(&media).unwrap();
        assert_eq!(v["kind"], "media");
        assert_eq!(v["dataUrl"], "data:image/png;base64,AAA");
        assert_eq!(v["mimeType"], "image/png");

        let loaded = ToolDisplay::FileLoaded {
            path: "commands/x.md".into(),
            lines: 3,
            bytes: 46,
            description: Some("First line".into()),
            body: "First line\n\nBody".into(),
        };
        let v = serde_json::to_value(&loaded).unwrap();
        assert_eq!(v["kind"], "file_loaded");
        assert_eq!(v["path"], "commands/x.md");
        assert_eq!(v["lines"], 3);
        assert_eq!(v["bytes"], 46);
        assert_eq!(v["description"], "First line");
        assert_eq!(v["body"], "First line\n\nBody");

        let bare = ToolDisplay::FileLoaded {
            path: "builtin:x".into(),
            lines: 1,
            bytes: 2,
            description: None,
            body: "b".into(),
        };
        let v = serde_json::to_value(&bare).unwrap();
        assert!(v.get("description").is_none());
    }
}
