//! Provider construction — TS `resolveModel` (`provider-factory.ts`)
//! ported onto rig's clients.
//!
//! Anthropic-protocol: rig posts to `{base_url}/v1/messages` and strips any
//! `/v1` (or `/v1/messages`) suffix itself, which reproduces the TS
//! `normalizeAnthropicBaseURL` append-if-missing rule for every stored shape:
//! `https://proxy.example` and `https://proxy.example/v1` both land on
//! `https://proxy.example/v1/messages`. OpenAI-compatible: the base URL is
//! used as stored (trailing slashes trimmed) and rig appends
//! `/chat/completions`, matching `createOpenAICompatible`.
//!
//! The injected reqwest client carries [`crate::quirk::SSE_READ_TIMEOUT`] as
//! `read_timeout` — per response-body read, reset on every chunk: the SSE
//! chunk-idle watchdog, scoped to the response body.

use std::sync::LazyLock;
use std::time::Duration;

use rig_core::client::CompletionClient;

use crate::quirk::{is_native_anthropic_host, SSE_READ_TIMEOUT};
use crate::EngineError;

/// One process-wide HTTP client shared by every engine stream — root turns,
/// dispatched sub-agents, and resumed children alike. Connection pools
/// (TCP + TLS + HTTP/2 sessions) live on the client, so building a fresh one
/// per turn would put a fresh provider handshake in front of every turn's
/// first request; here the pool survives across turns and concurrent
/// sub-agents. The idle timeout keeps a connection warm across a typical
/// pause between turns (reqwest's 90 s default tears it down sooner).
static SHARED_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .read_timeout(SSE_READ_TIMEOUT)
        .pool_idle_timeout(Duration::from_secs(300))
        .build()
        .expect("the shared engine HTTP client builds")
});

/// TS `ApiStyle` — dispatches the wire protocol, never sniffed at runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderApiStyle {
    Anthropic,
    OpenAi,
}

const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const OPENAI_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// The provider-factory input — the wire-relevant slice of the stored
/// Provider config plus the resolved model id and decrypted API key.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModelConfig {
    pub api_style: ProviderApiStyle,
    /// Provider base URL as stored; empty → provider default.
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
}

/// A constructed provider model. An enum (not a trait object) because rig's
/// `CompletionModel` returns `impl Future`s — but both arms speak the exact
/// same request/response types, so [`crate::stream_step`] treats them
/// uniformly. `provider_base_url` is the LOGICAL config URL — quirk
/// decisions (thinking-host allowlist) read it even when transport was
/// rerouted (tests, future proxies). Clone: both rig model handles are cheap
/// clones (Arc'd HTTP client), and the orchestrator drives one owned model
/// per step.
#[derive(Clone)]
pub struct EngineModel {
    provider_base_url: String,
    model_id: String,
    inner: EngineModelInner,
}

#[derive(Clone)]
enum EngineModelInner {
    Anthropic(rig_core::providers::anthropic::completion::CompletionModel),
    OpenAiCompatible(rig_core::providers::openai::CompletionModel),
}

/// Borrowed view of the concrete rig model — both arms implement rig's
/// `CompletionModel` with identical request/response types.
pub(crate) enum EngineModelRef<'a> {
    Anthropic(&'a rig_core::providers::anthropic::completion::CompletionModel),
    OpenAiCompatible(&'a rig_core::providers::openai::CompletionModel),
}

impl EngineModel {
    /// Build from a stored provider config. The logical base URL drives
    /// both transport and quirk decisions (host allowlist).
    pub fn from_config(config: &EngineModelConfig) -> Result<Self, EngineError> {
        Self::from_config_with_transport(config, &config.base_url)
    }

    /// Test/proxy seam: quirk decisions (thinking-host allowlist) read
    /// `config.base_url` while HTTP goes to `transport_base_url` — the
    /// reroute the SSE fixture recorder used to exercise host-based strip
    /// logic against a local mock server.
    pub fn from_config_with_transport(
        config: &EngineModelConfig,
        transport_base_url: &str,
    ) -> Result<Self, EngineError> {
        let http = SHARED_HTTP.clone();
        match config.api_style {
            ProviderApiStyle::Anthropic => {
                let base = normalize_base(&config.base_url, ANTHROPIC_DEFAULT_BASE_URL);
                let transport = normalize_base(transport_base_url, base);
                let client = rig_core::providers::anthropic::Client::builder()
                    .api_key(config.api_key.clone())
                    .base_url(transport)
                    .http_client(http)
                    .build()
                    .map_err(|e| EngineError::Config(e.to_string()))?;
                let mut completion_model = client.completion_model(config.model_id.clone());
                // Anthropic's automatic prompt caching stamps a top-level
                // `cache_control` on every request; the API places the
                // breakpoint on the last cacheable block and advances it as
                // the conversation grows, so every step after the first
                // re-reads the stable tools + system + history prefix from
                // cache instead of re-prefilling it — the dominant
                // first-token cost once a session gets long, on root loops
                // and dispatched children alike. Same native-host gate the
                // quirk layer uses for its wire `cache_control`:
                // OpenRouter-style proxies reject the field with a 400.
                if is_native_anthropic_host(Some(base)) {
                    completion_model = completion_model.with_automatic_caching();
                }
                Ok(Self {
                    provider_base_url: base.to_owned(),
                    model_id: config.model_id.clone(),
                    inner: EngineModelInner::Anthropic(completion_model),
                })
            }
            ProviderApiStyle::OpenAi => {
                let base = normalize_base(&config.base_url, OPENAI_DEFAULT_BASE_URL);
                let transport = normalize_base(transport_base_url, base);
                let client = rig_core::providers::openai::CompletionsClient::builder()
                    .api_key(config.api_key.clone())
                    .base_url(transport)
                    .http_client(http)
                    .build()
                    .map_err(|e| EngineError::Config(e.to_string()))?;
                Ok(Self {
                    provider_base_url: base.to_owned(),
                    model_id: config.model_id.clone(),
                    inner: EngineModelInner::OpenAiCompatible(
                        client.completion_model(config.model_id.clone()),
                    ),
                })
            }
        }
    }

    pub fn api_style(&self) -> ProviderApiStyle {
        match &self.inner {
            EngineModelInner::Anthropic(_) => ProviderApiStyle::Anthropic,
            EngineModelInner::OpenAiCompatible(_) => ProviderApiStyle::OpenAi,
        }
    }

    pub(crate) fn inner_model(&self) -> EngineModelRef<'_> {
        match &self.inner {
            EngineModelInner::Anthropic(m) => EngineModelRef::Anthropic(m),
            EngineModelInner::OpenAiCompatible(m) => EngineModelRef::OpenAiCompatible(m),
        }
    }

    pub fn provider_base_url(&self) -> &str {
        &self.provider_base_url
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }
}

fn normalize_base<'a>(url: &'a str, default: &'a str) -> &'a str {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        default
    } else {
        trimmed
    }
}
