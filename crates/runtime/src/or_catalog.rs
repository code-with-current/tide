//! OpenRouter enrichment catalog — the port of the catalog half of
//! `app/rpc/providers.ts`. OpenRouter `/models` is the universal
//! metadata source: fetched on first probe, cached to the data dir as
//! `openrouter-models.json`, refreshed when older than 7 days. Bare-id
//! providers (z.ai, OpenAI direct, LM Studio) get their probed models
//! enriched by matching against this catalog so they carry real pricing /
//! context / reasoning. Never fails — a failed bootstrap leaves the catalog
//! empty and probing continues unenriched.

use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const CACHE_FILE: &str = "openrouter-models.json";
const REFRESH_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// The wire `ProviderModelMeta` — OpenRouter's mixed casing preserved
/// (`context_length`, `input_modalities` are snake in the wire type).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ProviderModelMeta {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        rename = "context_length",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_length: Option<u64>,
    #[serde(
        rename = "max_completion_tokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub max_completion_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<MetaPricing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<MetaReasoning>,
    #[serde(
        rename = "supported_parameters",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supported_parameters: Option<Vec<String>>,
    #[serde(
        rename = "input_modalities",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_modalities: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct MetaPricing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<String>,
    #[serde(
        rename = "input_cache_read",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_cache_read: Option<String>,
    #[serde(
        rename = "input_cache_write",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub input_cache_write: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct MetaReasoning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mandatory: Option<bool>,
    #[serde(
        rename = "default_enabled",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub default_enabled: Option<bool>,
    #[serde(
        rename = "supported_efforts",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub supported_efforts: Option<Vec<String>>,
}

/// One boot per process: the in-memory catalog + the completed bootstrap
/// flag (TS `orCatalog` / `orBooted`). Re-bootstrapping after a test resets
/// the cell.
#[derive(Default)]
struct OrState {
    catalog: Vec<ProviderModelMeta>,
    booted: bool,
}

fn state_cell() -> &'static Mutex<OrState> {
    static CELL: OnceLock<Mutex<OrState>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(OrState::default()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrCacheFile {
    #[serde(default)]
    data: Vec<Value>,
    #[serde(default)]
    fetched_at: Option<String>,
}

pub(crate) fn unix_ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// ISO (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`) → unix ms; `None` when unparseable.
fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u64> {
        std::str::from_utf8(&b[r]).ok()?.parse().ok()
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let millis = if b.len() > 20 && b[19] == b'.' {
        let end = b[20..]
            .iter()
            .position(|c| !c.is_ascii_digit())
            .map(|i| 20 + i)
            .unwrap_or(b.len());
        let digits = std::str::from_utf8(&b[20..end]).ok()?;
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
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let leap = |y: u64| (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400);
    let cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let mut days = 365 * (y.saturating_sub(1970)) + (1970..y).filter(|yy| leap(*yy)).count() as u64;
    days += cum[(mo - 1) as usize] + d - 1;
    if mo > 2 && leap(y) {
        days += 1;
    }
    Some((days * 86_400 + h * 3600 + mi * 60 + s) * 1000 + millis)
}

fn format_iso_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    // civil-from-days
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
        "{year:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn cache_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(CACHE_FILE)
}

/// Fetch + normalize the OpenRouter catalog. Cached to disk; refreshed when
/// stale. Never fails — a bad cache or unreachable endpoint leaves the
/// (possibly empty) in-memory catalog in place.
pub fn bootstrap(data_dir: &Path) {
    bootstrap_with(data_dir, OPENROUTER_MODELS_URL)
}

/// Set the catalog from the on-disk cache without any network access; the
/// background refresh fills or replaces it afterwards.
pub fn load_cached(data_dir: &Path) {
    if let Ok(cached) = std::fs::read_to_string(cache_path(data_dir)) {
        if let Ok(parsed) = serde_json::from_str::<OrCacheFile>(&cached) {
            if !parsed.data.is_empty() {
                set_catalog(normalize_probe_list(&parsed.data));
            }
        }
    }
}

pub fn bootstrap_with(data_dir: &Path, url: &str) {
    {
        let mut state = state_cell().lock().expect("or-catalog state poisoned");
        if state.booted {
            return;
        }
        state.booted = true;
    }
    if let Ok(cached) = std::fs::read_to_string(cache_path(data_dir)) {
        if let Ok(parsed) = serde_json::from_str::<OrCacheFile>(&cached) {
            if !parsed.data.is_empty() {
                let fresh = parsed
                    .fetched_at
                    .as_deref()
                    .and_then(parse_iso_ms)
                    .is_some_and(|at| unix_ms_now().saturating_sub(at) < REFRESH_MS);
                set_catalog(normalize_probe_list(&parsed.data));
                if fresh {
                    return;
                }
            }
        }
    }
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    let Ok(resp) = client.get(url).send() else {
        return;
    };
    if !resp.status().is_success() {
        return;
    }
    let Ok(json) = resp.json::<serde_json::Value>() else {
        return;
    };
    let Some(data) = json.get("data").and_then(Value::as_array) else {
        return;
    };
    set_catalog(normalize_probe_list(data));
    let wrapper = serde_json::json!({
        "data": data,
        "fetchedAt": format_iso_ms(unix_ms_now()),
    });
    let _ = std::fs::write(
        cache_path(data_dir),
        serde_json::to_string(&wrapper).unwrap_or_default(),
    );
}

fn set_catalog(catalog: Vec<ProviderModelMeta>) {
    state_cell()
        .lock()
        .expect("or-catalog state poisoned")
        .catalog = catalog;
}

fn catalog() -> Vec<ProviderModelMeta> {
    state_cell()
        .lock()
        .expect("or-catalog state poisoned")
        .catalog
        .clone()
}

/// True when an entry carries rich metadata beyond a bare id.
fn is_rich(m: &ProviderModelMeta) -> bool {
    m.context_length.is_some()
        || m.pricing.is_some()
        || m.reasoning.is_some()
        || m.max_completion_tokens.is_some()
        || m.input_modalities.is_some()
}

/// Match by exact id, then by the tail after the last '/'.
fn find_in_catalog(model_id: &str, catalog: &[ProviderModelMeta]) -> Option<ProviderModelMeta> {
    let lower = model_id.trim().to_lowercase();
    let hit = catalog
        .iter()
        .find(|m| m.id.to_lowercase() == lower)
        .or_else(|| {
            catalog.iter().find(|m| {
                m.id.rsplit('/')
                    .next()
                    .map(|t| t.eq_ignore_ascii_case(&lower))
                    == Some(true)
            })
        });
    hit.cloned()
}

/// Enrich bare-id models from the OpenRouter catalog, CRITICAL: preserving
/// the provider's original id (only metadata fields are copied).
pub fn enrich_bare_models(models: Vec<ProviderModelMeta>) -> Vec<ProviderModelMeta> {
    let catalog = catalog();
    if catalog.is_empty() {
        return models;
    }
    models
        .into_iter()
        .map(|m| {
            if is_rich(&m) {
                return m;
            }
            match find_in_catalog(&m.id, &catalog) {
                Some(enriched) => ProviderModelMeta {
                    id: m.id,
                    ..enriched
                },
                None => m,
            }
        })
        .collect()
}

/// Normalize a raw /models response array — handles both rich and bare-id
/// shapes defensively, drops id-less entries, sorts by id.
pub fn normalize_probe_list(raw: &[Value]) -> Vec<ProviderModelMeta> {
    let mut out = Vec::new();
    for item in raw {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let Some(id) = obj.get("id").and_then(Value::as_str) else {
            continue;
        };
        let num = |key: &str| obj.get(key).and_then(Value::as_u64);
        let top_provider = obj.get("top_provider").and_then(Value::as_object);
        let arch = obj.get("architecture").and_then(Value::as_object);
        let reasoning = obj.get("reasoning").and_then(Value::as_object);
        let pricing = obj.get("pricing").and_then(Value::as_object);
        let str_field =
            |map: Option<&serde_json::Map<String, Value>>, key: &str| -> Option<String> {
                map.and_then(|m| m.get(key))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
        let str_list = |value: Option<&Value>| -> Option<Vec<String>> {
            value
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .filter(|v: &Vec<String>| !v.is_empty())
        };
        let meta_pricing = pricing.and_then(|p| {
            (p.get("prompt").and_then(Value::as_str).is_some()
                || p.get("completion").and_then(Value::as_str).is_some())
            .then(|| MetaPricing {
                prompt: str_field(Some(p), "prompt"),
                completion: str_field(Some(p), "completion"),
                input_cache_read: str_field(Some(p), "input_cache_read"),
                input_cache_write: str_field(Some(p), "input_cache_write"),
            })
        });
        let supported_efforts = str_list(reasoning.and_then(|r| r.get("supported_efforts")));
        let meta_reasoning = reasoning.and_then(|r| {
            (r.get("mandatory").and_then(Value::as_bool).is_some()
                || r.get("default_enabled").and_then(Value::as_bool).is_some()
                || supported_efforts.is_some())
            .then(|| MetaReasoning {
                mandatory: r.get("mandatory").and_then(Value::as_bool),
                default_enabled: r.get("default_enabled").and_then(Value::as_bool),
                supported_efforts: supported_efforts.clone(),
            })
        });
        out.push(ProviderModelMeta {
            id: id.to_owned(),
            name: str_field(Some(obj), "name"),
            context_length: num("context_length"),
            max_completion_tokens: num("max_completion_tokens").or_else(|| {
                top_provider
                    .and_then(|t| t.get("max_completion_tokens"))
                    .and_then(Value::as_u64)
            }),
            pricing: meta_pricing,
            reasoning: meta_reasoning,
            supported_parameters: str_list(obj.get("supported_parameters")),
            input_modalities: str_list(
                arch.and_then(|a| a.get("input_modalities"))
                    .or_else(|| obj.get("input_modalities")),
            ),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Test seam: drop the boot flag + catalog (TS `_setOrCacheDirForTests`).
#[cfg(test)]
pub(crate) fn reset_for_tests() {
    let mut state = state_cell().lock().expect("or-catalog state poisoned");
    state.booted = false;
    state.catalog = Vec::new();
}

/// Serialize every test that touches this module's process-global cell —
/// the harness runs tests in parallel, and concurrent reset/bootstrap/
/// enrich cycles on the shared state deadlock (observed: four waiters on
/// the state mutex with no owner). Shared with the providers probe tests,
/// which bootstrap the same cell.
#[cfg(test)]
pub(crate) fn test_state_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
// The test-state guard is a std Mutex deliberately held across awaits — see
// the note in model_catalog's test module.
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tide-or-catalog-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn iso_helpers_round_trip() {
        let at = "2026-08-27T01:02:03.456Z";
        assert_eq!(format_iso_ms(parse_iso_ms(at).unwrap()), at);
        assert!(parse_iso_ms("junk").is_none());
    }

    #[test]
    fn normalize_maps_rich_and_bare_entries_and_sorts() {
        let raw = serde_json::json!([
            { "id": "z-late", "name": "Late" },
            {
                "id": "rich/model",
                "name": "Rich",
                "context_length": 131072,
                "top_provider": { "max_completion_tokens": 16384 },
                "pricing": { "prompt": "0.000003", "completion": "0.000015", "input_cache_read": "0.0000005" },
                "reasoning": { "mandatory": false, "supported_efforts": ["low", "high"] },
                "supported_parameters": ["tools", 42],
                "architecture": { "input_modalities": ["text", "image"] },
            },
            { "no_id": true },
            "not an object",
        ]);
        let list = normalize_probe_list(raw.as_array().unwrap());
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "rich/model", "sorted by id");
        let rich = &list[0];
        assert_eq!(rich.context_length, Some(131_072));
        assert_eq!(rich.max_completion_tokens, Some(16_384));
        assert_eq!(
            rich.pricing,
            Some(MetaPricing {
                prompt: Some("0.000003".into()),
                completion: Some("0.000015".into()),
                input_cache_read: Some("0.0000005".into()),
                input_cache_write: None,
            })
        );
        assert_eq!(
            rich.reasoning
                .as_ref()
                .and_then(|r| r.supported_efforts.clone()),
            Some(vec!["low".to_owned(), "high".to_owned()])
        );
        assert_eq!(
            rich.supported_parameters,
            Some(vec!["tools".to_owned()]),
            "non-strings dropped"
        );
        assert_eq!(
            rich.input_modalities,
            Some(vec!["text".into(), "image".into()])
        );
        assert_eq!(list[1].name, Some("Late".into()));
        assert!(list[1].pricing.is_none(), "bare entry stays bare");
    }

    #[test]
    fn enrich_preserves_provider_id_and_skips_rich_entries() {
        let _guard = test_state_guard();
        reset_for_tests();
        set_catalog(vec![
            ProviderModelMeta {
                id: "glm/glm-4.6".into(),
                context_length: Some(200_000),
                pricing: Some(MetaPricing {
                    prompt: Some("0.6".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            ProviderModelMeta {
                id: "already/rich".into(),
                context_length: Some(1),
                ..Default::default()
            },
        ]);
        let enriched = enrich_bare_models(vec![
            ProviderModelMeta {
                id: "glm-4.6".into(),
                ..Default::default()
            },
            ProviderModelMeta {
                id: "vendor/custom".into(),
                context_length: Some(8_192),
                ..Default::default()
            },
            ProviderModelMeta {
                id: "unmatched".into(),
                ..Default::default()
            },
        ]);
        assert_eq!(enriched[0].id, "glm-4.6", "original id preserved");
        assert_eq!(
            enriched[0].context_length,
            Some(200_000),
            "metadata copied from tail match"
        );
        assert_eq!(
            enriched[1].context_length,
            Some(8_192),
            "rich entry untouched"
        );
        assert!(enriched[2].context_length.is_none(), "no match stays bare");
        reset_for_tests();
    }

    #[test]
    fn bootstrap_reads_fresh_cache_without_network() {
        let _guard = test_state_guard();
        reset_for_tests();
        let dir = temp_dir("cache-hit");
        let wrapper = serde_json::json!({
            "data": [{ "id": "cached/model" }],
            "fetchedAt": format_iso_ms(unix_ms_now()),
        });
        fs::write(cache_path(&dir), wrapper.to_string()).unwrap();
        bootstrap_with(&dir, "http://127.0.0.1:1/unreachable");
        assert_eq!(catalog().len(), 1);
        assert_eq!(catalog()[0].id, "cached/model");
        // Booted flag holds: a second call never re-reads.
        fs::remove_file(cache_path(&dir)).unwrap();
        bootstrap_with(&dir, "http://127.0.0.1:1/unreachable");
        assert_eq!(catalog().len(), 1);
        fs::remove_dir_all(&dir).unwrap();
        reset_for_tests();
    }

    /// Canned HTTP server (the tools http.rs test pattern): answers
    /// every request with `response`.
    fn mock_server(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}")
    }

    fn json_response(body: &'static str) -> &'static str {
        let len = body.len();
        Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len}\r\n\r\n{body}"
            )
            .into_boxed_str(),
        )
    }

    #[test]
    fn stale_cache_triggers_fetch_and_write() {
        let _guard = test_state_guard();
        reset_for_tests();
        let dir = temp_dir("fetch");
        fs::write(
            cache_path(&dir),
            serde_json::json!({
                "data": [{ "id": "old/model" }],
                "fetchedAt": "2020-01-01T00:00:00.000Z",
            })
            .to_string(),
        )
        .unwrap();
        let base = mock_server(json_response(r#"{"data":[{"id":"fresh/model"}]}"#));
        bootstrap_with(&dir, &format!("{base}/models"));
        assert_eq!(catalog().len(), 1);
        assert_eq!(catalog()[0].id, "fresh/model");
        let cached: OrCacheFile =
            serde_json::from_str(&fs::read_to_string(cache_path(&dir)).unwrap()).unwrap();
        assert_eq!(cached.data[0]["id"], "fresh/model");
        assert!(cached.fetched_at.is_some());
        fs::remove_dir_all(&dir).unwrap();
        reset_for_tests();
    }
}
