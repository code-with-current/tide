//! Wire shapes for the embedded Tide provider's management surface. These
//! mirror tide's own provider screens: a provider is credentials plus a model
//! list, the key never crosses the wire (only whether one is stored), and
//! models carry exactly the traits tide's picker renders.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TideProviderWire {
    pub id: String,
    pub name: String,
    /// `"openai"` or `"anthropic"` — tide's two wire protocols.
    pub api_style: String,
    pub base_url: String,
    pub enabled: bool,
    pub has_key: bool,
    pub models: Vec<TideModelWire>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TideModelWire {
    pub model_id: String,
    /// Display name; defaults to the model id when the provider lists bare
    /// ids, exactly like tide's `alias = modelId` fallback.
    pub alias: String,
    pub context_window: u64,
    pub reasoning: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_efforts: Vec<String>,
    /// Where the row's metadata came from: "live" — the provider's own
    /// /models payload; "enriched" — the models.dev catalog; "none" — only
    /// an id is known. Drives the wizard's From-provider / Available-models
    /// sectioning, exactly like tide's matchState.
    #[serde(default = "default_match_state")]
    pub match_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_label: Option<String>,
    #[serde(default)]
    pub vision: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
}

fn default_match_state() -> String {
    "none".to_owned()
}
