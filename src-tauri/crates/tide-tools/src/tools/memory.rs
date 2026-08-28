//! memory — port of `app/core/agent/tools/memory.ts` (): semantic +
//! full-text search over the workspace RAG index, fused with the global
//! knowledge-sources index, merged via reciprocal rank fusion (RRF, k=60).
//!
//! The TS tool opened SQLite + sqlite-vec stores directly. Rust keeps the
//! store behind the [`MemoryIndex`] seam: tide-rag implements it once the
//! embedding/ingestion pipeline lands; until then the orchestrator registers
//! the tool with no index and queries return the TS-faithful "RAG is not
//! enabled" hint. The knowledge-source half of the TS fusion (a global
//! index filtered per workspace) is the implementor's concern — hits carry
//! [`MemoryHit::source_name`] so origins stay citable either way.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

use super::arg_str;

const DESCRIPTION: &str = "FIRST tool to call for ANY codebase question. Searches the workspace RAG index and registered knowledge sources by meaning and returns ranked chunks in ~0.5s. Call BEFORE directory_tree, list_dir, read_file, or grep. Returns file path + line range + source body; knowledge-source hits are labeled [source] origin.";

const DEFAULT_K: u64 = 5;
const MAX_K: u64 = 20;
/// RRF constant. Standard value from the original TREC paper; balances
/// head vs tail of the rankings without tuning.
const RRF_K: f64 = 60.0;
/// Body truncation cap — keeps the tool result readable and the model's
/// context unbloated.
const BODY_CAP: usize = 1500;

/// One ranked chunk. Workspace hits carry path/line/symbol; knowledge hits
/// additionally carry `source_name` so results can cite the origin
/// ("React Docs · react.dev/guide") distinctly from repo files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    pub start_line: u64,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
}

/// The search backend the memory tool consults — the seam tide-rag fills
/// in (vector + FTS rankings over the workspace index and any registered
/// knowledge sources visible to the workspace). Methods take the
/// workspace id because the TS tool routed every store operation through
/// it — one process-wide backend resolves both halves per workspace.
pub trait MemoryIndex: std::fmt::Debug + Send + Sync {
    /// Total indexed chunks visible to this workspace.
    fn total_chunks(&self, workspace_id: &str) -> u64;
    /// Top-k vector (semantic) ranking for the query.
    fn vector_hits(&self, workspace_id: &str, query: &str, k: usize) -> Vec<MemoryHit>;
    /// Top-k full-text ranking for the query.
    fn fts_hits(&self, workspace_id: &str, query: &str, k: usize) -> Vec<MemoryHit>;
}

/// Process-wide backend slot (the [`TodoState::shared`] pattern): the
/// command layer installs the tide-rag-backed index once the RAG domain
/// comes online; until then queries take the "RAG is not enabled" hint.
static SHARED_INDEX: std::sync::RwLock<Option<std::sync::Arc<dyn MemoryIndex>>> =
    std::sync::RwLock::new(None);

/// Install (or clear) the process-wide memory index backend.
pub fn set_shared_memory_index(index: Option<std::sync::Arc<dyn MemoryIndex>>) {
    let mut guard = SHARED_INDEX.write().expect("memory index slot poisoned");
    *guard = index;
}

/// The installed backend, if any.
pub fn shared_memory_index() -> Option<std::sync::Arc<dyn MemoryIndex>> {
    SHARED_INDEX
        .read()
        .expect("memory index slot poisoned")
        .clone()
}

/// Reciprocal Rank Fusion — zero-parameter merge of two rankings using
/// rank-only signals; generic id-keyed so vector + FTS hits fuse without
/// forcing one score shape. Port of the TS `fuse`.
pub fn rrf_fuse(vec: Vec<MemoryHit>, fts: Vec<MemoryHit>, k: usize) -> Vec<MemoryHit> {
    let mut scores: Vec<(f64, MemoryHit)> = Vec::with_capacity(vec.len() + fts.len());
    let mut index_of: std::collections::HashMap<String, usize> =
        std::collections::HashMap::with_capacity(vec.len() + fts.len());
    for (rank, hit) in vec.into_iter().enumerate() {
        index_of.insert(hit.id.clone(), scores.len());
        scores.push((1.0 / (RRF_K + rank as f64 + 1.0), hit));
    }
    for (rank, hit) in fts.into_iter().enumerate() {
        let s = 1.0 / (RRF_K + rank as f64 + 1.0);
        match index_of.get(&hit.id) {
            Some(&i) => scores[i].0 += s,
            None => {
                index_of.insert(hit.id.clone(), scores.len());
                scores.push((s, hit));
            }
        }
    }
    scores.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scores.truncate(k);
    scores.into_iter().map(|(_, hit)| hit).collect()
}

/// Workspace-relative path for compact display. Falls back to the full
/// path when it isn't deep enough to shorten (e.g. temp fixture paths).
pub(crate) fn short_path(abs_path: &str) -> String {
    let parts: Vec<&str> = abs_path
        .split(['/', '\\'])
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() <= 3 {
        return abs_path.to_string();
    }
    format!("…/{}", parts[..].split_at(parts.len() - 2).1.join("/"))
}

/// Shared body — testable without the trait object wrapper; the
/// workspace_id comes from the caller (the tool pulls it from ToolContext).
pub(crate) fn run_memory(
    query: &str,
    k: u64,
    workspace_id: &str,
    index: Option<&dyn MemoryIndex>,
) -> ToolOutcome {
    if query.trim().is_empty() {
        return ToolOutcome::failed("Missing required arg: query");
    }
    if workspace_id.is_empty() {
        return ToolOutcome::failed("No active workspace bound to this session.");
    }

    // No index wired ≈ the TS "RAG not enabled for this workspace" gate —
    // the tool stays useful (actionable hint) instead of failing.
    let Some(index) = index else {
        return ToolOutcome::executed(
            "RAG is not enabled for this workspace. Enable it in Settings → Memory & RAG (toggles the Switch on for this workspace; ingestion will run automatically on first enable).",
        );
    };

    let total = index.total_chunks(workspace_id);
    if total == 0 {
        return ToolOutcome::executed(
            "RAG index for this workspace is empty. Re-trigger ingestion from Settings → Memory & RAG → Re-index.",
        );
    }

    let k_clamped = k.clamp(1, MAX_K) as usize;
    let fused = rrf_fuse(
        index.vector_hits(workspace_id, query, k_clamped),
        index.fts_hits(workspace_id, query, k_clamped),
        k_clamped,
    );

    if fused.is_empty() {
        return ToolOutcome::executed(format!(
            "No matches for \"{query}\" across {total} indexed chunks."
        ));
    }

    let lines = fused
        .iter()
        .enumerate()
        .map(|(i, hit)| {
            let loc = match &hit.source_name {
                Some(source) => format!("[{source}] {}", hit.path),
                None => format!(
                    "{}:{}{}",
                    short_path(&hit.path),
                    hit.start_line,
                    hit.symbol
                        .as_deref()
                        .map(|s| format!(" ({s})"))
                        .unwrap_or_default()
                ),
            };
            let sim = hit
                .similarity
                .map(|s| format!(" · {}%", (s * 100.0).round() as u64))
                .unwrap_or_default();
            let body = if hit.content.chars().count() > BODY_CAP {
                let mut cut: String = hit.content.chars().take(BODY_CAP).collect();
                cut.push_str("\n…[truncated]");
                cut
            } else {
                hit.content.clone()
            };
            format!("[{}] {loc}{sim}\n{body}", i + 1)
        })
        .collect::<Vec<_>>();

    let text = format!(
        "Found {} relevant chunk{} for \"{query}\" (out of {total}):\n\n{}",
        fused.len(),
        if fused.len() == 1 { "" } else { "s" },
        lines.join("\n\n")
    );

    ToolOutcome::executed(text.clone()).with_display(ToolDisplay::Text { text })
}

pub struct MemoryTool {
    index: Option<Arc<dyn MemoryIndex>>,
}

impl MemoryTool {
    pub fn new(index: Option<Arc<dyn MemoryIndex>>) -> Self {
        Self { index }
    }
}

impl Tool for MemoryTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "memory".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural language: \"how is authentication handled\", \"database setup\", \"API routes\"." },
                    "k": { "type": "number", "description": "Top-K results. Default 5, max 20." }
                },
                "required": ["query"]
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
        let query = arg_str(&args, "query");
        let k = args.get("k").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_K);
        // The constructor-bound index wins (tests); production rides the
        // process-wide slot installed by the RAG command layer.
        let shared = shared_memory_index();
        let index = self.index.as_deref().or(shared.as_deref());
        Ok(run_memory(&query, k, &ctx.workspace_id, index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;

    #[derive(Debug)]
    struct FakeIndex {
        total: u64,
        vector: Vec<MemoryHit>,
        fts: Vec<MemoryHit>,
    }

    impl MemoryIndex for FakeIndex {
        fn total_chunks(&self, _workspace_id: &str) -> u64 {
            self.total
        }
        fn vector_hits(&self, _workspace_id: &str, _query: &str, k: usize) -> Vec<MemoryHit> {
            self.vector.iter().take(k).cloned().collect()
        }
        fn fts_hits(&self, _workspace_id: &str, _query: &str, k: usize) -> Vec<MemoryHit> {
            self.fts.iter().take(k).cloned().collect()
        }
    }

    fn hit(id: &str, path: &str, symbol: Option<&str>, similarity: Option<f64>) -> MemoryHit {
        MemoryHit {
            id: id.into(),
            path: path.into(),
            symbol: symbol.map(str::to_owned),
            start_line: 10,
            content: format!("content of {id}"),
            similarity,
            source_name: None,
        }
    }

    #[test]
    fn missing_query_fails() {
        let out = run_memory("", 5, "ws1", None);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Missing required arg: query");
    }

    #[test]
    fn missing_workspace_fails() {
        let out = run_memory("auth flow", 5, "", None);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "No active workspace bound to this session.");
    }

    #[test]
    fn no_index_reports_not_enabled_hint() {
        let out = run_memory("anything", 5, "ws1", None);
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out
            .output
            .starts_with("RAG is not enabled for this workspace."));
        assert!(out.output.contains("Settings → Memory & RAG"));
    }

    #[test]
    fn empty_index_reports_reindex_hint() {
        let index = FakeIndex {
            total: 0,
            vector: vec![],
            fts: vec![],
        };
        let out = run_memory("anything", 5, "ws1", Some(&index));
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out
            .output
            .starts_with("RAG index for this workspace is empty."));
    }

    #[test]
    fn no_matches_reports_total() {
        let index = FakeIndex {
            total: 42,
            vector: vec![],
            fts: vec![],
        };
        let out = run_memory("zzz", 5, "ws1", Some(&index));
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(
            out.output,
            "No matches for \"zzz\" across 42 indexed chunks."
        );
    }

    #[test]
    fn formats_workspace_and_knowledge_hits() {
        let index = FakeIndex {
            total: 7,
            vector: vec![hit("c1", "/repo/src/auth.ts", Some("login"), Some(0.87))],
            fts: vec![],
        };
        let out = run_memory("how does login work", 5, "ws1", Some(&index));
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out
            .output
            .starts_with("Found 1 relevant chunk for \"how does login work\" (out of 7):"));
        assert!(out
            .output
            .contains("[1] /repo/src/auth.ts:10 (login) · 87%\ncontent of c1"));
        assert!(matches!(out.display, Some(ToolDisplay::Text { .. })));
    }

    #[test]
    fn knowledge_hits_carry_source_label() {
        let knowledge = MemoryHit {
            source_name: Some("React Docs".into()),
            path: "react.dev/learn".into(),
            ..hit("k1", "react.dev/learn", None, None)
        };
        let index = FakeIndex {
            total: 3,
            vector: vec![knowledge],
            fts: vec![],
        };
        let out = run_memory("hooks", 5, "ws1", Some(&index));
        assert!(out.output.contains("[1] [React Docs] react.dev/learn"));
    }

    #[test]
    fn long_bodies_truncate_at_cap() {
        let long = MemoryHit {
            content: "y".repeat(BODY_CAP + 500),
            ..hit("c1", "/repo/a/b/c/d/long.ts", None, None)
        };
        let index = FakeIndex {
            total: 1,
            vector: vec![long],
            fts: vec![],
        };
        let out = run_memory("long", 5, "ws1", Some(&index));
        assert!(out.output.contains("…[truncated]"));
        assert!(!out.output.contains(&"y".repeat(BODY_CAP + 100)));
    }

    #[test]
    fn rrf_prefers_hits_present_in_both_rankings() {
        let both = hit("both", "/repo/both.ts", None, None);
        let vec = vec![hit("v-only", "/repo/v.ts", None, None), both.clone()];
        let fts = vec![both, hit("f-only", "/repo/f.ts", None, None)];
        let fused = rrf_fuse(vec, fts, 3);
        assert_eq!(fused[0].id, "both");
        assert_eq!(fused.len(), 3);
    }

    #[test]
    fn rrf_respects_k_cap() {
        let vec: Vec<_> = (0..10)
            .map(|i| hit(&format!("v{i}"), "/repo/x.ts", None, None))
            .collect();
        let fused = rrf_fuse(vec, vec![], 3);
        assert_eq!(fused.len(), 3);
    }

    #[test]
    fn short_path_keeps_shallow_paths_whole() {
        assert_eq!(short_path("/repo/a.ts"), "/repo/a.ts");
        assert_eq!(short_path("/very/deep/path/file.ts"), "…/path/file.ts");
        // Both separators split; the join is always forward-slash (TS join('/')).
        assert_eq!(short_path("C:\\a\\b\\c\\d.ts"), "…/c/d.ts");
    }

    #[test]
    fn execute_routes_through_trait_and_clamps_k() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ctx = ToolContext::new(tmp.path());
        ctx.workspace_id = "ws1".into();
        let tool = MemoryTool::new(Some(Arc::new(FakeIndex {
            total: 9,
            vector: vec![hit("c1", "/repo/src/x.ts", Some("f"), Some(0.5))],
            fts: vec![],
        })));
        assert_eq!(tool.spec().name, "memory");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);

        // k=99 clamps to MAX_K (20) — the fake index only returns 1 hit.
        let out = tool
            .execute(&ctx, serde_json::json!({ "query": "x", "k": 99 }))
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert!(out.output.contains("(out of 9)"));
    }
}
