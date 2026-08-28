//! models.dev model catalog — the port of `app/core/agent/model-prices.ts`
//! (loader) + `model-catalog.ts` (resolve/match) + the active-catalog half of
//! `model-capabilities.ts` (init / session-deduped refresh / post-refresh
//! enrichment). Source of truth: https://models.dev/api.json; the bundled
//! baseline vendored at `src-tauri/data/model-prices.json` (the
//! `app/core/data/model-prices.json` snapshot, 2958 models) and the runtime
//! cache `<dataDir>/model-prices.json` share the flattened on-disk shape
//! `{ fetchedAt, source, count, models: { catalogId: slim } }`; costs are
//! per-Mtok in the file and per-token after `normalize_entry`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tide_store::config::StoredModel;

use crate::state::AppState;

use super::CommandError;

pub const CATALOG_URL: &str = "https://models.dev/api.json";
const CACHE_FILENAME: &str = "model-prices.json";
const BUNDLED: &str = include_str!("../../data/model-prices.json");
const REFRESH_INTERVAL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const REFRESH_SANITY_MIN: usize = 100;
const CONSERVATIVE_MAX_OUTPUT: u64 = 8192;
const FALLBACK_CONTEXT: u64 = 200_000;

/// One model as it appears in the flattened catalog file (only the slim
/// fields consumed; costs per-Mtok, models.dev native units).
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct RawCatalogEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_options: Option<Vec<ReasoningOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<RawLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<RawCost>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct RawLimit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct RawCost {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

/// Reasoning contract from models.dev — `min` is the minimum budget_tokens
/// for `budget_tokens`-style toggles.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ReasoningOption {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<u64>,
}

/// Normalized entry (the wire `CatalogEntry` shape the resolve result's
/// `matches` array carries, camelCase like the TS interface).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub catalog_id: String,
    pub mode: String,
    pub context_window: u64,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub input_cost_per_token: f64,
    pub output_cost_per_token: f64,
    pub cache_read_input_token_cost: Option<f64>,
    pub cache_creation_input_token_cost: Option<f64>,
    pub supports_reasoning: bool,
    pub supports_function_calling: bool,
    pub supports_vision: bool,
    pub supports_prompt_caching: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_options: Option<Vec<ReasoningOption>>,
}

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    fetched_at: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    count: usize,
    models: HashMap<String, RawCatalogEntry>,
}

// ── active-catalog state (TS module singletons) ─────────────────────

struct CatalogState {
    entries: HashMap<String, CatalogEntry>,
    fetched_at: Option<String>,
}

fn state_cell() -> &'static Mutex<Option<CatalogState>> {
    static CELL: OnceLock<Mutex<Option<CatalogState>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

fn refreshed_cell() -> &'static Mutex<bool> {
    static CELL: OnceLock<Mutex<bool>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(false))
}

/// The loaded catalog (TS `getActiveCatalog`) — `None` until `load` runs.
fn with_active<T>(read: impl FnOnce(Option<&CatalogState>) -> T) -> T {
    let guard = state_cell().lock().expect("catalog state poisoned");
    read(guard.as_ref())
}

/// True when at most one refresh should run per app session (TS
/// `refreshedThisSession`). Returns false when a refresh already ran.
fn claim_refresh_slot() -> bool {
    let mut refreshed = refreshed_cell().lock().expect("refresh flag poisoned");
    if *refreshed {
        false
    } else {
        *refreshed = true;
        true
    }
}

fn activate(entries: HashMap<String, CatalogEntry>, fetched_at: Option<String>) {
    *state_cell().lock().expect("catalog state poisoned") = Some(CatalogState {
        entries,
        fetched_at,
    });
}

// ── time helpers (fixed "YYYY-MM-DDTHH:MM:SS[.mmm]Z" — the shape the
//    bundled file and refresh writes use; no chrono in the dep tree) ──

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse the catalog `fetchedAt` into unix ms. `None` for anything the
/// fixed-format parser can't handle (TS `Date.parse` → NaN).
fn parse_iso_ms(s: &str) -> Option<u64> {
    let bytes = s.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<u64> {
        std::str::from_utf8(&bytes[range]).ok()?.parse().ok()
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = if bytes.len() > 20 && bytes[19] == b'.' {
        let end = bytes[20..]
            .iter()
            .position(|b| !b.is_ascii_digit())
            .map(|i| 20 + i)
            .unwrap_or(bytes.len());
        let digits = std::str::from_utf8(&bytes[20..end]).ok()?;
        let scaled: u64 = digits.parse().ok()?;
        match digits.len() {
            1 => scaled * 100,
            2 => scaled * 10,
            3 => scaled,
            _ => scaled / 10u64.pow(digits.len() as u32 - 3),
        }
    } else {
        0
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // days-from-civil (Howard Hinnant's algorithm)
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe as i64 - 719_468;
    let secs = days * 86_400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64;
    Some((secs as u64) * 1000 + millis)
}

fn format_iso_ms(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let mut rem = secs.rem_euclid(86_400);
    // civil-from-days (inverse of the parser's algorithm)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    let hour = rem / 3600;
    rem %= 3600;
    format!(
        "{year:04}-{m:02}-{d:02}T{hour:02}:{:02}:{:02}.{millis:03}Z",
        rem / 60,
        rem % 60
    )
}

// ── loading / normalizing ───────────────────────────────────────────

fn per_token(per_mtok: f64) -> f64 {
    per_mtok / 1_000_000.0
}

fn normalize_entry(catalog_id: &str, raw: &RawCatalogEntry) -> CatalogEntry {
    let limit = raw.limit.clone().unwrap_or_default();
    let cost = raw.cost.clone().unwrap_or_default();
    let context = limit.context.unwrap_or(0);
    CatalogEntry {
        catalog_id: catalog_id.to_owned(),
        mode: "chat".to_owned(),
        context_window: context,
        max_input_tokens: limit.input.unwrap_or(context),
        max_output_tokens: limit.output.unwrap_or(0),
        input_cost_per_token: per_token(cost.input.unwrap_or(0.0)),
        output_cost_per_token: per_token(cost.output.unwrap_or(0.0)),
        cache_read_input_token_cost: cost.cache_read.map(per_token),
        cache_creation_input_token_cost: cost.cache_write.map(per_token),
        supports_reasoning: raw.reasoning.unwrap_or(false),
        supports_function_calling: raw.tool_call.unwrap_or(false),
        supports_vision: raw.attachment.unwrap_or(false),
        supports_prompt_caching: cost.cache_read.is_some() || cost.cache_write.is_some(),
        reasoning_options: raw.reasoning_options.clone(),
    }
}

fn build_catalog(raw: &HashMap<String, RawCatalogEntry>) -> HashMap<String, CatalogEntry> {
    raw.iter().map(|(k, v)| (k.clone(), normalize_entry(k, v))).collect()
}

fn read_catalog_file(text: &str) -> Option<CatalogFile> {
    serde_json::from_str(text).ok()
}

/// Flatten the nested models.dev API (`{ provider: { models: { id: … } } }`)
/// into the slim `{ catalogId: model }` map — the one canonical flattening
/// shared by the refresh path and the vendored baseline.
pub fn flatten_models_dev_api(api: &Value) -> HashMap<String, RawCatalogEntry> {
    let mut out = HashMap::new();
    let Some(providers) = api.as_object() else {
        return out;
    };
    for provider in providers.values() {
        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (id, model) in models {
            let Ok(raw) = serde_json::from_value::<RawCatalogEntry>(model.clone()) else {
                continue;
            };
            out.insert(id.clone(), raw);
        }
    }
    out
}

/// Load once (idempotent): pick whichever of the runtime cache and the
/// bundled baseline is newer — bundled wins ties (reviewed baseline).
/// Returns the entry count. Never fails: an unreadable cache falls back to
/// the bundled file, and a corrupt bundled file leaves the catalog empty
/// (resolve then uses the conservative fallback).
pub fn load(data_dir: &Path) -> usize {
    {
        let guard = state_cell().lock().expect("catalog state poisoned");
        if let Some(state) = guard.as_ref() {
            return state.entries.len();
        }
    }
    let cache = std::fs::read_to_string(data_dir.join(CACHE_FILENAME))
        .ok()
        .and_then(|text| read_catalog_file(&text));
    let bundled = read_catalog_file(BUNDLED);
    let chosen = match (cache, bundled) {
        (Some(cache), Some(bundled)) => {
            if parse_iso_ms(&cache.fetched_at) > parse_iso_ms(&bundled.fetched_at) {
                cache
            } else {
                bundled
            }
        }
        (Some(cache), None) => cache,
        (None, Some(bundled)) => bundled,
        (None, None) => CatalogFile::default(),
    };
    let count = chosen.models.len();
    let fetched_at = (!chosen.fetched_at.is_empty()).then_some(chosen.fetched_at.clone());
    activate(build_catalog(&chosen.models), fetched_at);
    count
}

/// True when the loaded catalog is older than the 7-day refresh interval
/// (unknown age counts as stale).
pub fn is_stale() -> bool {
    with_active(|state| match state.and_then(|s| s.fetched_at.as_deref()) {
        Some(at) => match parse_iso_ms(at) {
            Some(ms) => unix_ms_now().saturating_sub(ms) > REFRESH_INTERVAL_MS,
            None => true,
        },
        None => true,
    })
}

/// Test seam: drop the loaded catalog + refresh-session flag (TS
/// `_setOrCacheDirForTests` reset semantics).
#[cfg(test)]
fn reset_for_tests() {
    *state_cell().lock().expect("catalog state poisoned") = None;
    *refreshed_cell().lock().expect("refresh flag poisoned") = false;
}

/// Pull a fresh catalog from `url` (models.dev in production, a mock in
/// tests) and swap it in. Never fails hard — on network/parse/disk errors
/// the currently loaded catalog stays. Returns true when replaced.
pub(crate) async fn refresh_from(data_dir: &Path, url: &str) -> bool {
    let client = reqwest::Client::new();
    let Ok(resp) = client.get(url).send().await else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    let Ok(json) = resp.json::<Value>().await else {
        return false;
    };
    let flat = flatten_models_dev_api(&json);
    let entries = build_catalog(&flat);
    if entries.len() < REFRESH_SANITY_MIN {
        return false;
    }
    let file = CatalogFile {
        fetched_at: format_iso_ms(unix_ms_now()),
        source: CATALOG_URL.to_owned(),
        count: entries.len(),
        models: flat,
    };
    let _ = std::fs::create_dir_all(data_dir);
    if let Ok(text) = serde_json::to_string(&file) {
        let _ = std::fs::write(data_dir.join(CACHE_FILENAME), text);
    }
    activate(entries, Some(file.fetched_at));
    true
}

/// The refresh the splash screen's `modelCatalogRefresh` fires: deduped per
/// session (boot stale-refresh and the splash call share the slot), then
/// re-enriches stored provider models against the fresh catalog. Returns
/// immediately — the fetch continues in the caller's spawned task.
pub async fn refresh_model_catalog(state: &AppState, data_dir: &Path) -> bool {
    refresh_model_catalog_from(state, data_dir, CATALOG_URL).await
}

pub(crate) async fn refresh_model_catalog_from(
    state: &AppState,
    data_dir: &Path,
    url: &str,
) -> bool {
    if !claim_refresh_slot() {
        return false;
    }
    load(data_dir); // ensure is_stale/enrichment see a catalog even if refresh fails
    if !refresh_from(data_dir, url).await {
        return false;
    }
    let _ = enrich_existing_models(state);
    true
}

/// Boot-time init (TS `initModelCatalog`): load, and when stale kick the
/// background refresh. Never fails.
pub async fn init(state: &AppState, data_dir: &Path) {
    load(data_dir);
    if is_stale() {
        let _ = refresh_model_catalog(state, data_dir).await;
    }
}

// ── matching + resolve (model-catalog.ts port) ──────────────────────

/// Lowercase, trim, drop the provider prefix segment.
fn normalize(id: &str) -> String {
    let trimmed = id.trim().to_lowercase();
    match trimmed.rfind('/') {
        Some(idx) => trimmed[idx + 1..].to_owned(),
        None => trimmed,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MatchState {
    Matched,
    Ambiguous,
    None_,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    pub state: MatchState,
    pub matches: Vec<CatalogEntry>,
}

pub fn match_model_to_catalog(model_id: &str) -> MatchResult {
    with_active(|catalog| match catalog {
        None => MatchResult {
            state: MatchState::None_,
            matches: Vec::new(),
        },
        Some(catalog) => match_model_with(model_id, &catalog.entries),
    })
}

fn match_model_with(model_id: &str, catalog: &HashMap<String, CatalogEntry>) -> MatchResult {
    if model_id.trim().is_empty() {
        return MatchResult {
            state: MatchState::None_,
            matches: Vec::new(),
        };
    }
    let lower = model_id.trim().to_lowercase();

    // 1. Exact key match (modelId IS the full canonical id).
    if let Some(exact) = catalog.get(&lower).or_else(|| catalog.get(model_id.trim())) {
        return MatchResult {
            state: MatchState::Matched,
            matches: vec![exact.clone()],
        };
    }

    // 2. Suffix match: catalog key's normalized tail equals the target's.
    let target = normalize(model_id);
    let suffix: Vec<&CatalogEntry> = catalog
        .iter()
        .filter(|(key, _)| normalize(key) == target)
        .map(|(_, v)| v)
        .collect();
    if let Some(picked) = collapse(&suffix, catalog, &target) {
        return MatchResult {
            state: MatchState::Matched,
            matches: vec![picked.clone()],
        };
    }
    if !suffix.is_empty() {
        return MatchResult {
            state: MatchState::Ambiguous,
            matches: suffix.into_iter().cloned().collect(),
        };
    }

    // 3. Loose fallback: target (>=4 chars) contained in a catalog tail.
    let loose: Vec<&CatalogEntry> = catalog
        .iter()
        .filter(|(key, _)| target.len() >= 4 && normalize(key).contains(&target))
        .map(|(_, v)| v)
        .collect();
    if let Some(picked) = collapse(&loose, catalog, &target) {
        return MatchResult {
            state: MatchState::Matched,
            matches: vec![picked.clone()],
        };
    }
    if !loose.is_empty() {
        return MatchResult {
            state: MatchState::Ambiguous,
            matches: loose.into_iter().cloned().collect(),
        };
    }
    MatchResult {
        state: MatchState::None_,
        matches: Vec::new(),
    }
}

/// Collapse an ambiguous hit set to one entry when the hits are the same
/// model (bare canonical key, or all agree on price + context); `None` on
/// genuine conflict.
fn collapse<'a>(
    hits: &[&'a CatalogEntry],
    _catalog: &HashMap<String, CatalogEntry>,
    _target: &str,
) -> Option<&'a CatalogEntry> {
    // (a) Bare key = the model's canonical home entry.
    for h in hits {
        if !h.catalog_id.contains('/') {
            return Some(h);
        }
    }
    // (b) Agreement check on price + context.
    let first = hits.first()?;
    let agree = hits.iter().all(|h| {
        h.input_cost_per_token == first.input_cost_per_token
            && h.output_cost_per_token == first.output_cost_per_token
            && h.context_window == first.context_window
            && h.max_input_tokens == first.max_input_tokens
    });
    agree.then_some(first)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub input_per_token: f64,
    pub output_per_token: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeta {
    pub context_window: u64,
    pub max_input_tokens: u64,
    pub max_output_tokens: u64,
    pub supports_reasoning: bool,
    pub supports_function_calling: bool,
    pub supports_prompt_caching: bool,
    pub supports_vision: bool,
    pub mode: String,
    pub is_valid_for_main_role: bool,
    pub pricing: Option<ModelPricing>,
    pub resolved_catalog_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_options: Option<Vec<ReasoningOption>>,
}

/// Full metadata for a model — deterministic, no I/O. Resolution order:
/// catalogId → auto-match → conservative fallback.
pub fn resolve_model_meta(catalog_id: Option<&str>, model_id: &str, context_window: u64) -> ModelMeta {
    with_active(|catalog| match catalog {
        None => fallback_meta(context_window),
        Some(catalog) => {
            let mut entry: Option<CatalogEntry> = None;
            if let Some(id) = catalog_id.filter(|s| !s.is_empty()) {
                entry = catalog
                    .entries
                    .get(id)
                    .or_else(|| {
                        let lower = id.to_lowercase();
                        catalog.entries.get(&lower)
                    })
                    .cloned();
            }
            if entry.is_none() {
                let m = match_model_with(model_id, &catalog.entries);
                if m.state == MatchState::Matched {
                    entry = m.matches.into_iter().next();
                }
            }
            match entry {
                None => fallback_meta(context_window),
                Some(entry) => {
                    let resolved_context = if entry.context_window != 0 {
                        entry.context_window
                    } else if context_window != 0 {
                        context_window
                    } else {
                        FALLBACK_CONTEXT
                    };
                    ModelMeta {
                        context_window: resolved_context,
                        max_input_tokens: if entry.max_input_tokens != 0 {
                            entry.max_input_tokens
                        } else {
                            resolved_context
                        },
                        max_output_tokens: if entry.max_output_tokens != 0 {
                            entry.max_output_tokens
                        } else {
                            CONSERVATIVE_MAX_OUTPUT
                        },
                        supports_reasoning: entry.supports_reasoning,
                        supports_function_calling: entry.supports_function_calling,
                        supports_prompt_caching: entry.supports_prompt_caching,
                        supports_vision: entry.supports_vision,
                        mode: entry.mode.clone(),
                        is_valid_for_main_role: entry.mode == "chat" || entry.mode == "completion",
                        pricing: if entry.input_cost_per_token != 0.0 || entry.output_cost_per_token != 0.0 {
                            Some(ModelPricing {
                                input_per_token: entry.input_cost_per_token,
                                output_per_token: entry.output_cost_per_token,
                            })
                        } else {
                            None
                        },
                        resolved_catalog_id: Some(entry.catalog_id.clone()),
                        reasoning_options: entry.reasoning_options.clone(),
                    }
                }
            }
        }
    })
}

fn fallback_meta(context_window: u64) -> ModelMeta {
    ModelMeta {
        context_window: if context_window != 0 { context_window } else { FALLBACK_CONTEXT },
        max_input_tokens: if context_window != 0 { context_window } else { FALLBACK_CONTEXT },
        max_output_tokens: CONSERVATIVE_MAX_OUTPUT,
        supports_reasoning: false,
        // assume capable; callers guard separately (TS comment)
        supports_function_calling: true,
        supports_prompt_caching: false,
        supports_vision: false,
        mode: "chat".to_owned(),
        is_valid_for_main_role: true,
        pricing: None,
        resolved_catalog_id: None,
        reasoning_options: None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogResolveResult {
    pub meta: ModelMeta,
    pub r#match: MatchResult,
}

/// `modelCatalogResolve`: the catalog-less fallback returns the
/// conservative meta + `none` match (TS branch). The presence probe and the
/// resolve/match helpers each take the state lock separately — nesting them
/// inside one `with_active` closure would self-deadlock (std Mutex is not
/// reentrant).
pub fn resolve(
    catalog_id: Option<String>,
    model_id: String,
    context_window: u64,
) -> ModelCatalogResolveResult {
    if !with_active(|catalog| catalog.is_some()) {
        return ModelCatalogResolveResult {
            meta: fallback_meta(context_window),
            r#match: MatchResult {
                state: MatchState::None_,
                matches: Vec::new(),
            },
        };
    }
    ModelCatalogResolveResult {
        meta: resolve_model_meta(catalog_id.as_deref(), &model_id, context_window),
        r#match: match_model_to_catalog(&model_id),
    }
}

// ── post-refresh enrichment (enrichExistingModels port) ─────────────

/// Rewrite every catalog-matched provider model that lacks a catalogId.
/// Runs after boot init and every successful refresh; idempotent — models
/// with a catalogId are skipped, so user edits are preserved.
fn enrich_existing_models(state: &AppState) -> Result<usize, CommandError> {
    state.update_config(|cfg| {
        let mut enriched = 0usize;
        for provider in cfg.providers.iter_mut() {
            for model in provider.models.iter_mut() {
                if enrich_stored_model(model) {
                    enriched += 1;
                }
            }
        }
        Ok(enriched)
    })
}

/// The `enrichModelFromCatalog` port: fill catalogId + contextWindow + max
/// output + maxInputTokens + reasoning + vision + pricing from the catalog
/// when the stored entry lacks them. Returns true when the model changed.
fn enrich_stored_model(model: &mut StoredModel) -> bool {
    if model.catalog_id.is_some() {
        return false;
    }
    let meta = resolve_model_meta(None, &model.model_id, model.context_window);
    let Some(resolved) = meta.resolved_catalog_id.clone() else {
        return false;
    };
    let extra = &mut model.extra;
    model.catalog_id = Some(resolved);
    model.context_window = meta.context_window;
    extra
        .entry("max_completion_tokens".to_owned())
        .or_insert_with(|| Value::from(meta.max_output_tokens));
    extra
        .entry("maxInputTokens".to_owned())
        .or_insert_with(|| Value::from(meta.max_input_tokens));
    model
        .reasoning
        .get_or_insert(meta.supports_reasoning);
    extra
        .entry("vision".to_owned())
        .or_insert_with(|| Value::from(meta.supports_vision));
    if let Some(pricing) = &meta.pricing {
        extra
            .entry("inputCostPerToken".to_owned())
            .or_insert_with(|| serde_json::json!(pricing.input_per_token));
        extra
            .entry("outputCostPerToken".to_owned())
            .or_insert_with(|| serde_json::json!(pricing.output_per_token));
    }
    if let Some(contracts) = meta.reasoning_options.clone() {
        extra
            .entry("reasoningContracts".to_owned())
            .or_insert_with(|| serde_json::to_value(contracts).unwrap_or(Value::Null));
    }
    true
}

/// Entry count of the loaded catalog (0 when none) — surfaced for tests
/// and diagnostics.
#[cfg(test)]
pub(crate) fn catalog_entry_count() -> usize {
    with_active(|state| state.map(|s| s.entries.len()).unwrap_or(0))
}

#[cfg(test)]
// The test-state guard is a std Mutex deliberately held across awaits — it
// serializes tests touching the process-global catalog cells; each test's
// current-thread runtime keeps the suspension single-threaded, so the block
// only ever parks sibling test threads until the holder finishes.
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Serialize every test that touches the module's process-global cells —
    /// the harness runs tests in parallel, and concurrent reset/install/
    /// activate cycles on the shared state deadlock.
    fn test_state_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-model-catalog-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn install_catalog(models: &[(&str, RawCatalogEntry)], fetched_at: &str) {
        let flat: HashMap<String, RawCatalogEntry> = models
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        activate(build_catalog(&flat), Some(fetched_at.to_owned()));
    }

    #[test]
    fn iso_round_trip_through_the_bundled_timestamp() {
        let at = "2026-08-13T04:41:57.514Z";
        let ms = parse_iso_ms(at).expect("bundled timestamp parses");
        assert_eq!(format_iso_ms(ms), at);
        assert!(parse_iso_ms("not a date").is_none());
        assert!(parse_iso_ms("2026-08-13T04:41:57Z").is_some(), "no-millis form");
    }

    #[test]
    fn load_reads_bundled_baseline_and_resolves_claude() {
        let _guard = test_state_guard();
        reset_for_tests();
        let dir = temp_dir("bundled");
        let count = load(&dir);
        assert!(count > 1000, "bundled snapshot carries {count} models");
        let meta = resolve_model_meta(Some("anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5", 0);
        assert_eq!(meta.resolved_catalog_id.as_deref(), Some("anthropic/claude-sonnet-4-5"));
        assert!(meta.context_window >= 100_000);
        assert!(meta.supports_reasoning);
        assert!(meta.supports_function_calling);
        // models.dev's first-party anthropic entries carry no cost — the TS
        // resolve also yields pricing: null for them (the bare-id duplicate
        // listed under other providers is the one with pricing).
        assert!(meta.pricing.is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cache_newer_than_bundle_wins() {
        let _guard = test_state_guard();
        reset_for_tests();
        let dir = temp_dir("cache-newer");
        let cache = CatalogFile {
            fetched_at: "2099-01-01T00:00:00.000Z".into(),
            source: CATALOG_URL.into(),
            count: 1,
            models: HashMap::from([(
                "test/only-model".to_owned(),
                RawCatalogEntry {
                    limit: Some(RawLimit {
                        context: Some(4096),
                        output: Some(512),
                        input: None,
                    }),
                    cost: Some(RawCost {
                        input: Some(1.0),
                        output: Some(2.0),
                        cache_read: None,
                        cache_write: None,
                    }),
                    ..Default::default()
                },
            )]),
        };
        fs::write(
            dir.join(CACHE_FILENAME),
            serde_json::to_string(&cache).unwrap(),
        )
        .unwrap();
        let count = load(&dir);
        assert_eq!(count, 1, "fresh cache replaces the 2958-model bundle");
        let meta = resolve_model_meta(Some("test/only-model"), "anything", 0);
        assert_eq!(meta.context_window, 4096);
        assert_eq!(meta.max_input_tokens, 4096, "input ?? context");
        assert_eq!(meta.max_output_tokens, 512);
        // per-Mtok → per-token conversion
        let pricing = meta.pricing.unwrap();
        assert!((pricing.input_per_token - 0.000_001).abs() < 1e-12);
        assert_eq!(catalog_entry_count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn match_semantics_exact_suffix_and_ambiguous() {
        let _guard = test_state_guard();
        install_catalog(
            &[
                (
                    "anthropic/claude-sonnet-4-5",
                    RawCatalogEntry::default(),
                ),
                (
                    "openrouter/anthropic/claude-sonnet-4-5",
                    RawCatalogEntry::default(),
                ),
                ("google/gemini-2.5-pro", RawCatalogEntry::default()),
            ],
            "2099-01-01T00:00:00.000Z",
        );
        // Exact id wins outright.
        let exact = match_model_to_catalog("google/gemini-2.5-pro");
        assert_eq!(exact.state, MatchState::Matched);
        assert_eq!(exact.matches[0].catalog_id, "google/gemini-2.5-pro");
        // Bare id suffix-matches two entries with identical (empty) price +
        // context → agreement collapse → matched with the first hit.
        let suffix = match_model_to_catalog("claude-sonnet-4-5");
        assert_eq!(suffix.state, MatchState::Matched, "identical entries collapse");
        // Loose substring: 'gemini-2.5' is contained in the gemini tail only.
        let loose = match_model_to_catalog("gemini-2.5");
        assert_eq!(loose.state, MatchState::Matched);
        // Genuinely conflicting suffix hits stay ambiguous.
        install_catalog(
            &[
                (
                    "a/pro-model",
                    RawCatalogEntry {
                        cost: Some(RawCost {
                            input: Some(1.0),
                            output: None,
                            cache_read: None,
                            cache_write: None,
                        }),
                        limit: Some(RawLimit {
                            context: Some(1000),
                            input: None,
                            output: None,
                        }),
                        ..Default::default()
                    },
                ),
                (
                    "b/pro-model",
                    RawCatalogEntry {
                        cost: Some(RawCost {
                            input: Some(9.0),
                            output: None,
                            cache_read: None,
                            cache_write: None,
                        }),
                        limit: Some(RawLimit {
                            context: Some(2000),
                            input: None,
                            output: None,
                        }),
                        ..Default::default()
                    },
                ),
            ],
            "2099-01-01T00:00:00.000Z",
        );
        let ambiguous = match_model_to_catalog("pro-model");
        assert_eq!(ambiguous.state, MatchState::Ambiguous);
        assert_eq!(ambiguous.matches.len(), 2);
        assert_eq!(match_model_to_catalog("").state, MatchState::None_);
        assert_eq!(match_model_to_catalog("no-such-model").state, MatchState::None_);
    }

    #[test]
    fn resolve_falls_back_conservatively_without_catalog_or_match() {
        let _guard = test_state_guard();
        reset_for_tests();
        let result = resolve(None, "mystery-model".to_owned(), 0);
        assert_eq!(result.meta.context_window, 200_000);
        assert_eq!(result.meta.max_output_tokens, 8192);
        assert!(result.meta.supports_function_calling);
        assert_eq!(result.r#match.state, MatchState::None_);

        install_catalog(&[("x/known", RawCatalogEntry::default())], "2099-01-01T00:00:00.000Z");
        let known = resolve(None, "known".to_owned(), 12345);
        assert_eq!(known.meta.resolved_catalog_id.as_deref(), Some("x/known"));
        // Unmatched keeps the user-entered window.
        let custom = resolve(None, "mystery".to_owned(), 65000);
        assert_eq!(custom.meta.context_window, 65000);
        assert!(custom.meta.resolved_catalog_id.is_none());
    }

    #[test]
    fn flatten_keeps_slim_fields_and_drops_descriptions() {
        let api = serde_json::json!({
            "anthropic": {
                "name": "Anthropic",
                "models": {
                    "claude-sonnet-4-5": {
                        "description": "dropped",
                        "reasoning": true,
                        "tool_call": true,
                        "attachment": false,
                        "limit": { "context": 200000, "output": 64000 },
                        "cost": { "input": 3, "output": 15, "cache_read": 0.3 }
                    }
                }
            },
            "openai": { "not-models": true },
        });
        let flat = flatten_models_dev_api(&api);
        assert_eq!(flat.len(), 1);
        let entry = &flat["claude-sonnet-4-5"];
        assert_eq!(entry.reasoning, Some(true));
        assert_eq!(
            entry.limit,
            Some(RawLimit {
                context: Some(200_000),
                input: None,
                output: Some(64_000),
            })
        );
        let normalized = normalize_entry("claude-sonnet-4-5", entry);
        assert!(normalized.supports_prompt_caching);
        assert_eq!(normalized.cache_read_input_token_cost, Some(0.3 / 1_000_000.0));
    }

    #[test]
    fn enrichment_is_one_time_and_fills_missing_fields() {
        let _guard = test_state_guard();
        reset_for_tests();
        install_catalog(
            &[(
                "anthropic/claude-sonnet-4-5",
                RawCatalogEntry {
                    reasoning: Some(true),
                    tool_call: Some(true),
                    attachment: Some(true),
                    limit: Some(RawLimit {
                        context: Some(200_000),
                        input: None,
                        output: Some(64_000),
                    }),
                    cost: Some(RawCost {
                        input: Some(3.0),
                        output: Some(15.0),
                        cache_read: None,
                        cache_write: None,
                    }),
                    ..Default::default()
                },
            )],
            "2099-01-01T00:00:00.000Z",
        );
        let mut model = StoredModel {
            id: "m_1".into(),
            alias: "sonnet".into(),
            model_id: "claude-sonnet-4-5".into(),
            context_window: 0,
            provider_id: "p_1".into(),
            catalog_id: None,
            role: None,
            reasoning: None,
            reasoning_mandatory: None,
            supported_efforts: None,
            extra: Default::default(),
        };
        assert!(enrich_stored_model(&mut model));
        assert_eq!(model.catalog_id.as_deref(), Some("anthropic/claude-sonnet-4-5"));
        assert_eq!(model.context_window, 200_000);
        assert_eq!(model.reasoning, Some(true));
        assert_eq!(model.extra["vision"], Value::from(true));
        assert_eq!(model.extra["max_completion_tokens"], Value::from(64_000u64));
        assert_eq!(model.extra["maxInputTokens"], Value::from(200_000u64));
        assert_eq!(model.extra["inputCostPerToken"], serde_json::json!(3.0 / 1_000_000.0));
        // User-set values are never clobbered.
        model.extra.insert("max_completion_tokens".into(), Value::from(1024u64));
        assert!(!enrich_stored_model(&mut model), "catalogId set → skip");
        assert_eq!(model.extra["max_completion_tokens"], Value::from(1024u64));
    }

    #[test]
    fn staleness_follows_fetched_at() {
        let _guard = test_state_guard();
        install_catalog(&[("x/y", RawCatalogEntry::default())], "2000-01-01T00:00:00.000Z");
        assert!(is_stale());
        install_catalog(&[("x/y", RawCatalogEntry::default())], "2099-01-01T00:00:00.000Z");
        assert!(!is_stale());
    }

    /// models.dev-shaped mock: nested { provider: { models: { id: … } } }
    /// with `count` filler models plus the claude entry. The canonical entry
    /// is nested under its full "provider/model" id — the verbatim-key style
    /// the real API (and the vendored snapshot) uses for canonical entries.
    fn models_dev_server(count: usize) -> String {
        let mut models = serde_json::Map::new();
        models.insert(
            "anthropic/claude-sonnet-4-5".into(),
            serde_json::json!({
                "reasoning": true, "tool_call": true, "attachment": false,
                "limit": { "context": 200000, "output": 64000 },
                "cost": { "input": 3, "output": 15, "cache_read": 0.3 },
                "description": "dropped by the flattener"
            }),
        );
        for i in 0..count {
            models.insert(
                format!("filler-{i}"),
                serde_json::json!({ "limit": { "context": 1000 + i } }),
            );
        }
        let body = serde_json::json!({ "anthropic": { "models": models } }).to_string();
        let len = body.len();
        let response: &'static str = Box::leak(
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len}\r\n\r\n{body}")
                .into_boxed_str(),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/api.json")
    }

    #[tokio::test]
    async fn refresh_fetches_caches_enriches_and_dedupes_per_session() {
        let _guard = test_state_guard();
        reset_for_tests();
        let dir = temp_dir("refresh");
        let state_dir = temp_dir("refresh-state");
        std::fs::write(
            state_dir.join("config.json"),
            r#"{"providers":[{
                "id": "p_1", "name": "bare", "apiStyle": "anthropic",
                "baseUrl": "https://api.z.ai/api/anthropic", "enabled": true,
                "models": [{ "id": "m_1", "alias": "sonnet", "modelId": "claude-sonnet-4-5",
                             "contextWindow": 0, "providerId": "p_1" }]
            }]}"#,
        )
        .unwrap();
        let state = crate::state::AppState::load(state_dir.clone());
        let url = models_dev_server(150);

        assert!(refresh_model_catalog_from(&state, &dir, &url).await);
        assert_eq!(catalog_entry_count(), 151);
        let meta = resolve_model_meta(None, "claude-sonnet-4-5", 0);
        assert_eq!(meta.resolved_catalog_id.as_deref(), Some("anthropic/claude-sonnet-4-5"));
        assert_eq!(meta.context_window, 200_000);
        // Post-refresh enrichment wrote catalogId + metadata into config.
        state
            .read_config(|cfg| {
                let model = &cfg.providers[0].models[0];
                assert_eq!(model.catalog_id.as_deref(), Some("anthropic/claude-sonnet-4-5"));
                assert_eq!(model.context_window, 200_000);
                assert_eq!(model.reasoning, Some(true));
            })
            .unwrap();
        // The runtime cache carries the flattened slim shape.
        let cached: CatalogFile = serde_json::from_str(
            &std::fs::read_to_string(dir.join(CACHE_FILENAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(cached.count, 151);
        let claude = &cached.models["anthropic/claude-sonnet-4-5"];
        assert_eq!(claude.limit.as_ref().unwrap().context, Some(200_000));
        assert!(!claude.cost.as_ref().unwrap().cache_read.is_none());
        // A second refresh in the same session is deduped.
        assert!(!refresh_model_catalog_from(&state, &dir, &url).await);

        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&state_dir).unwrap();
        reset_for_tests();
    }

    #[tokio::test]
    async fn refresh_rejects_tiny_payloads_and_keeps_the_loaded_catalog() {
        let _guard = test_state_guard();
        reset_for_tests();
        let dir = temp_dir("refresh-tiny");
        let url = models_dev_server(3);
        assert!(!refresh_from(&dir, &url).await, "sanity gate aborts under 100 models");
        assert!(
            std::fs::read_to_string(dir.join(CACHE_FILENAME)).is_err(),
            "no cache written for a rejected payload"
        );
        assert!(!refresh_from(&dir, "http://127.0.0.1:1/api.json").await);
        std::fs::remove_dir_all(&dir).unwrap();
        reset_for_tests();
    }
}
