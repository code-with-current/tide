//! Tide provider management — the in-app twin of tide's providers screen and
//! add-provider wizard. Presets mirror tide's `provider-presets.ts` verbatim;
//! credentials land in tide's config + keychain through the backend commands,
//! never in Tide's own state.

use client::tide::{TideModelWire, TideProviderWire};
use crossbeam_channel::{Receiver, Sender, unbounded};
use gpui::*;

use crate::input::TextInput;

pub(crate) struct TidePreset {
    pub id: &'static str,
    /// Brand tile tint ("#rrggbb"; white renders as a neutral tile).
    pub accent: &'static str,
    /// Brand mark asset ("logo-…" names register under icons/).
    pub logo: &'static str,
    pub name: &'static str,
    pub group: &'static str,
    pub api_style: &'static str,
    pub base_url: &'static str,
    pub requires_key: bool,
    pub key_placeholder: &'static str,
    pub recommended: &'static [&'static str],
    /// Canonical base URL when the provider serves the OTHER wire protocol at
    /// a different address (z.ai, OpenCode Zen).
    pub alt_url_openai: Option<&'static str>,
    pub alt_url_anthropic: Option<&'static str>,
    /// (style, needles): when the wizard runs on `style`, only models whose
    /// ids contain a needle are servable (OpenCode Zen's Anthropic endpoint).
    pub routing: Option<(&'static str, &'static [&'static str])>,
}

pub(crate) const TIDE_PRESETS: &[TidePreset] = &[
    TidePreset {
        id: "anthropic",
        accent: "#d97757",
        logo: "logo-anthropic",
        name: "Anthropic",
        group: "first_party",
        api_style: "anthropic",
        base_url: "https://api.anthropic.com",
        requires_key: true,
        key_placeholder: "sk-ant-…",
        recommended: &["claude-sonnet", "claude-opus"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "openai",
        accent: "#10a37f",
        logo: "logo-openai",
        name: "OpenAI",
        group: "first_party",
        api_style: "openai",
        base_url: "https://api.openai.com/v1",
        requires_key: true,
        key_placeholder: "sk-…",
        recommended: &["gpt-5", "gpt-4.1"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "google",
        accent: "#ffffff",
        logo: "logo-google",
        name: "Google Gemini",
        group: "first_party",
        api_style: "openai",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        requires_key: true,
        key_placeholder: "AIza…",
        recommended: &["gemini-2.5-pro", "gemini-2.5-flash"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "xai",
        accent: "#111111",
        logo: "logo-xai",
        name: "xAI Grok",
        group: "first_party",
        api_style: "openai",
        base_url: "https://api.x.ai/v1",
        requires_key: true,
        key_placeholder: "xai-…",
        recommended: &["grok-4"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "openrouter",
        accent: "#ffffff",
        logo: "logo-openrouter",
        name: "OpenRouter",
        group: "aggregator",
        api_style: "openai",
        base_url: "https://openrouter.ai/api/v1",
        requires_key: true,
        key_placeholder: "sk-or-v1-…",
        recommended: &["claude-sonnet", "gpt-5", "gemini-2.5-pro"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "zai",
        accent: "#ffffff",
        logo: "logo-zai",
        name: "z.ai",
        group: "aggregator",
        api_style: "anthropic",
        base_url: "https://api.z.ai/api/anthropic",
        requires_key: true,
        key_placeholder: "…",
        recommended: &["glm-5", "glm-4.6"],
        alt_url_openai: Some("https://api.z.ai/api/paas/v4"),
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "deepseek",
        accent: "#4d6bfe",
        logo: "logo-deepseek",
        name: "DeepSeek",
        group: "aggregator",
        api_style: "openai",
        base_url: "https://api.deepseek.com/v1",
        requires_key: true,
        key_placeholder: "sk-…",
        recommended: &["deepseek-chat", "deepseek-reasoner"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "opencode",
        accent: "#ffffff",
        logo: "logo-opencode",
        name: "OpenCode Zen",
        group: "aggregator",
        api_style: "openai",
        base_url: "https://opencode.ai/zen/v1",
        requires_key: true,
        key_placeholder: "…",
        recommended: &["claude-sonnet", "claude-opus", "claude-haiku", "qwen"],
        alt_url_openai: None,
        alt_url_anthropic: Some("https://opencode.ai/zen"),
        routing: Some(("anthropic", &["claude", "qwen"])),
    },
    TidePreset {
        id: "groq",
        accent: "#f55036",
        logo: "logo-groq",
        name: "Groq",
        group: "aggregator",
        api_style: "openai",
        base_url: "https://api.groq.com/openai/v1",
        requires_key: true,
        key_placeholder: "gsk_…",
        recommended: &["llama-3.3-70b", "qwen3-coder"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "mistral",
        accent: "#fa520f",
        logo: "logo-mistral",
        name: "Mistral",
        group: "aggregator",
        api_style: "openai",
        base_url: "https://api.mistral.ai/v1",
        requires_key: true,
        key_placeholder: "…",
        recommended: &["devstral", "mistral-large"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "together",
        accent: "#ffffff",
        logo: "logo-together",
        name: "Together",
        group: "aggregator",
        api_style: "openai",
        base_url: "https://api.together.xyz/v1",
        requires_key: true,
        key_placeholder: "…",
        recommended: &["coder"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "fireworks",
        accent: "#f3f3f3",
        logo: "logo-fireworks",
        name: "Fireworks",
        group: "aggregator",
        api_style: "openai",
        base_url: "https://api.fireworks.ai/inference/v1",
        requires_key: true,
        key_placeholder: "fw_…",
        recommended: &["deepseek-v3", "kimi-k2"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "ollama",
        accent: "#ffffff",
        logo: "logo-ollama",
        name: "Ollama",
        group: "local",
        api_style: "openai",
        base_url: "http://localhost:11434/v1",
        requires_key: false,
        key_placeholder: "",
        recommended: &["qwen3-coder", "devstral"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "lmstudio",
        accent: "#ffffff",
        logo: "logo-lmstudio",
        name: "LM Studio",
        group: "local",
        api_style: "openai",
        base_url: "http://localhost:1234/v1",
        requires_key: false,
        key_placeholder: "",
        recommended: &[],
        alt_url_openai: None,
        alt_url_anthropic: None,
        routing: None,
    },
    TidePreset {
        id: "zed",
        accent: "#0f0f0f",
        logo: "logo-zed",
        name: "Zed",
        group: "aggregator",
        api_style: "zed",
        base_url: "https://cloud.zed.dev",
        requires_key: false,
        key_placeholder: "",
        recommended: &["claude-sonnet-5", "claude-sonnet-4-6"],
        alt_url_openai: None,
        alt_url_anthropic: None,
        // Claude speaks Anthropic natively on the cloud; GPT models get
        // Responses API translation in the bridge. Everything else dims.
        routing: Some(("zed", &["claude", "gpt"])),
    },
];

/// Resolve a provider's brand mark by its base URL — alt URLs included, so a
/// provider added via its other-protocol endpoint keeps its brand — falling
/// back to the wire-protocol mark exactly like tide's ProviderLogo.
/// Short display label for a stored `api_style` value — pills read better
/// as proper nouns than the raw wire strings.
pub(crate) fn api_style_label(api_style: &str) -> String {
    match api_style {
        "openai" => "OpenAI".to_owned(),
        "anthropic" => "Anthropic".to_owned(),
        "zed" => "Zed".to_owned(),
        other => other.to_owned(),
    }
}

pub(crate) fn brand_for(base_url: &str, api_style: &str) -> (&'static str, &'static str) {
    if let Some(preset) = TIDE_PRESETS.iter().find(|preset| {
        preset.base_url == base_url
            || preset.alt_url_openai == Some(base_url)
            || preset.alt_url_anthropic == Some(base_url)
    }) {
        return (preset.logo, preset.accent);
    }
    if api_style == "anthropic" {
        ("logo-anthropic", "#d97757")
    } else {
        ("logo-openai", "#10a37f")
    }
}

pub(crate) fn preset_added(providers: &[TideProviderWire], preset: &TidePreset) -> bool {
    if preset.id == "zed" {
        return false; // org-scoped duplicates are legitimate
    }
    providers
        .iter()
        .any(|provider| provider.base_url == preset.base_url)
}

/// Results of backend tide commands, pumped through the shared event wake.
pub(crate) enum TideOpsEvent {
    Providers(Result<Vec<TideProviderWire>, String>),
    Models(Result<Vec<TideModelWire>, String>),
    Protocol(Result<String, String>),
    Connection(Result<(), String>),
    ZedSignIn(Result<client::tide::TideZedSignInResult, String>),
}

pub(crate) struct TideProviderPanel {
    pub providers: Vec<TideProviderWire>,
    pub error: Option<String>,
    pub loaded: bool,
    pub wizard: Option<TideWizard>,
    pub ops_tx: Sender<TideOpsEvent>,
    pub ops_rx: Receiver<TideOpsEvent>,
}

impl TideProviderPanel {
    pub fn new() -> Self {
        let (ops_tx, ops_rx) = unbounded();
        Self {
            providers: Vec::new(),
            error: None,
            loaded: false,
            wizard: None,
            ops_tx,
            ops_rx,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TideWizardStep {
    Choose,
    Connect,
    Models,
    Review,
}

/// Connect-step state for the zed preset: sign-in result + org choice,
/// or manual paste fields. The credential blob is assembled on demand.
pub(crate) struct WizardZedState {
    pub sign_in: Option<client::tide::TideZedSignInResult>,
    /// `None` before sign-in; after sign-in, defaults to the account's
    /// default_organization_id (rendered as the selected radio).
    pub organization_id: Option<String>,
    pub manual_user_id: Entity<TextInput>,
    pub manual_access_token: Entity<TextInput>,
    pub busy: bool,
}

impl WizardZedState {
    pub fn credential_blob(&self, cx: &App) -> Option<String> {
        if let Some(sign_in) = &self.sign_in {
            let blob = serde_json::json!({
                "userId": sign_in.user_id,
                "accessToken": sign_in.access_token,
                "organizationId": self.organization_id,
            });
            return serde_json::to_string(&blob).ok();
        }
        let user_id = self.manual_user_id.read(cx).content().trim().to_owned();
        let access_token = self
            .manual_access_token
            .read(cx)
            .content()
            .trim()
            .to_owned();
        if user_id.is_empty() || access_token.is_empty() {
            return None;
        }
        serde_json::to_string(&serde_json::json!({
            "userId": user_id,
            "accessToken": access_token,
        }))
        .ok()
    }
}

/// The wizard, mirroring tide's wizard-reducer: one step enum, preset-derived
/// prefill, and the connection test gating Connect → Models.
pub(crate) struct TideWizard {
    pub step: TideWizardStep,
    /// `Some` when the wizard edits an existing provider instead of adding.
    pub edit_provider_id: Option<String>,
    pub preset: Option<&'static TidePreset>,
    /// Connect-step state when the preset is `zed`.
    pub zed: Option<WizardZedState>,
    pub name: Entity<TextInput>,
    pub api_key: Entity<TextInput>,
    pub base_url: Entity<TextInput>,
    /// Choose-step provider search.
    pub search: Entity<TextInput>,
    /// Models-step filter.
    pub model_search: Entity<TextInput>,
    /// The detect race passed for the current field values.
    pub tested: bool,
    /// `"openai"` or `"anthropic"`.
    pub api_style: String,
    pub models: Vec<(TideModelWire, bool)>,
    /// Set while the Continue gate / Auto-Detect probe is in flight.
    pub testing: bool,
    /// Set while models load on entering the Models step.
    pub fetching: bool,
    pub saving: bool,
    pub error: Option<String>,
}

impl TideWizard {
    /// Zed Connect-step state (sign-in, org picker, manual fallback).
    /// `Some` only for the zed preset — also re-run on Choose-step tile
    /// clicks so the Connect step renders the sign-in flow.
    pub(crate) fn zed_state(
        preset: Option<&'static TidePreset>,
        window: &mut Window,
        cx: &mut Context<crate::app::Tide>,
    ) -> Option<WizardZedState> {
        preset
            .filter(|preset| preset.id == "zed")
            .map(|_| WizardZedState {
                sign_in: None,
                organization_id: None,
                manual_user_id: cx.new(|cx| {
                    TextInput::new(window, cx)
                        .clear_on_escape()
                        .placeholder("605409")
                }),
                manual_access_token: cx.new(|cx| TextInput::new(window, cx).clear_on_escape()),
                busy: false,
            })
    }

    pub fn new(
        preset: Option<&'static TidePreset>,
        window: &mut Window,
        cx: &mut Context<crate::app::Tide>,
    ) -> Self {
        let name = cx.new(|cx| {
            let mut input = TextInput::new(window, cx).clear_on_escape();
            if let Some(preset) = preset {
                input = input.placeholder(preset.name);
            }
            input
        });
        let key_placeholder = preset.map(|preset| preset.key_placeholder).unwrap_or("");
        let api_key = cx.new(|cx| {
            TextInput::new(window, cx)
                .clear_on_escape()
                .placeholder(key_placeholder)
        });
        let base_url = cx.new(|cx| {
            let mut input = TextInput::new(window, cx).clear_on_escape();
            if let Some(preset) = preset {
                input = input.placeholder(preset.base_url);
            }
            input
        });
        Self {
            step: TideWizardStep::Choose,
            edit_provider_id: None,
            preset,
            zed: Self::zed_state(preset, window, cx),
            name,
            api_key,
            base_url,
            api_style: preset
                .map(|preset| preset.api_style.to_owned())
                .unwrap_or_else(|| "openai".to_owned()),
            search: cx.new(|cx| {
                TextInput::new(window, cx)
                    .clear_on_escape()
                    .placeholder("Search providers…")
            }),
            model_search: cx.new(|cx| {
                TextInput::new(window, cx)
                    .clear_on_escape()
                    .placeholder("Search models…")
            }),
            models: Vec::new(),
            tested: false,
            testing: false,
            fetching: false,
            saving: false,
            error: None,
        }
    }

    /// Preset base for the currently chosen wire protocol, alternates
    /// included (z.ai, OpenCode Zen).
    pub fn preset_base(&self) -> Option<String> {
        let preset = self.preset?;
        Some(match self.api_style.as_str() {
            "anthropic" => preset.alt_url_anthropic.unwrap_or(preset.base_url),
            _ => preset.alt_url_openai.unwrap_or(preset.base_url),
        })
        .map(str::to_owned)
    }

    /// (style, needles) routing filter active for the current protocol.
    pub fn routing_filter(&self) -> Option<&'static [&'static str]> {
        self.preset
            .and_then(|preset| preset.routing)
            .and_then(|(style, needles)| (style == self.api_style).then_some(needles))
    }

    pub fn is_zed(&self) -> bool {
        self.zed.is_some()
    }

    pub fn zed_blob(&self, cx: &App) -> Option<String> {
        self.zed.as_ref()?.credential_blob(cx)
    }
}
