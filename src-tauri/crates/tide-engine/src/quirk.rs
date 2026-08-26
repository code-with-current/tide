//! Provider quirk layer — param computation ported verbatim from the TS
//! adapter stack (`git show 91ec558:app/core/agent/protocols/`:
//! `reasoning.ts` + `anthropic.ts` + `openai.ts` + `tool-input-repair.ts`)
//! and validated against the M0 SSE fixtures (`fixtures/sse/`).
//!
//! Invariants (see `fixtures/sse/README.md`):
//! - **Carve, never stack**: the thinking budget is carved WITHIN the output
//!   pool — `budget = clamp(requested, ≥1024, ≤floor(pool×0.8), ≤pool−1024)`
//!   — and the wire `max_tokens` stays the (floored) pool. Budget math is
//!   re-derived from the request every step, so it never compounds.
//! - **Thinking allowlist**: the native `thinking` block is sent ONLY to
//!   `api.anthropic.com` / `api.z.ai`; other Anthropic-protocol hosts get it
//!   stripped. OpenAI-compatible hosts never get `thinking` — a budget
//!   contract degrades lossily to `reasoning_effort` instead.
//! - **Tool output floor**: when tools are present, the output pool floors
//!   at 16384 (tool-call arguments stream against the output budget).
//! - **Tool input repair**: GLM-style duplicated tool-input fragments are
//!   recovered by keeping the LAST parseable top-level JSON object.
//!
//! SSE stall watchdog: [`SSE_READ_TIMEOUT`] is applied as reqwest's
//! `read_timeout` on the injected HTTP client — per response-body read,
//! reset on every chunk — which is how the TS `wrapSSE` chunk-idle wrapper
//! behaved, without touching tool execution.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Default output pool when the model's max is unknown (`anthropic.ts` /
/// `openai.ts` DEFAULT_MAX_TOKENS).
pub const DEFAULT_MAX_TOKENS: u64 = 8192;

/// Minimum output pool when tools are present — tool-call arguments
/// (write_file/edit_file content) stream against the OUTPUT budget, and the
/// 8192 default starves large writes mid-stream.
pub const TOOL_OUTPUT_FLOOR: u64 = 16384;

/// Gemini-backed OpenAI-compatible endpoints cap `max_tokens` at 2^16−1.
const MAX_OUTPUT_TOKENS_CAP: u64 = 65535;

/// Chunk-idle timeout for SSE response bodies. Fires only while reading the
/// model's streamed response; tool execution happens after that stream ends.
pub const SSE_READ_TIMEOUT: Duration = Duration::from_secs(120);

/// Hosts that accept the native Anthropic `thinking` block. Aggregators
/// (OpenRouter-style) reject `thinking` + `cache_control` with 400.
const THINKING_CAPABLE_HOSTS: [&str; 2] = ["api.anthropic.com", "api.z.ai"];

/// Tool-result content clamp before it reaches the model (chars, with a
/// truncation marker). Tools cap their own output (e.g. bash 50KB); this is
/// the engine-side floor keeping any single result from flooding context.
const TOOL_RESULT_CHAR_FLOOR: usize = 16384;

/// User-facing thinking level — TS `ThinkingLevel` / `SessionThinkingLevel`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    #[default]
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Extra,
    Max,
}

/// One model reasoning contract (from the models.dev catalog) — TS
/// `ReasoningOption` `{ type, values?, min? }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReasoningOption {
    #[serde(rename = "type")]
    pub kind: ReasoningContractKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningContractKind {
    Effort,
    BudgetTokens,
    Toggle,
}

/// The resolved reasoning instruction — port of TS `ReasoningInstruction`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReasoningInstruction {
    pub contract: ReasoningContractKind,
    pub effort: Option<String>,
    pub budget_tokens: Option<u64>,
    pub label: String,
}

/// ThinkingLevel → effort ratio, matching OpenRouter's published formula.
const EFFORT_RATIOS: [(ThinkingLevel, f64); 6] = [
    (ThinkingLevel::Minimal, 0.1),
    (ThinkingLevel::Low, 0.2),
    (ThinkingLevel::Medium, 0.5),
    (ThinkingLevel::High, 0.8),
    (ThinkingLevel::Extra, 0.9),
    (ThinkingLevel::Max, 0.95),
];

/// Legacy fixed budget map — models with no contracts (backward compat).
const LEGACY_BUDGET: [(ThinkingLevel, u64); 6] = [
    (ThinkingLevel::Minimal, 512),
    (ThinkingLevel::Low, 1024),
    (ThinkingLevel::Medium, 8000),
    (ThinkingLevel::High, 24000),
    (ThinkingLevel::Extra, 48000),
    (ThinkingLevel::Max, 64000),
];

const EFFORT_ORDER: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];

fn level_to_effort(level: ThinkingLevel, supported_values: Option<&[String]>) -> String {
    let target = match level {
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Extra => "xhigh",
        ThinkingLevel::Off | ThinkingLevel::Max => "max",
    };
    let Some(values) = supported_values.filter(|v| !v.is_empty()) else {
        return target.to_owned();
    };
    let lower: Vec<String> = values.iter().map(|v| v.to_lowercase()).collect();
    if lower.iter().any(|v| v == target) {
        return target.to_owned();
    }
    if target == "xhigh" {
        if lower.iter().any(|v| v == "max") {
            return "max".to_owned();
        }
        if lower.iter().any(|v| v == "high") {
            return "high".to_owned();
        }
    }
    if target == "max" {
        if lower.iter().any(|v| v == "xhigh") {
            return "xhigh".to_owned();
        }
        if lower.iter().any(|v| v == "high") {
            return "high".to_owned();
        }
    }
    let target_rank = EFFORT_ORDER.iter().position(|l| *l == target);
    for level in EFFORT_ORDER {
        if let Some(rank) = target_rank {
            if lower.iter().any(|v| v == level)
                && EFFORT_ORDER.iter().position(|l| *l == level) >= Some(rank)
            {
                return level.to_owned();
            }
        }
    }
    for level in EFFORT_ORDER.iter().rev() {
        if lower.iter().any(|v| v == level) {
            return (*level).to_owned();
        }
    }
    lower.last().cloned().unwrap_or_else(|| target.to_owned())
}

/// Budget from a level via the clamped formula:
/// `min(max(floor(max_output × ratio), 1024), max_output − 1024)`.
fn compute_budget_tokens(level: ThinkingLevel, max_output_tokens: u64) -> u64 {
    let ratio = EFFORT_RATIOS
        .iter()
        .find(|(l, _)| *l == level)
        .map(|(_, r)| *r)
        .unwrap_or(0.5);
    let raw = ((max_output_tokens as f64) * ratio).floor() as u64;
    let floored = raw.max(1024);
    let ceiling = max_output_tokens.saturating_sub(1024).max(1024);
    floored.min(ceiling)
}

/// Derive an effort string from a token budget — the lossy inverse used when
/// a budget-contract model is served over an effort-only protocol.
pub fn budget_to_effort(budget: u64) -> &'static str {
    if budget >= 48000 {
        "max"
    } else if budget >= 24000 {
        "high"
    } else if budget >= 8000 {
        "medium"
    } else {
        "low"
    }
}

/// Contract-aware reasoning resolution — port of TS `resolveReasoning`.
///
/// Resolution priority: effort+OpenAI sends the string directly;
/// budget+Anthropic computes the clamped budget; effort+Anthropic becomes
/// adaptive thinking; budget+OpenAI derives effort (lossy); toggle enables
/// without levels; no contracts falls back to the legacy budget map.
/// Returns `None` when thinking is off (except the explicit
/// `reasoning_effort=none` contract case below).
pub fn resolve_reasoning(
    thinking_level: ThinkingLevel,
    contracts: &[ReasoningOption],
    api_style: crate::model::ProviderApiStyle,
    max_output_tokens: u64,
) -> Option<ReasoningInstruction> {
    use crate::model::ProviderApiStyle;
    if thinking_level == ThinkingLevel::Off {
        // Models publishing 'none' as an effort value (gpt-5.1+) expect an
        // explicit reasoning_effort='none' — omitting it leaves the provider
        // default active, so 'off' would silently still reason.
        let none_contract = contracts
            .iter()
            .find(|c| c.kind == ReasoningContractKind::Effort);
        if api_style == ProviderApiStyle::OpenAi
            && none_contract.is_some_and(|c| {
                c.values
                    .as_deref()
                    .is_some_and(|v| v.iter().any(|s| s.eq_ignore_ascii_case("none")))
            })
        {
            return Some(ReasoningInstruction {
                contract: ReasoningContractKind::Effort,
                effort: Some("none".to_owned()),
                budget_tokens: None,
                label: "reasoning_effort=none (explicit off)".to_owned(),
            });
        }
        return None;
    }

    let level = thinking_level;

    if contracts.is_empty() {
        let budget = LEGACY_BUDGET
            .iter()
            .find(|(l, _)| *l == level)
            .map(|(_, b)| *b)?;
        return Some(ReasoningInstruction {
            contract: ReasoningContractKind::BudgetTokens,
            effort: None,
            budget_tokens: Some(budget),
            label: format!("budget_tokens={budget} (legacy, no contracts)"),
        });
    }

    let effort_contract = contracts
        .iter()
        .find(|c| c.kind == ReasoningContractKind::Effort);
    let budget_contract = contracts
        .iter()
        .find(|c| c.kind == ReasoningContractKind::BudgetTokens);
    let toggle_only = effort_contract.is_none()
        && budget_contract.is_none()
        && contracts
            .iter()
            .any(|c| c.kind == ReasoningContractKind::Toggle);

    if toggle_only {
        return Some(ReasoningInstruction {
            contract: ReasoningContractKind::Toggle,
            effort: None,
            budget_tokens: None,
            label: format!("thinking=on (toggle-only, level={level:?} ignored)"),
        });
    }

    if api_style == ProviderApiStyle::OpenAi {
        if let Some(contract) = effort_contract {
            let effort = level_to_effort(level, contract.values.as_deref());
            return Some(ReasoningInstruction {
                contract: ReasoningContractKind::Effort,
                effort: Some(effort.clone()),
                budget_tokens: None,
                label: format!("reasoning_effort={effort}"),
            });
        }
        if budget_contract.is_some() {
            let budget = compute_budget_tokens(level, max_output_tokens);
            let effort = budget_to_effort(budget);
            return Some(ReasoningInstruction {
                contract: ReasoningContractKind::Effort,
                effort: Some(effort.to_owned()),
                budget_tokens: Some(budget),
                label: format!("reasoning_effort={effort} (derived from budget={budget})"),
            });
        }
    }

    if api_style == ProviderApiStyle::Anthropic {
        if budget_contract.is_some() {
            let budget = compute_budget_tokens(level, max_output_tokens);
            return Some(ReasoningInstruction {
                contract: ReasoningContractKind::BudgetTokens,
                effort: None,
                budget_tokens: Some(budget),
                label: format!("thinking.budget_tokens={budget}"),
            });
        }
        if let Some(contract) = effort_contract {
            let effort = level_to_effort(level, contract.values.as_deref());
            return Some(ReasoningInstruction {
                contract: ReasoningContractKind::Effort,
                effort: Some(effort.clone()),
                budget_tokens: None,
                label: format!("thinking.adaptive effort={effort}"),
            });
        }
    }

    if let Some(contract) = effort_contract {
        let effort = level_to_effort(level, contract.values.as_deref());
        return Some(ReasoningInstruction {
            contract: ReasoningContractKind::Effort,
            effort: Some(effort.clone()),
            budget_tokens: None,
            label: format!("reasoning_effort={effort} (cross-protocol fallback)"),
        });
    }

    let budget = LEGACY_BUDGET
        .iter()
        .find(|(l, _)| *l == level)
        .map(|(_, b)| *b)?;
    Some(ReasoningInstruction {
        contract: ReasoningContractKind::BudgetTokens,
        effort: None,
        budget_tokens: Some(budget),
        label: format!("budget_tokens={budget} (fallback)"),
    })
}

/// Context for request-aware quirk decisions — port of TS `ProtocolContext`.
#[derive(Debug, Clone, Default)]
pub struct ProtocolContext {
    pub has_tools: bool,
    pub model_id: Option<String>,
    pub max_output_tokens: Option<u64>,
    pub provider_base_url: Option<String>,
}

/// What a protocol builder hands back — port of TS `ProtocolCallOptions`.
/// `additional_params` is flattened into the top-level wire body by both rig
/// providers (the escape hatch for `thinking` / `reasoning_effort`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolCallOptions {
    pub additional_params: Option<Value>,
    pub max_tokens: u64,
    pub label: String,
}

/// Detect endpoints that accept the native Anthropic thinking block.
/// Unknown/missing base URLs are assumed native (TS parity).
pub fn is_native_anthropic_host(base_url: Option<&str>) -> bool {
    base_url
        .and_then(host_from_url_loose)
        .map(|h| THINKING_CAPABLE_HOSTS.contains(&h.as_str()))
        .unwrap_or(true)
}

/// Extract the host from an absolute URL. Mirrors `new URL(...)` semantics:
/// no scheme (`://`) means unparseable → `None` (caller assumes native).
fn host_from_url_loose(url: &str) -> Option<String> {
    let scheme_split = url.split_once("://")?;
    let authority = scheme_split.1.split(['/', '?']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Floor the output pool when tools are present.
fn pool_with_tool_floor(max_output_tokens: Option<u64>, has_tools: bool) -> u64 {
    let mut max_base = max_output_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    if has_tools && max_base < TOOL_OUTPUT_FLOOR {
        max_base = TOOL_OUTPUT_FLOOR;
    }
    max_base
}

/// Anthropic-protocol wire params — port of TS `anthropicCallOptions`.
///
/// Budget contract on an allowlisted host: budget carved WITHIN the pool
/// (`≤80%`, `≤pool−1024`, `≥1024`); wire `max_tokens` = pool, with the
/// budget living inside it via `thinking.budget_tokens` (rig does not stack
/// anything on top of `max_tokens`, so the pool IS the wire total — the
/// carve-not-stack invariant). Non-allowlisted hosts: thinking stripped.
pub fn anthropic_call_options(
    reasoning: Option<&ReasoningInstruction>,
    ctx: &ProtocolContext,
) -> ProtocolCallOptions {
    let max_base = pool_with_tool_floor(ctx.max_output_tokens, ctx.has_tools);

    let Some(reasoning) = reasoning else {
        return ProtocolCallOptions {
            additional_params: None,
            max_tokens: max_base,
            label: "off".to_owned(),
        };
    };

    if !is_native_anthropic_host(ctx.provider_base_url.as_deref()) {
        return ProtocolCallOptions {
            additional_params: None,
            max_tokens: max_base,
            label: format!("{} (non-native, thinking stripped)", reasoning.label),
        };
    }

    match reasoning.contract {
        ReasoningContractKind::BudgetTokens => {
            let requested = reasoning.budget_tokens.unwrap_or(1024);
            let budget = requested
                .min(max_base * 4 / 5) // floor(pool × 0.8)
                .min(max_base.saturating_sub(1024))
                .max(1024);
            let label = if budget < requested {
                format!(
                    "thinking.budget_tokens={requested}->{budget} (carved from {max_base}, output={})",
                    max_base - budget
                )
            } else {
                format!(
                    "thinking.budget_tokens={budget}, output={}",
                    max_base - budget
                )
            };
            ProtocolCallOptions {
                additional_params: Some(serde_json::json!({
                    "thinking": { "type": "enabled", "budget_tokens": budget },
                    "cache_control": { "type": "ephemeral" },
                })),
                max_tokens: max_base,
                label,
            }
        }
        ReasoningContractKind::Effort => {
            // Adaptive thinking (Claude 4.7+): no budgetTokens, nothing
            // stacked — max_base is the total.
            let mut params = serde_json::Map::new();
            let mut thinking = serde_json::Map::new();
            thinking.insert("type".to_owned(), Value::String("adaptive".to_owned()));
            if let Some(effort) = &reasoning.effort {
                params.insert("effort".to_owned(), Value::String(effort.clone()));
            }
            params.insert("thinking".to_owned(), Value::Object(thinking));
            params.insert(
                "cache_control".to_owned(),
                serde_json::json!({ "type": "ephemeral" }),
            );
            ProtocolCallOptions {
                additional_params: Some(Value::Object(params)),
                max_tokens: max_base,
                label: reasoning.label.clone(),
            }
        }
        ReasoningContractKind::Toggle => {
            // Minimal budget, carved inside the pool so the wire total stays
            // max_base (the TS SDK stacked this 1024 on top of maxBase−1024).
            ProtocolCallOptions {
                additional_params: Some(serde_json::json!({
                    "thinking": { "type": "enabled", "budget_tokens": 1024 },
                    "cache_control": { "type": "ephemeral" },
                })),
                max_tokens: max_base,
                label: reasoning.label.clone(),
            }
        }
    }
}

/// OpenAI-protocol wire params — port of TS `openaiCallOptions`.
///
/// Effort contract sends the string directly; budget contracts derive
/// effort lossily; `max_tokens` is the TOTAL output pool (reasoning tokens
/// are spent inside it server-side). Gemini-backed endpoints suppress
/// `reasoning_effort` when tools are present and cap at 65535.
pub fn openai_call_options(
    reasoning: Option<&ReasoningInstruction>,
    ctx: &ProtocolContext,
) -> ProtocolCallOptions {
    let max_base = pool_with_tool_floor(ctx.max_output_tokens, ctx.has_tools);

    let Some(reasoning) = reasoning else {
        return ProtocolCallOptions {
            additional_params: None,
            max_tokens: max_base,
            label: "off".to_owned(),
        };
    };

    let is_gemini = ctx
        .model_id
        .as_deref()
        .is_some_and(|m| m.contains("gemini"));
    if is_gemini && ctx.has_tools {
        let budget_for_cap = reasoning.budget_tokens.unwrap_or(8192);
        return ProtocolCallOptions {
            additional_params: None,
            max_tokens: budget_for_cap
                .saturating_add(max_base)
                .min(MAX_OUTPUT_TOKENS_CAP),
            label: "reasoning_effort=off (gemini + tools)".to_owned(),
        };
    }

    let mut effort = match reasoning.contract {
        ReasoningContractKind::Effort => reasoning
            .effort
            .clone()
            .unwrap_or_else(|| "high".to_owned()),
        ReasoningContractKind::BudgetTokens => {
            budget_to_effort(reasoning.budget_tokens.unwrap_or(8192)).to_owned()
        }
        ReasoningContractKind::Toggle => "medium".to_owned(),
    };
    // The wire contract allows minimal|low|medium|high (+none/xhigh on the
    // newest models) — clamp the top levels down to 'high'.
    if effort == "max" || effort == "extra" {
        effort = "high".to_owned();
    }

    let computed = if is_gemini {
        max_base.min(MAX_OUTPUT_TOKENS_CAP)
    } else {
        max_base
    };
    let label = if reasoning.contract == ReasoningContractKind::BudgetTokens {
        format!(
            "reasoning_effort={effort} (derived from budget={}, max_tokens={computed})",
            reasoning.budget_tokens.unwrap_or(8192)
        )
    } else {
        format!("reasoning_effort={effort} (max_tokens={computed})")
    };
    ProtocolCallOptions {
        additional_params: Some(serde_json::json!({ "reasoning_effort": effort })),
        max_tokens: computed,
        label,
    }
}

/// Clamp a tool result before it reaches the model. Appends a truncation
/// marker when the output exceeds the engine-side floor.
pub fn clamp_tool_result_output(output: &str) -> String {
    if output.chars().count() <= TOOL_RESULT_CHAR_FLOOR {
        return output.to_owned();
    }
    let truncated: String = output.chars().take(TOOL_RESULT_CHAR_FLOOR).collect();
    format!("{truncated}\n... [truncated at {TOOL_RESULT_CHAR_FLOOR} chars]")
}

/// Recover a valid JSON object from malformed streamed tool-call input —
/// port of TS `repairJsonToolInput`. Streaming models occasionally emit
/// duplicated or interleaved fragments before the final clean object (seen
/// with GLM); scan top-level balanced objects and prefer the LAST parseable
/// one. Returns the repaired JSON string, or `None` when nothing recovers.
pub fn repair_json_tool_input(raw: &str) -> Option<String> {
    let mut cleaned = raw
        .replace("</tool_call>", "")
        .replace("<tool_call>", "")
        .replace("</tool_use>", "")
        .replace("<tool_use>", "")
        .replace("</function_call>", "")
        .replace("<function_call>", "");
    cleaned = cleaned.trim().to_owned();
    if serde_json::from_str::<Value>(&cleaned).is_ok() {
        return Some(cleaned);
    }
    for candidate in top_level_objects(&cleaned).iter().rev() {
        if serde_json::from_str::<Value>(candidate).is_ok() {
            return Some(candidate.clone());
        }
    }
    if let Some(start) = cleaned.find('{') {
        if let Some(end) = cleaned.rfind('}') {
            if end > start {
                let greedy = &cleaned[start..=end];
                if serde_json::from_str::<Value>(greedy).is_ok() {
                    return Some(greedy.to_owned());
                }
            }
        }
    }
    None
}

/// All top-level balanced `{...}` substrings, brace- and string-aware.
fn top_level_objects(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = None;
    let mut in_str = false;
    let mut esc = false;
    for (i, c) in s.char_indices() {
        if esc {
            esc = false;
            continue;
        }
        if in_str && c == '\\' {
            esc = true;
            continue;
        }
        if c == '"' {
            in_str = !in_str;
            continue;
        }
        if in_str {
            continue;
        }
        if c == '{' {
            if depth == 0 {
                start = Some(i);
            }
            depth += 1;
        } else if c == '}' && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(start) = start {
                    out.push(s[start..=i].to_owned());
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProviderApiStyle;
    use serde_json::Value;

    fn budget_contract() -> Vec<ReasoningOption> {
        vec![ReasoningOption {
            kind: ReasoningContractKind::BudgetTokens,
            values: None,
        }]
    }

    fn ctx(has_tools: bool, max_output: u64, base_url: &str) -> ProtocolContext {
        ProtocolContext {
            has_tools,
            model_id: Some("claude-sonnet-4-5".to_owned()),
            max_output_tokens: Some(max_output),
            provider_base_url: Some(base_url.to_owned()),
        }
    }

    fn load_fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/sse")
            .join(format!("{name}.json"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The quirk layer reproduces each fixture's recorded `resolution`
    /// (reasoning instruction + per-step call options) from its `input`.
    #[test]
    fn resolution_matches_fixtures() {
        for name in [
            "anthropic-thinking-budget",
            "openai-zai-thinking",
            "anthropic-non-native-thinking-strip",
        ] {
            let fixture = load_fixture(name);
            let input = &fixture["input"];
            let style = match input["provider"]["apiStyle"].as_str().unwrap() {
                "anthropic" => ProviderApiStyle::Anthropic,
                _ => ProviderApiStyle::OpenAi,
            };
            let contracts: Vec<ReasoningOption> = input["reasoningContracts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| serde_json::from_value(c.clone()).unwrap())
                .collect();
            let level: ThinkingLevel =
                serde_json::from_value(input["thinkingLevel"].clone()).unwrap();
            let max_out = input["modelMaxOutputTokens"].as_u64().unwrap();

            let resolved = resolve_reasoning(level, &contracts, style, max_out).unwrap();
            let want = &fixture["resolution"]["reasoningInstruction"];
            assert_eq!(
                resolved.budget_tokens.map(Value::from),
                want.get("budgetTokens").filter(|v| !v.is_null()).cloned(),
                "{name}: budget"
            );
            assert_eq!(
                resolved.effort.clone().map(Value::from),
                want.get("effort").filter(|v| !v.is_null()).cloned(),
                "{name}: effort"
            );
            assert_eq!(
                resolved.label,
                want["label"].as_str().unwrap(),
                "{name}: label"
            );
        }
    }

    #[test]
    fn budget_to_effort_thresholds_match_ts() {
        assert_eq!(budget_to_effort(7999), "low");
        assert_eq!(budget_to_effort(8000), "medium");
        assert_eq!(budget_to_effort(16000), "medium");
        assert_eq!(budget_to_effort(24000), "high");
        assert_eq!(budget_to_effort(47999), "high");
        assert_eq!(budget_to_effort(48000), "max");
    }

    /// Fixture wire: pool floored to 16384 (tools), budget 6553 carved
    /// inside it, cache_control ephemeral alongside thinking.
    #[test]
    fn anthropic_carve_matches_fixture_wire() {
        let reasoning = resolve_reasoning(
            ThinkingLevel::High,
            &budget_contract(),
            ProviderApiStyle::Anthropic,
            8192,
        )
        .unwrap();
        let options = anthropic_call_options(
            Some(&reasoning),
            &ctx(true, 8192, "https://api.z.ai/anthropic"),
        );
        assert_eq!(options.max_tokens, 16384);
        assert_eq!(
            options.additional_params,
            Some(serde_json::json!({
                "thinking": { "type": "enabled", "budget_tokens": 6553 },
                "cache_control": { "type": "ephemeral" },
            }))
        );
    }

    /// Carve clamps. For pools > 5120 the 80% ceiling is always tighter
    /// than pool−1024 (0.2·pool > 1024), so the −1024 reservation only
    /// guards small pools — belt-and-braces, exactly as in the TS source.
    #[test]
    fn anthropic_carve_clamps() {
        let cases = [
            (16384u64, 24000u64, 13107u64), // 80% ceiling binds
            (16384, 15800, 13107),          // 80% still binds over pool−1024
            (2048, 6553, 1024),             // min binds on tiny pools
            (8192, 6553, 6553),             // no clamp, no tools → no floor
        ];
        for (pool, requested, want_budget) in cases {
            let reasoning = ReasoningInstruction {
                contract: ReasoningContractKind::BudgetTokens,
                effort: None,
                budget_tokens: Some(requested),
                label: String::new(),
            };
            let options = anthropic_call_options(
                Some(&reasoning),
                &ctx(false, pool, "https://api.anthropic.com"),
            );
            assert_eq!(options.max_tokens, pool);
            assert_eq!(
                options.additional_params.as_ref().unwrap()["thinking"]["budget_tokens"],
                serde_json::json!(want_budget),
                "pool={pool} requested={requested}"
            );
        }
    }

    /// Carve re-derives per request — it must not compound across steps.
    #[test]
    fn carve_does_not_compound() {
        let reasoning = resolve_reasoning(
            ThinkingLevel::High,
            &budget_contract(),
            ProviderApiStyle::Anthropic,
            8192,
        )
        .unwrap();
        let mut ctx = ctx(true, 8192, "https://api.z.ai/anthropic");
        let first = anthropic_call_options(Some(&reasoning), &ctx);
        // A second step fed the first step's OUTPUT (not pool) as the new
        // base still floors to 16384 with tools present → same budget.
        ctx.max_output_tokens = Some(9831);
        let second = anthropic_call_options(Some(&reasoning), &ctx);
        assert_eq!(
            first.additional_params, second.additional_params,
            "tool floor re-applies to the carved value, keeping the budget stable"
        );
    }

    #[test]
    fn non_native_host_strips_thinking() {
        let reasoning = resolve_reasoning(
            ThinkingLevel::High,
            &budget_contract(),
            ProviderApiStyle::Anthropic,
            8192,
        )
        .unwrap();
        for url in ["https://openrouter.local/api", "https://example.com"] {
            let options = anthropic_call_options(Some(&reasoning), &ctx(true, 8192, url));
            assert_eq!(options.max_tokens, 16384, "floor still applies");
            assert_eq!(
                options.additional_params, None,
                "thinking stripped for {url}"
            );
            assert!(options.label.contains("stripped"), "{}", options.label);
        }
    }

    #[test]
    fn allowlist_matches_recorded_hosts() {
        assert!(is_native_anthropic_host(Some("https://api.anthropic.com")));
        assert!(is_native_anthropic_host(Some("https://api.z.ai/anthropic")));
        assert!(is_native_anthropic_host(Some("http://api.z.ai:56382/x")));
        assert!(!is_native_anthropic_host(Some(
            "https://openrouter.ai/api/v1"
        )));
        assert!(is_native_anthropic_host(None), "unknown assumed native");
        assert!(
            is_native_anthropic_host(Some("garbage")),
            "unparseable assumed native"
        );
    }

    #[test]
    fn openai_effort_and_gemini_suppression() {
        let reasoning = ReasoningInstruction {
            contract: ReasoningContractKind::BudgetTokens,
            effort: None,
            budget_tokens: Some(6553),
            label: String::new(),
        };
        let mut c = ctx(false, 8192, "https://api.z.ai/api/paas/v4");
        let options = openai_call_options(Some(&reasoning), &c);
        assert_eq!(options.max_tokens, 8192);
        assert_eq!(
            options.additional_params,
            Some(serde_json::json!({ "reasoning_effort": "low" }))
        );

        c.model_id = Some("gemini-2.5-pro".to_owned());
        c.has_tools = true;
        let gemini = openai_call_options(Some(&reasoning), &c);
        assert_eq!(
            gemini.additional_params, None,
            "gemini+tools suppresses effort"
        );
        assert_eq!(
            gemini.max_tokens,
            6553 + 16384,
            "budget+floored pool, under the cap"
        );

        // 'max'/'extra' clamp down to the wire-legal 'high'.
        let effort = ReasoningInstruction {
            contract: ReasoningContractKind::Effort,
            effort: Some("max".to_owned()),
            budget_tokens: None,
            label: String::new(),
        };
        let clamped = openai_call_options(Some(&effort), &ctx(false, 8192, "https://x.example"));
        assert_eq!(
            clamped.additional_params,
            Some(serde_json::json!({ "reasoning_effort": "high" }))
        );
    }

    #[test]
    fn off_level_and_explicit_none() {
        assert!(
            resolve_reasoning(ThinkingLevel::Off, &[], ProviderApiStyle::Anthropic, 8192).is_none()
        );
        let none_contract = vec![ReasoningOption {
            kind: ReasoningContractKind::Effort,
            values: Some(vec!["low".to_owned(), "none".to_owned()]),
        }];
        let resolved = resolve_reasoning(
            ThinkingLevel::Off,
            &none_contract,
            ProviderApiStyle::OpenAi,
            8192,
        )
        .unwrap();
        assert_eq!(resolved.effort.as_deref(), Some("none"));
    }

    #[test]
    fn legacy_budget_without_contracts() {
        let resolved = resolve_reasoning(
            ThinkingLevel::Medium,
            &[],
            ProviderApiStyle::Anthropic,
            8192,
        )
        .unwrap();
        assert_eq!(resolved.budget_tokens, Some(8000));
    }

    #[test]
    fn repair_keeps_last_parseable_object() {
        assert_eq!(
            repair_json_tool_input(r#"{"path": "/a"}{"path": "/b"}"#).as_deref(),
            Some(r#"{"path": "/b"}"#)
        );
        assert_eq!(
            repair_json_tool_input(r#"<tool_call>{"path": "/tmp/x"}</tool_call>"#).as_deref(),
            Some(r#"{"path": "/tmp/x"}"#)
        );
        assert_eq!(
            repair_json_tool_input(r#"{"path": "/tmp/x"}"#).as_deref(),
            Some(r#"{"path": "/tmp/x"}"#)
        );
        assert_eq!(repair_json_tool_input("not json at all"), None);
        // String-aware braces: a '{' inside a string value does not open an object.
        assert_eq!(
            repair_json_tool_input(r#"junk {"a": "b}c"} junk2"#).as_deref(),
            Some(r#"{"a": "b}c"}"#)
        );
    }

    #[test]
    fn tool_result_clamp() {
        assert_eq!(clamp_tool_result_output("short"), "short");
        let long = clamp_tool_result_output(&"y".repeat(20000));
        assert!(long.starts_with(&"y".repeat(16384)));
        assert!(long.ends_with("... [truncated at 16384 chars]"));
    }
}
