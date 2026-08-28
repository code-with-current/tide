//! Provider-API usage reports — the port of
//! `app/core/agent/provider-usage.ts` (CodexBar-style): fetch
//! real limits/usage straight from the provider's own quota endpoints
//! using the stored API key — z.ai's monitor API and OpenRouter's key API
//! today, plus DeepSeek/Fireworks balance endpoints. The dispatcher
//! matches providers by their preset/baseUrl and returns null for
//! providers without an API (the UI then falls back to locally-metered
//! windows). Parsers are pure; the fetchers never fail hard.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::or_catalog::unix_ms_now;

// ── preset matching (src/lib/provider-presets.ts matchPresetByBaseUrl) ──

/// The preset table's id/baseUrl pairs — the only fields the usage
/// dispatcher needs (the full presets object lives in the renderer).
const PRESET_BASE_URLS: &[(&str, &str)] = &[
    ("anthropic", "https://api.anthropic.com"),
    ("openai", "https://api.openai.com/v1"),
    ("google", "https://generativelanguage.googleapis.com/v1beta/openai"),
    ("xai", "https://api.x.ai/v1"),
    ("openrouter", "https://openrouter.ai/api/v1"),
    ("zai", "https://api.z.ai/api/anthropic"),
    ("deepseek", "https://api.deepseek.com/v1"),
    ("opencode", "https://opencode.ai/zen/v1"),
    ("groq", "https://api.groq.com/openai/v1"),
    ("mistral", "https://api.mistral.ai/v1"),
    ("together", "https://api.together.xyz/v1"),
    ("fireworks", "https://api.fireworks.ai/inference/v1"),
    ("ollama", "http://localhost:11434/v1"),
    ("lmstudio", "http://localhost:1234/v1"),
];

fn host_of(url: &str) -> String {
    let no_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    no_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

/// Match a configured baseUrl against the preset table: exact URL first,
/// then same host.
pub fn match_preset_by_base_url(base_url: &str) -> Option<&'static str> {
    let url = base_url.trim().to_lowercase();
    if url.is_empty() {
        return None;
    }
    if let Some((id, _)) = PRESET_BASE_URLS
        .iter()
        .find(|(_, preset)| preset.to_lowercase() == url)
    {
        return Some(id);
    }
    PRESET_BASE_URLS
        .iter()
        .find(|(_, preset)| {
            let host = host_of(preset);
            !host.is_empty() && host == host_of(&url)
        })
        .map(|(id, _)| *id)
}

// ── wire types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UsageWindow {
    pub label: String,
    /// Percent used, 0-100 — every provider reports this even when
    /// absolute numbers are absent. Balance/spend-only reports omit it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    /// Used amount in the window's unit. For balance-only reports this is
    /// the AVAILABLE balance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<f64>,
    /// Total allowance in the window's unit (absent = unlimited).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    pub unit: &'static str,
    /// Epoch ms when the window resets, when the provider reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProviderUsageReport {
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "planName")]
    pub plan_name: Option<String>,
    pub windows: Vec<UsageWindow>,
}

// ── z.ai ───────────────────────────────────────────────────────────
// GET https://api.z.ai/api/monitor/usage/quota/limit (Bearer)
// `usage` is the ALLOWANCE (confusingly named); unit enum maps to minutes.

const ZAI_UNIT_MINUTES: &[(i64, i64)] = &[(1, 1440), (3, 60), (5, 1), (6, 10080)];

fn window_label(window_minutes: Option<i64>) -> String {
    let Some(m) = window_minutes else {
        return "window".to_owned();
    };
    if m == 300 {
        return "5 hours".to_owned();
    }
    if m > 0 && m % 10_080 == 0 {
        return format!("{} week{}", m / 10_080, if m > 10_080 { "s" } else { "" });
    }
    if m > 0 && m % 1440 == 0 {
        return format!("{} day{}", m / 1440, if m > 1440 { "s" } else { "" });
    }
    if m > 0 && m % 60 == 0 {
        return format!("{} hour{}", m / 60, if m > 60 { "s" } else { "" });
    }
    format!("{m}m")
}

fn f64_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    match obj.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    }
}

fn i64_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    match obj.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64)),
        _ => None,
    }
}

pub fn parse_zai_quota(json: &Value) -> Option<ProviderUsageReport> {
    let root = json.as_object()?;
    if root.get("success").and_then(Value::as_bool) != Some(true)
        || root.get("code").and_then(Value::as_i64) != Some(200)
    {
        return None;
    }
    let data = root.get("data")?.as_object()?;
    let limits = data.get("limits")?.as_array()?;
    let plan_name = ["planName", "plan", "plan_type", "packageName", "level"]
        .iter()
        .find_map(|k| {
            data.get(*k)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        });

    let mut windows = Vec::new();
    for raw in limits {
        let Some(e) = raw.as_object() else { continue };
        let Some(unit) = i64_field(e, "unit") else { continue };
        let Some(number) = i64_field(e, "number") else { continue };
        let Some(mut percent) = f64_field(e, "percentage") else {
            continue;
        };
        let allowance = f64_field(e, "usage");
        let current = f64_field(e, "currentValue");
        let remaining = f64_field(e, "remaining");
        if let Some(allowance) = allowance.filter(|a| *a > 0.0) {
            let used = remaining
                .map(|r| (allowance - r).max(current.unwrap_or(allowance - r)))
                .or(current);
            if let Some(used) = used {
                percent = (used / allowance * 100.0).clamp(0.0, 100.0);
            }
        }
        let window_minutes = if number > 0 {
            ZAI_UNIT_MINUTES
                .iter()
                .find(|(u, _)| *u == unit)
                .map(|(_, minutes)| number * minutes)
        } else {
            None
        };
        let resets_at = i64_field(e, "nextResetTime").filter(|t| *t > 0);
        let label = window_label(window_minutes);
        let entry_type = e.get("type").and_then(Value::as_str).unwrap_or_default();
        match entry_type {
            "TOKENS_LIMIT" => windows.push(UsageWindow {
                label,
                percent: Some(percent),
                used: current.or(remaining.zip(allowance).map(|(r, a)| a - r)),
                limit: allowance,
                unit: "tokens",
                resets_at,
            }),
            // The MCP lane — minutes of tool-server time, not model tokens.
            "TIME_LIMIT" => windows.push(UsageWindow {
                label: "MCP Limit".to_owned(),
                percent: Some(percent),
                used: None,
                limit: allowance,
                unit: "credits",
                resets_at,
            }),
            // Credit-denominated plans surface as a credits window.
            "CREDIT_LIMIT" => windows.push(UsageWindow {
                label,
                percent: Some(percent),
                used: current,
                limit: allowance,
                unit: "credits",
                resets_at,
            }),
            _ => {}
        }
    }
    // Shortest window first — the 5-hour window is the primary meter.
    windows.sort_by_key(|w| w.resets_at.unwrap_or(i64::MAX));
    (!windows.is_empty()).then_some(ProviderUsageReport {
        source: "zai",
        plan_name,
        windows,
    })
}

async fn fetch_zai_report(api_key: &str) -> Option<ProviderUsageReport> {
    let json = get_json(
        "https://api.z.ai/api/monitor/usage/quota/limit",
        api_key,
        Duration::from_secs(10),
    )
    .await?;
    parse_zai_quota(&json)
}

// ── OpenRouter ─────────────────────────────────────────────────────
// GET https://openrouter.ai/api/v1/key (Bearer) →
// { data: { usage, limit (USD, null = unlimited), rate_limit } }

pub fn parse_openrouter_key(json: &Value) -> Option<ProviderUsageReport> {
    let data = json.get("data")?.as_object()?;
    let usage = f64_field(data, "usage")?;
    let limit = match data.get("limit") {
        None | Some(Value::Null) => None,
        Some(v) => v.as_f64(),
    };
    let percent = limit
        .filter(|l| *l > 0.0)
        .map(|l| (usage / l * 100.0).min(100.0))
        .unwrap_or(0.0);
    Some(ProviderUsageReport {
        source: "openrouter",
        plan_name: None,
        windows: vec![UsageWindow {
            label: "credits".to_owned(),
            percent: Some(percent),
            used: Some(usage),
            limit,
            unit: "USD",
            resets_at: None,
        }],
    })
}

async fn fetch_openrouter_report(api_key: &str) -> Option<ProviderUsageReport> {
    let json = get_json(
        "https://openrouter.ai/api/v1/key",
        api_key,
        Duration::from_secs(10),
    )
    .await?;
    parse_openrouter_key(&json)
}

// ── DeepSeek ───────────────────────────────────────────────────────
// GET https://api.deepseek.com/user/balance (Bearer) — prepaid balance
// only, no windows.

pub fn parse_deepseek_balance(json: &Value) -> Option<ProviderUsageReport> {
    let infos = json.get("balance_infos")?.as_array()?;
    if infos.is_empty() {
        return None;
    }
    // USD preferentially, else the first entry.
    let entry = infos
        .iter()
        .find(|b| b.get("currency").and_then(Value::as_str) == Some("USD"))
        .unwrap_or(&infos[0]);
    let entry_obj = entry.as_object()?;
    let currency = entry_obj
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let total: f64 = entry_obj
        .get("total_balance")
        .and_then(Value::as_str)?
        .parse()
        .ok()?;
    let label = if currency == "USD" {
        "balance".to_owned()
    } else {
        format!("balance ({currency})")
    };
    // Balance-only: no allowance, no percent — the ring stays muted.
    Some(ProviderUsageReport {
        source: "deepseek",
        plan_name: None,
        windows: vec![UsageWindow {
            label,
            percent: None,
            used: Some(total),
            limit: None,
            unit: "USD",
            resets_at: None,
        }],
    })
}

async fn fetch_deepseek_report(api_key: &str) -> Option<ProviderUsageReport> {
    let json = get_json(
        "https://api.deepseek.com/user/balance",
        api_key,
        Duration::from_secs(10),
    )
    .await?;
    parse_deepseek_balance(&json)
}

// ── Fireworks ──────────────────────────────────────────────────────
// Two calls with the inference key: list accounts, then the 30-day rated
// spend from the billing summary. No public balance endpoint — spend only.

fn money_field(m: &Value, key: &str) -> f64 {
    match m.get(key) {
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn fireworks_total(m: &Value) -> f64 {
    money_field(m, "units") + money_field(m, "nanos") / 1e9
}

pub fn parse_fireworks_summary(json: &Value, account_slug: &str) -> Option<ProviderUsageReport> {
    let items = json.get("lineItems")?.as_array()?;
    let spend: f64 = items
        .iter()
        .filter_map(|item| item.get("cost").map(fireworks_total))
        .sum();
    Some(ProviderUsageReport {
        source: "fireworks",
        plan_name: (!account_slug.is_empty()).then(|| account_slug.to_owned()),
        windows: vec![UsageWindow {
            label: "30-day spend".to_owned(),
            percent: None,
            used: Some(spend),
            limit: None,
            unit: "USD",
            resets_at: None,
        }],
    })
}

async fn fetch_fireworks_report(api_key: &str) -> Option<ProviderUsageReport> {
    let accounts = get_json(
        "https://api.fireworks.ai/v1/accounts",
        api_key,
        Duration::from_secs(10),
    )
    .await?;
    let slug = accounts
        .get("accounts")?
        .as_array()?
        .iter()
        .find_map(|a| a.get("slug").and_then(Value::as_str))?
        .to_owned();
    let end = unix_ms_now();
    let start = end - 30 * 24 * 60 * 60 * 1000;
    let json = get_json(
        &format!(
            "https://api.fireworks.ai/v1/accounts/{}/billing/summary?startTime={}&endTime={}",
            slug,
            iso_from_ms(start),
            iso_from_ms(end),
        ),
        api_key,
        Duration::from_secs(10),
    )
    .await?;
    parse_fireworks_summary(&json, &slug)
}

fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{year:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

async fn get_json(url: &str, api_key: &str, timeout: Duration) -> Option<Value> {
    let client = reqwest::Client::new();
    let resp = client
        .get(url)
        .header("authorization", format!("Bearer {api_key}"))
        .header("accept", "application/json")
        .timeout(timeout)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Value>().await.ok()
}

/// Fetch the provider-API usage report for a configured provider, or null
/// when the provider has no usage API / the key is missing / the call
/// fails. Never fails.
pub async fn provider_usage_report(
    base_url: &str,
    api_key: Option<&str>,
) -> Option<ProviderUsageReport> {
    let api_key = api_key?;
    let preset = match_preset_by_base_url(base_url)?;
    match preset {
        "zai" => fetch_zai_report(api_key).await,
        "openrouter" => fetch_openrouter_report(api_key).await,
        "deepseek" => fetch_deepseek_report(api_key).await,
        "fireworks" => fetch_fireworks_report(api_key).await,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preset_matching_exact_then_host() {
        assert_eq!(
            match_preset_by_base_url("https://openrouter.ai/api/v1"),
            Some("openrouter")
        );
        assert_eq!(
            match_preset_by_base_url("https://openrouter.ai/api/v1/"),
            Some("openrouter"),
            "trailing slash misses exact but the host rule rescues"
        );
        assert_eq!(match_preset_by_base_url("HTTPS://API.Z.AI/api/anthropic"), Some("zai"));
        assert_eq!(match_preset_by_base_url("http://localhost:1234/v1"), Some("lmstudio"));
        assert_eq!(match_preset_by_base_url(""), None);
        assert_eq!(match_preset_by_base_url("https://unknown.example.com"), None);
    }

    #[test]
    fn zai_quota_parses_windows_sorted_by_reset() {
        let json = json!({
            "success": true, "code": 200,
            "data": {
                "planName": "Max",
                "limits": [
                    {
                        "type": "TOKENS_LIMIT", "unit": 3, "number": 5,
                        "percentage": 999,
                        "usage": 1000, "currentValue": 400, "remaining": 600,
                        "nextResetTime": 1750000000000i64
                    },
                    {
                        "type": "CREDIT_LIMIT", "unit": 1, "number": 7,
                        "percentage": 50, "usage": 100, "currentValue": 50,
                        "nextResetTime": 1740000000000i64
                    },
                    { "type": "JUNK_LIMIT", "unit": 5, "number": 1, "percentage": 1 }
                ]
            }
        });
        let report = parse_zai_quota(&json).expect("parses");
        assert_eq!(report.source, "zai");
        assert_eq!(report.plan_name.as_deref(), Some("Max"));
        assert_eq!(report.windows.len(), 2, "unknown limit types dropped");
        // Shortest reset first (credit window resets earlier).
        assert_eq!(report.windows[0].label, "1 week");
        assert_eq!(report.windows[0].unit, "credits");
        let five_hour = &report.windows[1];
        assert_eq!(five_hour.label, "5 hours");
        assert_eq!(five_hour.percent, Some(40.0), "percent recomputed from used/allowance");
        assert_eq!(five_hour.used, Some(400.0));
        assert_eq!(five_hour.limit, Some(1000.0));
        assert_eq!(five_hour.unit, "tokens");
        // Non-200 / success-false shapes reject.
        assert!(parse_zai_quota(&json!({ "success": false, "code": 200 })).is_none());
        assert!(parse_zai_quota(&json!({ "success": true, "code": 500 })).is_none());
    }

    #[test]
    fn zai_time_limit_is_the_mcp_lane() {
        let json = json!({
            "success": true, "code": 200,
            "data": { "limits": [
                { "type": "TIME_LIMIT", "unit": 5, "number": 60, "percentage": 25,
                  "usage": 60, "currentValue": 15, "remaining": 45 }
            ] }
        });
        let report = parse_zai_quota(&json).unwrap();
        assert_eq!(report.windows[0].label, "MCP Limit");
        assert_eq!(report.windows[0].unit, "credits");
        assert_eq!(report.windows[0].resets_at, None);
    }

    #[test]
    fn openrouter_key_parses_credits_window() {
        let json = json!({ "data": { "usage": 2.5, "limit": 10.0 } });
        let report = parse_openrouter_key(&json).unwrap();
        assert_eq!(report.windows[0].used, Some(2.5));
        assert_eq!(report.windows[0].percent, Some(25.0));
        assert_eq!(report.windows[0].unit, "USD");
        let unlimited = parse_openrouter_key(&json!({ "data": { "usage": 3.0, "limit": null } })).unwrap();
        assert_eq!(unlimited.windows[0].percent, Some(0.0));
        assert_eq!(unlimited.windows[0].limit, None);
        assert!(parse_openrouter_key(&json!({ "data": {} })).is_none());
    }

    #[test]
    fn deepseek_balance_prefers_usd() {
        let json = json!({
            "is_available": true,
            "balance_infos": [
                { "currency": "CNY", "total_balance": "99.5" },
                { "currency": "USD", "total_balance": "12.34" },
            ]
        });
        let report = parse_deepseek_balance(&json).unwrap();
        assert_eq!(report.windows[0].used, Some(12.34));
        assert_eq!(report.windows[0].label, "balance");
        assert_eq!(report.windows[0].percent, None, "balance-only stays muted");
        let single = parse_deepseek_balance(&json!({
            "balance_infos": [{ "currency": "EUR", "total_balance": "5" }]
        }))
        .unwrap();
        assert_eq!(single.windows[0].label, "balance (EUR)");
        assert!(parse_deepseek_balance(&json!({ "balance_infos": [] })).is_none());
    }

    #[test]
    fn fireworks_summary_sums_line_items_with_nanos() {
        let json = json!({
            "lineItems": [
                { "cost": { "units": "2", "nanos": "500000000", "currencyCode": "USD" } },
                { "cost": { "units": 1, "nanos": 250000000 } },
                {},
            ]
        });
        let report = parse_fireworks_summary(&json, "acct").unwrap();
        assert_eq!(report.source, "fireworks");
        assert_eq!(report.plan_name.as_deref(), Some("acct"));
        assert_eq!(report.windows[0].label, "30-day spend");
        assert!((report.windows[0].used.unwrap() - 3.75).abs() < 1e-9);
        assert!(parse_fireworks_summary(&json!({}), "x").is_none());
    }

    #[test]
    fn iso_from_ms_matches_expected_instant() {
        assert_eq!(iso_from_ms(1_756_243_200_000), "2025-08-26T21:20:00.000Z");
    }

    #[tokio::test]
    async fn report_dispatch_returns_none_without_key_or_preset() {
        assert!(provider_usage_report("https://api.openrouter.ai/api/v1", None).await.is_none());
        assert!(provider_usage_report("https://no-api.example.com", Some("k")).await.is_none());
    }
}
