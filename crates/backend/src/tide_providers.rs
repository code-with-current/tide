//! Management surface for the embedded Tide provider's credentials and model
//! catalog — the backend half of tide's add-provider wizard. All writes go
//! through tide's own config + keychain envelopes so the tide app and this
//! app share one source of truth in `~/.tide/config.json`.

use std::time::Duration;

use anyhow::{Context as _, anyhow, bail, ensure};
use protocol::tide::{TideModelWire, TideProviderWire};
use serde_json::Value;
use uuid::Uuid;

const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;

fn config_path() -> std::path::PathBuf {
    store::paths::config_path()
}

/// One locked load → edit → save cycle on tide's config. The wizard's
/// mutating commands and the background enrichment pass share
/// [`crate::TIDE_CONFIG_LOCK`] with the other config writers so neither can
/// drop the other's write.
fn edit_config(
    edit: impl FnOnce(&mut store::config::Config) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let _guard = crate::TIDE_CONFIG_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut config = store::config::load(&config_path())
        .map_err(|error| anyhow!("could not load the tide config: {error}"))?;
    edit(&mut config)?;
    store::config::save(&config_path(), &config)
        .map_err(|error| anyhow!("could not save the tide config: {error}"))
}

fn load_config() -> anyhow::Result<store::config::Config> {
    store::config::load(&config_path())
        .map_err(|error| anyhow!("could not load the tide config: {error}"))
}

fn provider_wire(provider: &store::config::StoredProvider) -> TideProviderWire {
    TideProviderWire {
        id: provider.id.clone(),
        name: provider.name.clone(),
        api_style: provider.api_style.clone(),
        base_url: provider.base_url.clone(),
        enabled: provider.enabled,
        has_key: provider
            .encrypted_key
            .as_deref()
            .is_some_and(|key| !key.is_empty()),
        models: provider
            .models
            .iter()
            .map(|model| TideModelWire {
                model_id: model.model_id.clone(),
                alias: model.alias.clone(),
                context_window: model.context_window,
                reasoning: model.reasoning.unwrap_or(false),
                supported_efforts: model.supported_efforts.clone().unwrap_or_default(),
                // The wizard stored match metadata as tide-style extras.
                match_state: "none".to_owned(),
                price_label: model
                    .extra
                    .get("priceLabel")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned),
                vision: model
                    .extra
                    .get("vision")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
                catalog_id: model.catalog_id.clone(),
            })
            .collect(),
    }
}

pub fn providers() -> anyhow::Result<Vec<TideProviderWire>> {
    Ok(load_config()?.providers.iter().map(provider_wire).collect())
}

fn validate_api_style(style: &str) -> anyhow::Result<()> {
    match style {
        "openai" | "anthropic" => Ok(()),
        other => bail!("unknown api style {other:?}; expected \"openai\" or \"anthropic\""),
    }
}

fn fresh_id(prefix: &str) -> String {
    format!("{prefix}{}", &Uuid::new_v4().simple().to_string()[..8])
}

fn stored_model(wire: TideModelWire, provider_id: &str) -> store::config::StoredModel {
    store::config::StoredModel {
        id: fresh_id("m_"),
        alias: if wire.alias.trim().is_empty() {
            wire.model_id.clone()
        } else {
            wire.alias
        },
        model_id: wire.model_id,
        context_window: if wire.context_window == 0 {
            DEFAULT_CONTEXT_WINDOW
        } else {
            wire.context_window
        },
        provider_id: provider_id.to_owned(),
        catalog_id: wire.catalog_id.clone(),
        role: None,
        reasoning: Some(wire.reasoning),
        reasoning_mandatory: None,
        supported_efforts: if wire.supported_efforts.is_empty() {
            None
        } else {
            Some(wire.supported_efforts)
        },
        extra: {
            let mut extra = serde_json::Map::new();
            if let Some(price) = &wire.price_label {
                extra.insert(
                    "priceLabel".into(),
                    serde_json::Value::String(price.clone()),
                );
            }
            if wire.vision {
                extra.insert("vision".into(), serde_json::Value::Bool(true));
            }
            extra
        },
    }
}

pub fn add_provider(
    name: String,
    api_style: String,
    base_url: String,
    api_key: Option<String>,
    models: Vec<TideModelWire>,
) -> anyhow::Result<Vec<TideProviderWire>> {
    validate_api_style(&api_style)?;
    if name.trim().is_empty() {
        bail!("provider name cannot be empty");
    }
    if base_url.trim().is_empty() {
        bail!("base URL cannot be empty");
    }
    let encrypted_key = match api_key.as_deref() {
        Some(key) if !key.is_empty() => Some(
            store::secrets::encrypt_stored(key)
                .map_err(|error| anyhow!("could not store the API key: {error}"))?,
        ),
        _ => None,
    };
    edit_config(|config| {
        let id = fresh_id("p_");
        let provider = store::config::StoredProvider {
            id: id.clone(),
            name: name.trim().to_owned(),
            api_style,
            base_url: base_url.trim().trim_end_matches('/').to_owned(),
            encrypted_key,
            enabled: true,
            models: models
                .into_iter()
                .map(|model| stored_model(model, &id))
                .collect(),
            extra: Default::default(),
        };
        config.providers.push(provider);
        Ok(())
    })?;
    providers()
}

pub fn update_provider(
    provider_id: String,
    name: Option<String>,
    api_style: Option<String>,
    base_url: Option<String>,
    enabled: Option<bool>,
    api_key: Option<String>,
    models: Option<Vec<TideModelWire>>,
) -> anyhow::Result<Vec<TideProviderWire>> {
    if let Some(api_style) = api_style.as_deref() {
        validate_api_style(api_style)?;
    }
    if let Some(name) = name.as_deref() {
        ensure!(!name.trim().is_empty(), "provider name cannot be empty");
    }
    if let Some(base_url) = base_url.as_deref() {
        ensure!(!base_url.trim().is_empty(), "base URL cannot be empty");
    }
    edit_config(move |config| {
        let provider = config
            .providers
            .iter_mut()
            .find(|provider| provider.id == provider_id)
            .with_context(|| format!("tide provider {provider_id} is not configured"))?;
        if let Some(name) = name {
            provider.name = name.trim().to_owned();
        }
        if let Some(api_style) = api_style {
            provider.api_style = api_style;
        }
        if let Some(base_url) = base_url {
            provider.base_url = base_url.trim().trim_end_matches('/').to_owned();
        }
        if let Some(enabled) = enabled {
            provider.enabled = enabled;
        }
        if let Some(key) = api_key {
            provider.encrypted_key = if key.is_empty() {
                None
            } else {
                Some(
                    store::secrets::encrypt_stored(&key)
                        .map_err(|error| anyhow!("could not store the API key: {error}"))?,
                )
            };
        }
        if let Some(models) = models {
            provider.models = models
                .into_iter()
                .map(|model| stored_model(model, &provider.id))
                .collect();
        }
        Ok(())
    })?;
    providers()
}

pub fn delete_provider(provider_id: String) -> anyhow::Result<Vec<TideProviderWire>> {
    edit_config(|config| {
        config
            .providers
            .retain(|provider| provider.id != provider_id);
        Ok(())
    })?;
    providers()
}

/// Lazily boot the enrichment catalogs: the bundled baseline loads
/// synchronously, and any stale refresh continues on a background thread so
/// the first probe never stalls. Degradation is graceful — an empty catalog
/// just means fewer enriched rows, exactly like tide's splash-screen refresh.
fn ensure_catalogs() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = store::paths::data_dir();
        crate::model_metadata::load(&dir);
        crate::or_catalog::load_cached(&dir);
        std::thread::Builder::new()
            .name("tide-tide-catalog-refresh".into())
            .spawn(move || {
                let _ = crate::model_metadata::refresh_if_stale(&dir);
                crate::or_catalog::bootstrap(&dir);
                // Fresh catalogs landed: fill in rows that were saved while
                // only the stale baseline was loaded (a model newer than the
                // bundled snapshot probes as "none", then heals here).
                {
                    let _guard = crate::TIDE_CONFIG_LOCK
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    crate::model_metadata::enrich_existing_models();
                }
            })
            .ok();
    });
}

fn has_version_segment(clean_base: &str) -> bool {
    // The TS regex `/\/v\d+$/` — a trailing `v` + at least one digit.
    clean_base.rsplit('/').next().is_some_and(|last| {
        last.len() > 1 && last.starts_with('v') && last[1..].chars().all(|c| c.is_ascii_digit())
    })
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

fn models_url(api_style: &str, clean_base: &str) -> String {
    if api_style == "anthropic" && !has_version_segment(clean_base) {
        format!("{clean_base}/v1/models")
    } else {
        format!("{clean_base}/models")
    }
}

fn http_client() -> anyhow::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .context("could not build the provider probe client")
}

/// `data ?? models` from a parsed /models response.
fn models_array(json: &Value) -> Option<&Vec<Value>> {
    json.get("data")
        .and_then(Value::as_array)
        .or_else(|| json.get("models").and_then(Value::as_array))
}

/// An error message embedded in a 2xx body. Some gateways report auth and
/// route failures as JSON with HTTP 200 (z.ai: `{"code":401,"msg":"token
/// expired or incorrect","success":false}`), so the status line alone cannot
/// distinguish a broken key from a working catalog.
fn embedded_error_message(json: &Value) -> Option<String> {
    let text = json
        .get("msg")
        .or_else(|| json.get("message"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            json.get("error").and_then(|error| {
                error.as_str().map(str::to_owned).or_else(|| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
            })
        })?;
    (!text.trim().is_empty()).then_some(text)
}

/// The TS ``HTTP <status>: <body-up-to-200-chars>`` error suffix.
fn body_suffix(body: &str) -> String {
    if body.is_empty() {
        String::new()
    } else {
        format!(": {}", body.chars().take(200).collect::<String>())
    }
}

fn fetch_models_raw(
    client: &reqwest::blocking::Client,
    api_style: &str,
    base_url: &str,
    api_key: &str,
) -> anyhow::Result<Vec<Value>> {
    let base = base_url.trim().trim_end_matches('/');
    let url = models_url(api_style, base);
    let mut request = client.get(&url);
    request = match api_style {
        "anthropic" => request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => request.header("authorization", format!("Bearer {api_key}")),
    };
    let mut response = request
        .send()
        .with_context(|| format!("could not reach {url}"))?;
    if !response.status().is_success() && api_style != "anthropic" && !has_version_segment(base) {
        // An unversioned OpenAI-style base that 404s at /models usually
        // serves the list one level down at /v1/models.
        let retry = client
            .get(format!("{base}/v1/models"))
            .header("authorization", format!("Bearer {api_key}"))
            .send()
            .with_context(|| format!("could not reach {base}/v1/models"))?;
        response = retry;
    }
    let status = response.status();
    let body = response
        .text()
        .with_context(|| format!("could not read the {url} response body"))?;
    if !status.is_success() {
        bail!("HTTP {status}{}", body_suffix(&body));
    }
    let json: Value = serde_json::from_str(&body).with_context(|| {
        format!("the model list endpoint answered {status} with a non-JSON body")
    })?;
    match models_array(&json) {
        Some(list) => Ok(list.clone()),
        None => match embedded_error_message(&json) {
            // Surface the provider's own failure text (z.ai's "token expired
            // or incorrect", OpenAI's error.message) instead of an empty list.
            Some(message) => bail!("{message}"),
            None => bail!("the model list response contained no models"),
        },
    }
}

/// "$X / $Y per Mtok", ported from tide's formatPriceRate: whole-dollar
/// Mtok rates drop the decimals, everything else keeps two.
fn format_price_rate(input_per_token: f64, output_per_token: f64) -> String {
    let fmt = |per_token: f64| {
        let per_mtok = per_token * 1_000_000.0;
        if per_mtok >= 1.0 && (per_mtok - per_mtok.trunc()).abs() < f64::EPSILON {
            format!("${per_mtok:.0}")
        } else {
            format!("${per_mtok:.2}")
        }
    };
    format!(
        "{} / {} per Mtok",
        fmt(input_per_token),
        fmt(output_per_token)
    )
}

/// Fetch the live model list and enrich it, exactly like tide's
/// `fetchAndEnrichModels`: rich entries from the provider itself are "live",
/// bare ids resolve against models.dev into "enriched", and the rest stay
/// "none".
pub fn probe_models(
    api_style: String,
    base_url: String,
    api_key: String,
) -> anyhow::Result<Vec<TideModelWire>> {
    validate_api_style(&api_style)?;
    ensure_catalogs();
    let client = http_client()?;
    let raw = fetch_models_raw(&client, &api_style, &base_url, &api_key)?;
    let metas =
        crate::or_catalog::enrich_bare_models(crate::or_catalog::normalize_probe_list(&raw));
    let mut models = Vec::new();
    for meta in metas {
        if meta.id.is_empty() {
            continue;
        }
        let rich = meta.context_length.is_some()
            || meta.pricing.is_some()
            || meta.reasoning.is_some()
            || meta.max_completion_tokens.is_some()
            || meta.input_modalities.is_some();
        if rich {
            let reasoning_default = meta
                .reasoning
                .as_ref()
                .and_then(|reasoning| reasoning.default_enabled.or(reasoning.mandatory))
                .unwrap_or(false);
            let pricing = meta.pricing.as_ref().and_then(|pricing| {
                let input = pricing
                    .prompt
                    .as_deref()
                    .and_then(|v| v.parse::<f64>().ok())?;
                let output = pricing
                    .completion
                    .as_deref()
                    .and_then(|v| v.parse::<f64>().ok())?;
                Some((input, output))
            });
            models.push(TideModelWire {
                model_id: meta.id.clone(),
                alias: meta.name.clone().unwrap_or_else(|| meta.id.clone()),
                context_window: meta.context_length.unwrap_or(DEFAULT_CONTEXT_WINDOW),
                reasoning: reasoning_default,
                supported_efforts: meta
                    .reasoning
                    .as_ref()
                    .and_then(|reasoning| reasoning.supported_efforts.clone())
                    .unwrap_or_default(),
                match_state: "live".to_owned(),
                price_label: pricing.map(|(input, output)| format_price_rate(input, output)),
                vision: meta
                    .input_modalities
                    .as_ref()
                    .is_some_and(|modes| modes.iter().any(|mode| mode == "image")),
                catalog_id: Some(meta.id.clone()),
            });
            continue;
        }
        let resolved = crate::model_metadata::resolve_model_meta(None, &meta.id, 0);
        if let Some(catalog_id) = resolved.resolved_catalog_id.clone() {
            models.push(TideModelWire {
                model_id: meta.id.clone(),
                alias: meta.name.clone().unwrap_or_else(|| meta.id.clone()),
                context_window: resolved.context_window,
                reasoning: resolved.supports_reasoning,
                supported_efforts: Vec::new(),
                match_state: "enriched".to_owned(),
                price_label: resolved.pricing.map(|pricing| {
                    format_price_rate(pricing.input_per_token, pricing.output_per_token)
                }),
                vision: resolved.supports_vision,
                catalog_id: Some(catalog_id),
            });
        } else {
            let lowered = meta.id.to_ascii_lowercase();
            let reasoning = ["reason", "thinking", "-r1", "o1", "o3", "o4", "gpt-5"]
                .iter()
                .any(|needle| lowered.contains(needle));
            models.push(TideModelWire {
                model_id: meta.id.clone(),
                alias: meta.name.clone().unwrap_or_else(|| meta.id.clone()),
                context_window: DEFAULT_CONTEXT_WINDOW,
                reasoning,
                supported_efforts: Vec::new(),
                match_state: "none".to_owned(),
                price_label: None,
                vision: false,
                catalog_id: None,
            });
        }
    }
    models.sort_by(|a, b| a.model_id.cmp(&b.model_id));
    Ok(models)
}

fn probe_one(
    client: &reqwest::blocking::Client,
    api_style: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let list = fetch_models_raw(client, api_style, base_url, api_key)
        .map_err(|error| error.to_string())?;
    let ids: Vec<String> = list
        .iter()
        .filter_map(|entry| entry.get("id").and_then(|id| id.as_str()))
        .map(str::to_owned)
        .collect();
    if ids.is_empty() {
        // A body without model entries is a failure, not a win: gateways
        // answer HTTP 200 with an error JSON for bad keys and wrong paths,
        // and an entry-less array would let this side steal the tie.
        return Err("no models in response".to_owned());
    }
    Ok(ids)
}

/// Race the two wire protocols against a base URL; OpenAI wins ties. Used
/// both as the wizard's Continue gate and its Auto-Detect Protocol button.
pub fn detect_protocol(base_url: String, api_key: String) -> (Option<String>, Option<String>) {
    if base_url.trim().is_empty() || api_key.trim().is_empty() {
        return (None, Some("Base URL and API key are required.".to_owned()));
    }
    let base = base_url.trim().trim_end_matches('/').to_owned();
    let openai = std::thread::spawn({
        let base = base.clone();
        let api_key = api_key.clone();
        move || -> Result<Vec<String>, String> {
            let client = http_client().map_err(|error| error.to_string())?;
            probe_one(&client, "openai", &base, &api_key)
        }
    });
    let anthropic = std::thread::spawn({
        let base = base.clone();
        let api_key = api_key.clone();
        move || -> Result<Vec<String>, String> {
            let client = http_client().map_err(|error| error.to_string())?;
            probe_one(&client, "anthropic", &base, &api_key)
        }
    });
    let openai = openai
        .join()
        .unwrap_or_else(|_| Err("probe panicked".into()));
    let anthropic = anthropic
        .join()
        .unwrap_or_else(|_| Err("probe panicked".into()));
    match (openai, anthropic) {
        (Ok(_), _) => ("openai".to_owned().into(), None),
        (Err(_), Ok(_)) => ("anthropic".to_owned().into(), None),
        (Err(_), Err(_)) => (
            None,
            Some(
                "Could not detect API protocol — neither OpenAI nor Anthropic \
                 endpoint responded with a valid models list. Check the base \
                 URL and API key."
                    .to_owned(),
            ),
        ),
    }
}

/// POST a minimal completion to prove the credentials work end to end —
/// tide's exact request: max_tokens 16, "Say hello in one word."
pub fn test_connection(
    api_style: String,
    base_url: String,
    api_key: String,
    model_id: String,
) -> (bool, Option<String>) {
    if base_url.trim().is_empty() {
        return (false, Some("Base URL is empty.".to_owned()));
    }
    if api_key.trim().is_empty() {
        return (false, Some("API key is empty.".to_owned()));
    }
    if model_id.trim().is_empty() {
        return (false, Some("Model ID is empty.".to_owned()));
    }
    let clean_base = base_url.trim().trim_end_matches('/');
    let url = if api_style == "openai" {
        format!("{clean_base}/chat/completions")
    } else if has_version_segment(clean_base) {
        format!("{clean_base}/messages")
    } else {
        format!("{clean_base}/v1/messages")
    };
    let headers = auth_headers(&api_style, &api_key);
    let Ok(client) = http_client() else {
        return (false, Some("could not build the test client".to_owned()));
    };
    let mut request = client.post(&url);
    for (name, value) in &headers {
        request = request.header(*name, value);
    }
    let body = serde_json::json!({
        "model": model_id,
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "Say hello in one word." }],
    });
    match request.json(&body).send() {
        Ok(response) if response.status().is_success() => (true, None),
        Ok(response) => (false, Some(format!("HTTP {}", response.status()))),
        Err(error) => (false, Some(error.to_string())),
    }
}

#[cfg(test)]
mod wire_shape_tests {
    use engine::{HistoryMessage, HistoryPart, HistoryRole};

    /// The driver's exact history shape after one tool step: assistant message
    /// carrying the tool call, then a user message carrying the result.
    #[test]
    fn tool_results_survive_rig_conversion() {
        let history = vec![
            HistoryMessage::user_text("deep analysis"),
            HistoryMessage {
                role: HistoryRole::Assistant,
                parts: vec![HistoryPart::ToolCall {
                    id: "call_abc123".into(),
                    tool_name: "list_dir".into(),
                    arguments: serde_json::json!({"path": ""}),
                }],
            },
            HistoryMessage {
                role: HistoryRole::User,
                parts: vec![HistoryPart::ToolResult {
                    call_id: "call_abc123".into(),
                    tool_name: "list_dir".into(),
                    output: "api-doc/\nbdd/\nclient/\ncmd/".into(),
                }],
            },
        ];
        for message in &history {
            let wire = serde_json::to_value(message.to_rig()).unwrap();
            println!("WIRE: {wire}");
        }
        let result_wire = serde_json::to_value(history[2].to_rig()).unwrap();
        let rendered = result_wire.to_string();
        assert!(
            rendered.contains("api-doc"),
            "tool output missing from wire: {rendered}"
        );
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Answers each request with the first canned response whose needles are
    /// ALL contained in the raw request text (path line + headers, matched
    /// case-insensitively) — a header needle is how the openai retry at
    /// /v1/models is told apart from the anthropic probe at the same path.
    /// Unmatched requests hang up.
    fn request_mock(responses: Vec<(&'static [&'static str], &'static str)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let raw = String::from_utf8_lossy(&buf).to_lowercase();
                let Some(response) = responses
                    .iter()
                    .find(|(needles, _)| needles.iter().all(|needle| raw.contains(needle)))
                    .map(|(_, response)| *response)
                else {
                    continue;
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}")
    }

    fn http_response(status_line: &'static str, body: &'static str) -> &'static str {
        let len = body.len();
        Box::leak(
            format!(
                "{status_line}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {len}\r\n\r\n{body}"
            )
            .into_boxed_str(),
        )
    }

    /// z.ai's anthropic endpoint answers every path — including wrong ones
    /// and bad keys — with HTTP 200 and an error JSON body.
    fn zai_error_body() -> &'static str {
        r#"{"code":401,"msg":"token expired or incorrect","success":false}"#
    }

    #[test]
    fn embedded_error_helpers_read_gateway_error_bodies() {
        let zai: Value = serde_json::from_str(zai_error_body()).unwrap();
        assert_eq!(
            embedded_error_message(&zai).as_deref(),
            Some("token expired or incorrect")
        );
        let openai_style: Value =
            serde_json::from_str(r#"{"error":{"message":"Incorrect API key provided"}}"#).unwrap();
        assert_eq!(
            embedded_error_message(&openai_style).as_deref(),
            Some("Incorrect API key provided")
        );
        let listing: Value =
            serde_json::from_str(r#"{"object":"list","data":[{"id":"m"}]}"#).unwrap();
        assert!(embedded_error_message(&listing).is_none());
        assert_eq!(models_array(&listing).map(Vec::len), Some(1));
        assert_eq!(body_suffix(""), "");
        assert_eq!(body_suffix("x").as_str(), ": x");
    }

    /// The exact regression that emptied the wizard's model step: a 200 with
    /// an error body must surface the provider's message, not an empty list.
    #[test]
    fn fetch_surfaces_embedded_errors_and_404_bodies() {
        let base = request_mock(vec![(
            &[],
            http_response("HTTP/1.1 200 OK", zai_error_body()),
        )]);
        let client = http_client().unwrap();
        let error = fetch_models_raw(&client, "anthropic", &base, "bad-key").unwrap_err();
        assert!(
            error.to_string().contains("token expired or incorrect"),
            "embedded message lost: {error:#}"
        );
    }

    /// An unversioned OpenAI-style base that 404s at /models must retry at
    /// /v1/models — the old code retried the very URL that had just failed.
    #[test]
    fn openai_fetch_retries_the_versioned_path() {
        let base = request_mock(vec![
            (
                &["/v1/models"],
                http_response("HTTP/1.1 200 OK", r#"{"data":[{"id":"gpt-test"}]}"#),
            ),
            (
                &["/models"],
                http_response("HTTP/1.1 404 Not Found", r#"{"error":"nope"}"#),
            ),
        ]);
        let client = http_client().unwrap();
        let list = fetch_models_raw(&client, "openai", &base, "key").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "gpt-test");
    }

    /// A non-2xx final answer is an error carrying the status, never an
    /// empty success.
    #[test]
    fn fetch_reports_http_errors_with_status() {
        let base = request_mock(vec![(
            &[],
            http_response("HTTP/1.1 401 Unauthorized", r#"{"error":"bad key"}"#),
        )]);
        let client = http_client().unwrap();
        // Anthropic-style URL with a version segment hits {base}/models once.
        let error =
            fetch_models_raw(&client, "anthropic", &format!("{base}/v1"), "key").unwrap_err();
        assert!(
            error.to_string().contains("401"),
            "status missing from: {error:#}"
        );
    }

    /// Both protocols answering 200-with-error (z.ai with a bad key) must
    /// fail detection with the actionable message, not flip to openai.
    #[test]
    fn detect_fails_when_neither_protocol_lists_models() {
        let base = request_mock(vec![(
            &[],
            http_response("HTTP/1.1 200 OK", zai_error_body()),
        )]);
        let (style, error) = detect_protocol(base, "bad-key".into());
        assert_eq!(style, None);
        let error = error.expect("both-fail must produce an error");
        assert!(
            error.contains("Could not detect API protocol"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn detect_prefers_openai_on_ties_and_anthropic_when_openai_fails() {
        // OpenAI serves a list at /models; the anthropic path errors.
        let openai_wins = request_mock(vec![
            (
                &["/v1/models"],
                http_response("HTTP/1.1 200 OK", zai_error_body()),
            ),
            (
                &["/models"],
                http_response("HTTP/1.1 200 OK", r#"{"data":[{"id":"gpt-test"}]}"#),
            ),
        ]);
        let (style, error) = detect_protocol(openai_wins, "key".into());
        assert_eq!(style.as_deref(), Some("openai"));
        assert!(error.is_none());

        // /models answers 404-with-JSON and even the openai retry at
        // /v1/models gets an error body; only the anthropic header is served
        // a list. The old code accepted the 404 body as an empty success and
        // let openai steal the tie.
        let anthropic_wins = request_mock(vec![
            (
                &["/v1/models", "x-api-key"],
                http_response("HTTP/1.1 200 OK", r#"{"data":[{"id":"claude-test"}]}"#),
            ),
            (
                &["/v1/models"],
                http_response("HTTP/1.1 200 OK", zai_error_body()),
            ),
            (
                &["/models"],
                http_response(
                    "HTTP/1.1 404 Not Found",
                    r#"{"code":500,"msg":"404 NOT_FOUND","success":false}"#,
                ),
            ),
        ]);
        let (style, error) = detect_protocol(anthropic_wins, "key".into());
        assert_eq!(style.as_deref(), Some("anthropic"));
        assert!(error.is_none());
    }
}
