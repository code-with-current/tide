//! The provider domain — `providerList` plus the provider surface ported
//! from `app/rpc/providers.ts` + `app/core/configStore.ts`:
//! CRUD (`providerAdd`/`Update`/`Delete` — id gen, defaults, model entry
//! mapping, apiKey → kcv2 keychain handle), the connection probes
//! (`providerProbeModels` / `providerDetectProtocol` /
//! `providerTestConnection` — OpenAI vs Anthropic endpoint conventions),
//! usage metering (`providerUsageWindows` off the local usage.db rollups,
//! `providerUsageReport` off the provider quota APIs), and the models.dev
//! catalog pair (`modelCatalogRefresh` / `modelCatalogResolve`). Stored
//! providers pass through verbatim (models, limits, and any future fields
//! ride tide-store's flatten-preserved extras) with the keychain joined
//! in: the wire `apiKey` is the decrypted key when one resolves and is
//! omitted otherwise. A key that fails to resolve (e.g. an unmigrated
//! legacy blob) is reported as absent, never a command failure, matching
//! the TS decrypt-to-empty fallback.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tide_store::config::StoredProvider;
use tide_store::secrets::SecretsError;

use tauri::Manager;

use crate::state::AppState;

use super::or_catalog::{
    bootstrap as or_bootstrap, enrich_bare_models, normalize_probe_list,
};
use super::usage_report::provider_usage_report as fetch_provider_report;
use super::CommandError;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const DETECT_TIMEOUT: Duration = Duration::from_secs(8);
const TEST_TIMEOUT: Duration = Duration::from_secs(20);

#[tauri::command]
pub fn provider_list(state: tauri::State<AppState>) -> Result<Vec<Value>, CommandError> {
    list(&state)
}

fn list(state: &AppState) -> Result<Vec<Value>, CommandError> {
    state.read_config(|cfg| {
        cfg.providers
            .iter()
            .map(|stored| provider_wire(cfg, stored))
            .collect()
    })
}

fn provider_wire(config: &tide_store::config::Config, stored: &StoredProvider) -> Value {
    let mut wire = serde_json::to_value(stored).expect("stored provider serializes");
    let obj = wire
        .as_object_mut()
        .expect("stored provider serializes to an object");
    obj.remove("encryptedKey");
    // The wire type has `models: Model[]` required; tide-store skips empty
    // vectors when serializing, so restore the explicit empty array.
    obj.entry("models".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Ok(Some(key)) = tide_store::secrets::get_api_key(config, &stored.id) {
        if !key.is_empty() {
            obj.insert("apiKey".to_string(), Value::String(key));
        }
    }
    wire
}

impl From<SecretsError> for CommandError {
    fn from(e: SecretsError) -> Self {
        CommandError::with_code(e.to_string(), "KEYCHAIN")
    }
}

// ── id generation (TS `p_` + 8 base36 chars / `m_` + 6) ─────────────

/// Random base36 token from /dev/urandom; falls back to a time-derived
/// token on platforms without it.
fn random_token(len: usize) -> String {
    const CHARSET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut raw = vec![0u8; len];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut raw))
        .is_err()
    {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0);
        for (i, slot) in raw.iter_mut().enumerate() {
            *slot = ((nanos >> (i % 32)) as u8).wrapping_add(i as u8);
        }
    }
    raw.iter()
        .map(|b| CHARSET[(*b as usize) % CHARSET.len()] as char)
        .collect()
}

/// The encryption seam — the command path uses the real kcv2 keychain
/// write; tests inject a pure stand-in so no test touches the keychain.
type EncryptFn<'a> = &'a dyn Fn(&str) -> Result<String, CommandError>;

fn real_encrypt(value: &str) -> Result<String, CommandError> {
    tide_store::secrets::encrypt_stored(value).map_err(CommandError::from)
}

// ── providerAdd / providerUpdate / providerDelete ───────────────────

#[tauri::command]
pub fn provider_add(
    state: tauri::State<AppState>,
    input: Value,
) -> Result<Value, CommandError> {
    add(&state, input, &real_encrypt)
}

fn add(state: &AppState, input: Value, encrypt: EncryptFn<'_>) -> Result<Value, CommandError> {
    let input = input.as_object().cloned().unwrap_or_default();
    let name = string_field(&input, "name").unwrap_or_default();
    let api_style = string_field(&input, "apiStyle").unwrap_or_default();
    validate_api_style(&api_style)?;
    let base_url = string_field(&input, "baseUrl").unwrap_or_default();
    let api_key = string_field(&input, "apiKey").unwrap_or_default();
    let input_models = input
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    state.update_config(|cfg| {
        let id = format!("p_{}", random_token(8));
        let mut models = Vec::with_capacity(input_models.len());
        for model in &input_models {
            models.push(stored_model_from_wire(model, &id, &random_model_id())?);
        }
        let stored = StoredProvider {
            id: id.clone(),
            name,
            api_style,
            base_url,
            encrypted_key: Some(encrypt(&api_key)?),
            enabled: true,
            models,
            extra: Map::new(),
        };
        cfg.providers.push(stored.clone());
        Ok(provider_wire(cfg, &stored))
    })
}

fn random_model_id() -> String {
    format!("m_{}", random_token(6))
}

fn validate_api_style(style: &str) -> Result<(), CommandError> {
    if style == "openai" || style == "anthropic" {
        Ok(())
    } else {
        Err(CommandError::with_code(
            format!("invalid apiStyle: {style:?}"),
            "PROVIDER_INVALID",
        ))
    }
}

/// Coerce one wire model object into a StoredModel under `provider_id`,
/// generating an id when the entry lacks one (the add flow's input models
/// carry only alias/modelId/contextWindow).
fn stored_model_from_wire(
    model: &Value,
    provider_id: &str,
    generated_id: &str,
) -> Result<tide_store::config::StoredModel, CommandError> {
    let mut obj = model.as_object().cloned().unwrap_or_default();
    match obj.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => {
            obj.insert("providerId".to_owned(), Value::from(provider_id));
        }
        _ => {
            obj.insert("id".to_owned(), Value::from(generated_id));
            obj.insert("providerId".to_owned(), Value::from(provider_id));
        }
    }
    serde_json::from_value::<tide_store::config::StoredModel>(Value::Object(obj)).map_err(|e| {
        CommandError::with_code(format!("invalid model entry: {e}"), "PROVIDER_INVALID")
    })
}

#[tauri::command]
pub fn provider_update(
    state: tauri::State<AppState>,
    provider_id: String,
    patch: Value,
) -> Result<Option<Value>, CommandError> {
    update(&state, provider_id, patch, &real_encrypt)
}

fn update(
    state: &AppState,
    provider_id: String,
    patch: Value,
    encrypt: EncryptFn<'_>,
) -> Result<Option<Value>, CommandError> {
    let patch = patch.as_object().cloned().unwrap_or_default();
    state.update_config(|cfg| {
        let Some(index) = cfg.providers.iter().position(|p| p.id == provider_id) else {
            return Ok(None);
        };
        let stored = &mut cfg.providers[index];
        // Key-presence semantics — the faithful port of the TS
        // `patch.x !== undefined` guards (an explicit null overwrites).
        if let Some(name) = string_field(&patch, "name") {
            stored.name = name;
        }
        if let Some(style) = string_field(&patch, "apiStyle") {
            validate_api_style(&style)?;
            // apiStyle must stay mutable so an existing provider can switch
            // protocols (e.g. z.ai Anthropic → OpenAI endpoint) via Edit.
            stored.api_style = style;
        }
        if let Some(base_url) = string_field(&patch, "baseUrl") {
            stored.base_url = base_url;
        }
        if let Some(enabled) = patch.get("enabled").and_then(Value::as_bool) {
            stored.enabled = enabled;
        }
        if let Some(limits) = patch.get("limits") {
            stored
                .extra
                .insert("limits".to_owned(), limits.clone());
        }
        if let Some(models) = patch.get("models").and_then(Value::as_array) {
            let mut next = Vec::with_capacity(models.len());
            for model in models {
                next.push(stored_model_from_wire(model, &provider_id, &random_model_id())?);
            }
            stored.models = next;
        }
        if let Some(api_key) = patch.get("apiKey").and_then(Value::as_str) {
            stored.encrypted_key = Some(encrypt(api_key)?);
        }
        Ok(Some(provider_wire(cfg, &cfg.providers[index])))
    })
}

#[tauri::command]
pub fn provider_delete(
    state: tauri::State<AppState>,
    provider_id: String,
) -> Result<DeleteResult, CommandError> {
    delete(&state, provider_id)
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct DeleteResult {
    pub ok: bool,
}

fn delete(state: &AppState, provider_id: String) -> Result<DeleteResult, CommandError> {
    state.update_config(|cfg| {
        let before = cfg.providers.len();
        cfg.providers.retain(|p| p.id != provider_id);
        Ok(DeleteResult {
            ok: cfg.providers.len() < before,
        })
    })
}

fn string_field(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_owned)
}

// ── HTTP probes (probe / detect / test) ─────────────────────────────

struct HttpReply {
    status: u16,
    content_type: String,
    body: String,
}

async fn http_request(
    method: reqwest::Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
    timeout: Duration,
) -> Result<HttpReply, String> {
    let client = reqwest::Client::new();
    let mut req = client.request(method, url).timeout(timeout);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    if let Some(body) = body {
        req = req.body(body.to_owned());
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(HttpReply {
        status,
        content_type,
        body,
    })
}

fn has_version_segment(clean_base: &str) -> bool {
    // The TS regex `/\/v\d+$/` — a trailing `v` + at least one digit.
    clean_base.rsplit('/').next().is_some_and(|last| {
        last.len() > 1
            && last.starts_with('v')
            && last[1..].chars().all(|c| c.is_ascii_digit())
    })
}

fn trim_trailing_slashes(url: &str) -> &str {
    url.trim_end_matches('/')
}

fn auth_headers(api_style: &str, api_key: &str) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("content-type", "application/json".to_owned()),
        ("authorization", format!("Bearer {api_key}")),
    ];
    if api_style == "anthropic" {
        headers.pop();
        headers.push(("x-api-key", api_key.to_owned()));
        headers.push(("anthropic-version", "2023-06-01".to_owned()));
    }
    headers
}

/// `data ?? models` from a parsed /models response.
fn models_array(json: &Value) -> Option<&Vec<Value>> {
    json.get("data")
        .and_then(Value::as_array)
        .or_else(|| json.get("models").and_then(Value::as_array))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInput {
    api_style: String,
    base_url: String,
    api_key: String,
}

#[tauri::command]
pub async fn provider_probe_models(
    state: tauri::State<'_, AppState>,
    input: ProbeInput,
) -> Result<Value, CommandError> {
    Ok(probe_models(state.data_dir(), input).await)
}

async fn probe_models(data_dir: &std::path::Path, input: ProbeInput) -> Value {
    let ProbeInput {
        api_style,
        base_url,
        api_key,
    } = input;
    if base_url.trim().is_empty() {
        return probe_error("Base URL is empty.");
    }
    or_bootstrap(data_dir).await;
    if api_key.trim().is_empty() {
        return probe_error(
            "API key is empty — type one or save a stored key first.",
        );
    }
    let clean_base = trim_trailing_slashes(&base_url);
    let url = if api_style == "openai" || has_version_segment(clean_base) {
        format!("{clean_base}/models")
    } else {
        format!("{clean_base}/v1/models")
    };
    let headers = auth_headers(&api_style, &api_key);
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(n, v)| (*n, v.as_str()))
        .collect();
    let mut reply = match http_request(
        reqwest::Method::GET,
        &url,
        &header_refs,
        None,
        PROBE_TIMEOUT,
    )
    .await
    {
        Ok(reply) => reply,
        Err(e) => return probe_error(&e),
    };
    if !(200..300).contains(&reply.status)
        && api_style == "openai"
        && !has_version_segment(clean_base)
    {
        let v1_url = format!("{clean_base}/v1/models");
        if let Ok(v1) =
            http_request(reqwest::Method::GET, &v1_url, &header_refs, None, PROBE_TIMEOUT).await
        {
            if (200..300).contains(&v1.status) {
                reply = v1;
            }
        }
    }
    if !(200..300).contains(&reply.status) {
        return probe_error(&format!("HTTP {}{}", reply.status, body_suffix(&reply.body)));
    }
    if reply.content_type.contains("application/json") {
        match serde_json::from_str::<Value>(&reply.body) {
            Ok(json) => {
                let list = models_array(&json).cloned().unwrap_or_default();
                let models = enrich_bare_models(normalize_probe_list(&list));
                return serde_json::json!({ "ok": true, "models": models });
            }
            Err(e) => return probe_error(&e.to_string()),
        }
    }
    // Non-JSON content types get one lenient body parse before rejecting —
    // some gateways serve JSON without the content type.
    if let Ok(json) = serde_json::from_str::<Value>(&reply.body) {
        if let Some(list) = models_array(&json) {
            let models = enrich_bare_models(normalize_probe_list(list));
            return serde_json::json!({ "ok": true, "models": models });
        }
    }
    probe_error(&format!(
        "Expected JSON but got {}. Check the base URL — it may need a different path or the provider may not expose a models endpoint.",
        if reply.content_type.is_empty() { "unknown content type".to_owned() } else { reply.content_type.clone() }
    ))
}

/// The TS ``HTTP <status>: <body-up-to-200-chars>`` error suffix.
fn body_suffix(body: &str) -> String {
    if body.is_empty() {
        String::new()
    } else {
        format!(": {}", &body[..body.len().min(200)])
    }
}

fn probe_error(message: &str) -> Value {
    serde_json::json!({ "ok": false, "error": message })
}

#[tauri::command]
pub async fn provider_detect_protocol(
    state: tauri::State<'_, AppState>,
    base_url: String,
    api_key: String,
) -> Result<Value, CommandError> {
    Ok(detect_protocol(state.data_dir(), base_url, api_key).await)
}

async fn detect_protocol(data_dir: &std::path::Path, base_url: String, api_key: String) -> Value {
    if base_url.trim().is_empty() || api_key.trim().is_empty() {
        return serde_json::json!({ "error": "Base URL and API key are required." });
    }
    let clean_base = trim_trailing_slashes(&base_url);
    let openai_headers = auth_headers("openai", &api_key);
    let anthropic_headers = auth_headers("anthropic", &api_key);
    let openai_url = format!("{clean_base}/models");
    let anthropic_url = if has_version_segment(clean_base) {
        format!("{clean_base}/models")
    } else {
        format!("{clean_base}/v1/models")
    };
    let probe = |url: String, headers: Vec<(&'static str, String)>| async move {
        let header_refs: Vec<(&str, &str)> = headers
            .iter()
            .map(|(n, v)| (*n, v.as_str()))
            .collect();
        let Ok(reply) = http_request(
            reqwest::Method::GET,
            &url,
            &header_refs,
            None,
            DETECT_TIMEOUT,
        )
        .await
        else {
            return None;
        };
        if !(200..300).contains(&reply.status) {
            return None;
        }
        let json = serde_json::from_str::<Value>(&reply.body).ok()?;
        let list = models_array(&json)?;
        if list.is_empty() {
            return None;
        }
        Some(normalize_probe_list(list))
    };
    // Both candidates race (TS Promise.allSettled); OpenAI wins ties
    // because it was pushed first.
    let (openai, anthropic) = tokio::join!(
        probe(openai_url, openai_headers),
        probe(anthropic_url, anthropic_headers)
    );
    or_bootstrap(data_dir).await;
    for (style, result) in [("openai", openai), ("anthropic", anthropic)] {
        if let Some(models) = result {
            return serde_json::json!({ "apiStyle": style, "models": enrich_bare_models(models) });
        }
    }
    serde_json::json!({ "error": "Could not detect API protocol — neither OpenAI nor Anthropic endpoint responded with a valid models list. Check the base URL and API key." })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestInput {
    api_style: String,
    base_url: String,
    api_key: String,
    model_id: String,
}

#[tauri::command]
pub async fn provider_test_connection(input: TestInput) -> Result<Value, CommandError> {
    Ok(test_connection(input).await)
}

async fn test_connection(input: TestInput) -> Value {
    let TestInput {
        api_style,
        base_url,
        api_key,
        model_id,
    } = input;
    if base_url.trim().is_empty() {
        return probe_error("Base URL is empty.");
    }
    if api_key.trim().is_empty() {
        return probe_error("API key is empty.");
    }
    if model_id.trim().is_empty() {
        return probe_error("Model ID is empty.");
    }
    let clean_base = trim_trailing_slashes(&base_url);
    let url = if api_style == "openai" {
        format!("{clean_base}/chat/completions")
    } else if has_version_segment(clean_base) {
        format!("{clean_base}/messages")
    } else {
        format!("{clean_base}/v1/messages")
    };
    let headers = auth_headers(&api_style, &api_key);
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(n, v)| (*n, v.as_str()))
        .collect();
    let body = serde_json::json!({
        "model": model_id,
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "Say hello in one word." }],
    })
    .to_string();
    match http_request(
        reqwest::Method::POST,
        &url,
        &header_refs,
        Some(&body),
        TEST_TIMEOUT,
    )
    .await
    {
        Ok(reply) if (200..300).contains(&reply.status) => serde_json::json!({ "ok": true }),
        Ok(reply) => probe_error(&format!("HTTP {}{}", reply.status, body_suffix(&reply.body))),
        Err(e) => probe_error(&e),
    }
}

// ── usage metering ──────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowUsageWire {
    pub tokens: i64,
    pub oldest_at: i64,
    pub newest_at: i64,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowsWire {
    pub five_hour: WindowUsageWire,
    pub weekly: WindowUsageWire,
}

#[tauri::command]
pub fn provider_usage_windows(
    state: tauri::State<AppState>,
    provider_id: String,
) -> Result<UsageWindowsWire, CommandError> {
    Ok(windows(&state, provider_id, tide_store::usage::unix_ms_now()))
}

fn windows(
    state: &AppState,
    provider_id: String,
    now: i64,
) -> UsageWindowsWire {
    let wire = |window_ms: i64| {
        let usage = tide_store::usage::provider_window_usage(
            state.data_dir(),
            &provider_id,
            window_ms,
            now,
        );
        WindowUsageWire {
            tokens: usage.tokens,
            oldest_at: usage.oldest_at,
            newest_at: usage.newest_at,
        }
    };
    UsageWindowsWire {
        five_hour: wire(tide_store::usage::FIVE_HOUR_MS),
        weekly: wire(tide_store::usage::WEEK_MS),
    }
}

#[tauri::command]
pub async fn provider_usage_report(
    state: tauri::State<'_, AppState>,
    provider_id: String,
) -> Result<Option<super::usage_report::ProviderUsageReport>, CommandError> {
    let fetched = state.read_config(|cfg| {
        let provider = cfg.providers.iter().find(|p| p.id == provider_id)?;
        let key = tide_store::secrets::get_api_key(cfg, &provider.id)
            .ok()
            .flatten()
            .filter(|k| !k.is_empty());
        Some((provider.base_url.clone(), key))
    })?;
    let Some((base_url, api_key)) = fetched else {
        return Ok(None);
    };
    Ok(fetch_provider_report(&base_url, api_key.as_deref()).await)
}

// ── models.dev catalog pair ─────────────────────────────────────────

#[derive(Serialize)]
pub struct OkWire {
    pub ok: bool,
}

/// Fire-and-forget refresh: resolve immediately (the fetch + re-enrich
/// continue in the spawned task), exactly like the TS splash handler.
#[tauri::command]
pub async fn model_catalog_refresh(
    app: tauri::AppHandle,
) -> Result<OkWire, CommandError> {
    let data_dir = app.state::<AppState>().data_dir().to_owned();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        super::model_catalog::refresh_model_catalog(&state, &data_dir).await;
    });
    Ok(OkWire { ok: true })
}

#[tauri::command]
pub fn model_catalog_resolve(
    state: tauri::State<AppState>,
    catalog_id: Option<String>,
    model_id: String,
    context_window: u64,
) -> Result<super::model_catalog::ModelCatalogResolveResult, CommandError> {
    // Idempotent no-op once boot init has loaded; keeps resolve working
    // even when it wins the race with the boot task.
    super::model_catalog::load(state.data_dir());
    Ok(super::model_catalog::resolve(catalog_id, model_id, context_window))
}

#[cfg(test)]
// The or-catalog test-state guard is a std Mutex deliberately held across
// awaits — see the note in model_catalog's test module.
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use tide_store::usage::UsageDelta;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-cmd-providers-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_with_config(name: &str, config_json: &str) -> (AppState, PathBuf) {
        let dir = temp_dir(name);
        fs::write(dir.join("config.json"), config_json).unwrap();
        (AppState::load(dir.clone()), dir)
    }

    fn plain_encrypt(value: &str) -> Result<String, CommandError> {
        use base64::Engine as _;
        if value.is_empty() {
            Ok(String::new())
        } else {
            Ok(base64::engine::general_purpose::STANDARD.encode(value))
        }
    }

    #[test]
    fn keyless_provider_has_no_api_key_but_keeps_shape() {
        let (state, dir) = state_with_config(
            "no-key",
            r#"{"providers":[{
                "id": "p_plain", "name": "Local", "apiStyle": "openai",
                "baseUrl": "http://localhost:1234", "enabled": true, "models": []
            }]}"#,
        );
        let providers = list(&state).unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(
            providers[0],
            serde_json::json!({
                "id": "p_plain", "name": "Local", "apiStyle": "openai",
                "baseUrl": "http://localhost:1234", "enabled": true, "models": []
            })
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stored_key_resolves_to_api_key_and_never_leaks_the_handle() {
        let (state, dir) = state_with_config(
            "plain-key",
            r#"{"providers":[{
                "id": "p_key", "name": "zai", "apiStyle": "anthropic",
                "baseUrl": "https://api.example", "encryptedKey": "c2stbGl2ZS0xMjM=",
                "enabled": false,
                "models": [{
                    "id": "m_1", "alias": "glm", "modelId": "glm-4.5",
                    "contextWindow": 131072, "providerId": "p_key",
                    "priceLabel": "$0.60 / $2.20 per Mtok", "vision": false
                }],
                "limits": { "fiveHourTokens": 1000000 }
            }]}"#,
        );
        let providers = list(&state).unwrap();
        let provider = &providers[0];
        assert_eq!(provider["apiKey"], serde_json::json!("sk-live-123"), "plaintext handle passes through");
        assert!(provider.as_object().unwrap().get("encryptedKey").is_none());
        assert_eq!(provider["enabled"], serde_json::json!(false));
        assert_eq!(provider["models"][0]["priceLabel"], serde_json::json!("$0.60 / $2.20 per Mtok"));
        assert_eq!(provider["limits"], serde_json::json!({ "fiveHourTokens": 1000000 }));
        let wire = serde_json::to_string(provider).unwrap();
        assert!(!wire.contains("c2stbGl2ZS0xMjM"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_and_unresolvable_keys_read_as_absent() {
        let (state, dir) = state_with_config(
            "absent-keys",
            r#"{"providers":[
                { "id": "p_empty", "name": "a", "apiStyle": "openai", "baseUrl": "u",
                  "encryptedKey": "", "enabled": true, "models": [] },
                { "id": "p_v10", "name": "b", "apiStyle": "openai", "baseUrl": "u",
                  "encryptedKey": "djEwAAAAAAAAAAAAAAAAAAAAAA==",
                  "enabled": true, "models": [] },
                { "id": "p_kcv2", "name": "c", "apiStyle": "openai", "baseUrl": "u",
                  "encryptedKey": "a2N2MjphYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYTpiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYjpjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjYw==",
                  "enabled": true, "models": [] }
            ]}"#,
        );
        let providers = list(&state).unwrap();
        assert_eq!(providers.len(), 3);
        for provider in &providers {
            assert!(
                provider.as_object().unwrap().get("apiKey").is_none(),
                "empty, legacy-blob, and item-less keys must read as absent"
            );
            assert!(provider.as_object().unwrap().get("encryptedKey").is_none());
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_and_unreadable_configs() {
        let (state, dir) = state_with_config("empty", "{}");
        assert!(list(&state).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();

        let (state, dir) = state_with_config("broken", "{ nope");
        let err = list(&state).unwrap_err();
        assert_eq!(err.code.as_deref(), Some("CONFIG_UNREADABLE"));
        fs::remove_dir_all(&dir).unwrap();
    }

    // ── CRUD round-trip (keychain write injected) ───────────────────

    #[test]
    fn add_generates_ids_stores_key_and_persists() {
        let (state, dir) = state_with_config("add", "{}");
        let wire = add(
            &state,
            serde_json::json!({
                "name": "z.ai", "apiStyle": "anthropic",
                "baseUrl": "https://api.z.ai/api/anthropic",
                "apiKey": "sk-test",
                "models": [
                    { "alias": "glm", "modelId": "glm-4.6", "contextWindow": 200000 }
                ]
            }),
            &plain_encrypt,
        )
        .unwrap();
        assert!(wire["id"].as_str().unwrap().starts_with("p_"));
        assert_eq!(wire["id"].as_str().unwrap().len(), 10);
        assert_eq!(wire["enabled"], serde_json::json!(true));
        assert_eq!(wire["apiKey"], serde_json::json!("sk-test"));
        let model = &wire["models"][0];
        assert!(model["id"].as_str().unwrap().starts_with("m_"));
        assert_eq!(model["providerId"], wire["id"]);
        assert_eq!(model["contextWindow"], serde_json::json!(200000));

        // Persisted shape: encryptedKey present in the file, absent on the wire.
        let raw = fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(raw.contains("encryptedKey"));
        assert!(raw.contains("c2stdGVzdA=="), "injectable encrypt result stored");

        let reloaded = list(&state).unwrap();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0]["apiKey"], serde_json::json!("sk-test"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn add_without_key_stores_empty_and_reads_absent() {
        let (state, dir) = state_with_config("add-nokey", "{}");
        let wire = add(
            &state,
            serde_json::json!({ "name": "LM", "apiStyle": "openai", "baseUrl": "http://x" }),
            &plain_encrypt,
        )
        .unwrap();
        assert!(wire.as_object().unwrap().get("apiKey").is_none());
        assert_eq!(wire["models"], serde_json::json!([]));
        let raw = fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(raw.contains("\"encryptedKey\": \"\""), "TS stored the empty string");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn add_rejects_unknown_api_style() {
        let (state, dir) = state_with_config("add-bad-style", "{}");
        let err = add(
            &state,
            serde_json::json!({ "name": "x", "apiStyle": "grpc", "baseUrl": "u" }),
            &plain_encrypt,
        )
        .unwrap_err();
        assert_eq!(err.code.as_deref(), Some("PROVIDER_INVALID"));
        assert!(list(&state).unwrap().is_empty(), "failed add mutates nothing");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_patches_fields_reencrypts_key_and_rewrites_models() {
        let (state, dir) = state_with_config(
            "update",
            r#"{"providers":[{
                "id": "p_1", "name": "old", "apiStyle": "anthropic",
                "baseUrl": "https://a", "encryptedKey": "", "enabled": true,
                "models": []
            }]}"#,
        );
        let updated = update(
            &state,
            "p_1".into(),
            serde_json::json!({
                "name": "new",
                "apiStyle": "openai",
                "baseUrl": "https://b/v1",
                "enabled": false,
                "limits": { "weeklyTokens": 5000000 },
                "apiKey": "sk-fresh",
                "models": [
                    { "id": "m_keep", "alias": "gpt", "modelId": "gpt-5",
                      "contextWindow": 400000, "providerId": "wrong", "catalogId": "openai/gpt-5" }
                ]
            }),
            &plain_encrypt,
        )
        .unwrap()
        .expect("provider found");
        assert_eq!(updated["name"], serde_json::json!("new"));
        assert_eq!(updated["apiStyle"], serde_json::json!("openai"));
        assert_eq!(updated["apiKey"], serde_json::json!("sk-fresh"));
        assert_eq!(updated["enabled"], serde_json::json!(false));
        assert_eq!(updated["limits"], serde_json::json!({ "weeklyTokens": 5000000 }));
        assert_eq!(updated["models"][0]["providerId"], serde_json::json!("p_1"), "models re-homed");
        assert_eq!(updated["models"][0]["catalogId"], serde_json::json!("openai/gpt-5"), "extras preserved");

        // Absent keys in a later patch keep the stored values.
        let again = update(&state, "p_1".into(), serde_json::json!({ "name": "again" }), &plain_encrypt)
            .unwrap()
            .unwrap();
        assert_eq!(again["apiKey"], serde_json::json!("sk-fresh"), "key untouched");
        assert_eq!(again["baseUrl"], serde_json::json!("https://b/v1"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_missing_provider_returns_null_and_delete_reports() {
        let (state, dir) = state_with_config(
            "update-missing",
            r#"{"providers":[{ "id": "p_1", "name": "n", "apiStyle": "openai", "baseUrl": "u", "enabled": true, "models": [] }]}"#,
        );
        assert!(
            update(&state, "p_x".into(), serde_json::json!({ "name": "z" }), &plain_encrypt)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            delete(&state, "p_1".into()).unwrap(),
            DeleteResult { ok: true }
        );
        assert_eq!(delete(&state, "p_1".into()).unwrap(), DeleteResult { ok: false });
        assert!(list(&state).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn random_tokens_have_the_ts_shape() {
        let token = random_token(8);
        assert_eq!(token.len(), 8);
        assert!(token.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        assert_ne!(token, random_token(8));
    }

    // ── usage windows ───────────────────────────────────────────────

    #[test]
    fn usage_windows_sum_seeded_rollups() {
        let (state, dir) = state_with_config("windows", "{}");
        let now = 2_000_000_000_000i64;
        let delta = UsageDelta {
            input_tokens: 4_000,
            output_tokens: 1_000,
            cache_read: 0,
            cache_write: 0,
            cost_usd: 0.0,
        };
        tide_store::usage::record_provider_usage(state.data_dir(), "p_1", &delta, now - 60_000)
            .unwrap();
        tide_store::usage::record_provider_usage(state.data_dir(), "p_1", &delta, now - 6 * 60 * 60 * 1000)
            .unwrap();
        let usage = windows(&state, "p_1".into(), now);
        assert_eq!(usage.five_hour.tokens, 5_000);
        assert_eq!(usage.five_hour.newest_at, now - 60_000);
        assert_eq!(usage.weekly.tokens, 10_000);
        assert_eq!(usage.weekly.oldest_at, now - 6 * 60 * 60 * 1000);
        let empty = windows(&state, "p_none".into(), now);
        assert_eq!(empty.weekly.tokens, 0);
        assert_eq!(empty.weekly.oldest_at, 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    // ── probes against a mock HTTP server ───────────────────────────

    /// Request log + canned responder: records each request line + auth
    /// headers, answers every request with the canned response.
    struct MockServer {
        base: String,
        requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl MockServer {
        fn new(response: &'static str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let log = std::sync::Arc::clone(&requests);
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let mut stream = stream;
                    let mut buf = [0u8; 8192];
                    let read = stream.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..read]).into_owned();
                    if let Some(line) = head.lines().next() {
                        let auth_headers = head
                            .to_lowercase()
                            .lines()
                            .filter(|l| {
                                l.starts_with("authorization:")
                                    || l.starts_with("x-api-key:")
                                    || l.starts_with("anthropic-version:")
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        log.lock().unwrap().push(format!("{line}\n{auth_headers}"));
                    }
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                }
            });
            MockServer {
                base: format!("http://{addr}"),
                requests,
            }
        }

        fn base(&self) -> String {
            self.base.clone()
        }

        fn logged(&self) -> String {
            self.requests.lock().unwrap().join("\n").to_lowercase()
        }
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

    fn seed_or_catalog(dir: &Path) {
        fs::write(
            dir.join("openrouter-models.json"),
            serde_json::json!({
                "data": [{
                    "id": "glm/glm-4.6",
                    "context_length": 200000,
                    "pricing": { "prompt": "0.0000006" }
                }],
                "fetchedAt": "2099-01-01T00:00:00.000Z",
            })
            .to_string(),
        )
        .unwrap();
    }

    fn probe_input(base: String, style: &str) -> ProbeInput {
        ProbeInput {
            api_style: style.into(),
            base_url: base,
            api_key: "sk-probe".into(),
        }
    }

    fn error_of(result: &Value) -> String {
        result["error"].as_str().unwrap_or_default().to_owned()
    }

    #[tokio::test]
    async fn probe_openai_hits_models_with_bearer_and_enriches() {
        let _guard = crate::commands::or_catalog::test_state_guard();
        crate::commands::or_catalog::reset_for_tests();
        let (state, dir) = state_with_config("probe", "{}");
        seed_or_catalog(&dir);
        let server = MockServer::new(json_response(
            r#"{"data":[{"id":"glm-4.6"}]}"#,
        ));
        let result = probe_models(state.data_dir(), probe_input(server.base(), "openai")).await;
        assert_eq!(result["ok"], serde_json::json!(true));
        let model = &result["models"][0];
        assert_eq!(model["id"], serde_json::json!("glm-4.6"), "bare id preserved");
        assert_eq!(model["context_length"], serde_json::json!(200000), "enriched from OR catalog");
        let logged = server.logged();
        assert!(logged.contains("/models"));
        assert!(logged.contains("authorization: bearer sk-probe"));
        fs::remove_dir_all(&dir).unwrap();
        crate::commands::or_catalog::reset_for_tests();
    }

    #[tokio::test]
    async fn probe_anthropic_appends_v1_and_sends_key_headers() {
        let _guard = crate::commands::or_catalog::test_state_guard();
        crate::commands::or_catalog::reset_for_tests();
        let (state, dir) = state_with_config("probe-anthropic", "{}");
        seed_or_catalog(&dir);
        let server = MockServer::new(json_response(r#"{"models":[{"id":"claude-x"}]}"#));
        let result = probe_models(
            state.data_dir(),
            probe_input(format!("{}/api/anthropic", server.base()), "anthropic"),
        )
        .await;
        assert_eq!(result["ok"], serde_json::json!(true));
        assert_eq!(result["models"][0]["id"], serde_json::json!("claude-x"), "`models` key accepted");
        let logged = server.logged();
        assert!(logged.contains("/api/anthropic/v1/models"), "v1 appended to a versionless base");
        assert!(logged.contains("x-api-key: sk-probe"));
        assert!(logged.contains("anthropic-version: 2023-06-01"));
        fs::remove_dir_all(&dir).unwrap();
        crate::commands::or_catalog::reset_for_tests();
    }

    #[tokio::test]
    async fn probe_reports_http_errors_and_empty_inputs() {
        let _guard = crate::commands::or_catalog::test_state_guard();
        crate::commands::or_catalog::reset_for_tests();
        let (state, dir) = state_with_config("probe-errors", "{}");
        seed_or_catalog(&dir);
        let empty_base = probe_models(
            state.data_dir(),
            ProbeInput {
                api_style: "openai".into(),
                base_url: "  ".into(),
                api_key: "k".into(),
            },
        )
        .await;
        assert_eq!(error_of(&empty_base), "Base URL is empty.");

        let empty_key = probe_models(
            state.data_dir(),
            ProbeInput {
                api_style: "openai".into(),
                base_url: "http://127.0.0.1:1".into(),
                api_key: " ".into(),
            },
        )
        .await;
        assert_eq!(
            error_of(&empty_key),
            "API key is empty — type one or save a stored key first."
        );

        let body = r#"{"error":"bad key"}"#;
        let len = body.len();
        let server = MockServer::new(Box::leak(
            format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {len}\r\n\r\n{body}"
            )
            .into_boxed_str(),
        ));
        let denied = probe_models(state.data_dir(), probe_input(server.base(), "openai")).await;
        let message = error_of(&denied);
        assert!(message.starts_with("HTTP 401"), "got: {message}");
        assert!(message.contains("bad key"));
        fs::remove_dir_all(&dir).unwrap();
        crate::commands::or_catalog::reset_for_tests();
    }

    #[tokio::test]
    async fn detect_prefers_openai_and_reports_failure() {
        let _guard = crate::commands::or_catalog::test_state_guard();
        crate::commands::or_catalog::reset_for_tests();
        let (state, dir) = state_with_config("detect", "{}");
        seed_or_catalog(&dir);
        let server = MockServer::new(json_response(r#"{"data":[{"id":"m"}]}"#));
        let detected = detect_protocol(state.data_dir(), server.base(), "sk-d".into()).await;
        assert_eq!(detected["apiStyle"], serde_json::json!("openai"), "openai candidate wins ties");

        let missing = detect_protocol(
            state.data_dir(),
            "http://127.0.0.1:1".into(),
            "sk-d".into(),
        )
        .await;
        assert!(missing.get("error").is_some());

        let blank = detect_protocol(state.data_dir(), " ".into(), " ".into()).await;
        assert_eq!(
            blank["error"].as_str().unwrap(),
            "Base URL and API key are required."
        );
        fs::remove_dir_all(&dir).unwrap();
        crate::commands::or_catalog::reset_for_tests();
    }

    #[tokio::test]
    async fn test_connection_posts_a_minimal_completion() {
        let server = MockServer::new(json_response(r#"{"choices":[{"message":{"content":"Hi"}}]}"#));
        let ok = test_connection(TestInput {
            api_style: "openai".into(),
            base_url: server.base(),
            api_key: "sk-t".into(),
            model_id: "gpt-5".into(),
        })
        .await;
        assert_eq!(ok, serde_json::json!({ "ok": true }));
        let logged = server.logged();
        assert!(logged.contains("post /chat/completions"));
        assert!(logged.contains("authorization: bearer sk-t"));

        let anthropic = MockServer::new(json_response(r#"{"content":[{"type":"text","text":"Hi"}]}"#));
        let ok = test_connection(TestInput {
            api_style: "anthropic".into(),
            base_url: format!("{}/api/anthropic", anthropic.base()),
            api_key: "sk-t".into(),
            model_id: "claude-x".into(),
        })
        .await;
        assert_eq!(ok, serde_json::json!({ "ok": true }));
        assert!(anthropic.logged().contains("post /api/anthropic/v1/messages"));

        let empty_model = test_connection(TestInput {
            api_style: "openai".into(),
            base_url: server.base(),
            api_key: "sk-t".into(),
            model_id: " ".into(),
        })
        .await;
        assert_eq!(error_of(&empty_model), "Model ID is empty.");
    }

    // The usage-report dispatcher's config side: no stored key → null,
    // before any network is touched.
    #[tokio::test]
    async fn usage_report_reads_null_without_a_stored_key() {
        let (state, dir) = state_with_config(
            "report-dispatch",
            r#"{"providers":[
                { "id": "p_or", "name": "or", "apiStyle": "openai",
                  "baseUrl": "https://openrouter.ai/api/v1", "enabled": true, "models": [] },
                { "id": "p_plain", "name": "local", "apiStyle": "openai",
                  "baseUrl": "http://localhost:1234", "enabled": true, "models": [] }
            ]}"#,
        );
        for id in ["p_or", "p_plain"] {
            let fetched = state
                .read_config(|cfg| {
                    let provider = cfg.providers.iter().find(|p| p.id == id)?;
                    let key = tide_store::secrets::get_api_key(cfg, &provider.id)
                        .ok()
                        .flatten()
                        .filter(|k| !k.is_empty());
                    Some((provider.base_url.clone(), key))
                })
                .unwrap();
            let (base_url, api_key) = fetched.expect("provider present");
            assert!(
                fetch_provider_report(&base_url, api_key.as_deref()).await.is_none(),
                "{id}: no key → null report"
            );
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
