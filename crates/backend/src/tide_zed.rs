//! Zed cloud credential handling for the `zed` provider style. The
//! credential is a three-field JSON blob stored (encrypted) in the tide
//! provider config's `encrypted_key` column and passed to the engine
//! verbatim as `EngineModelConfig::api_key`.

use anyhow::{Context as _, bail};
use protocol::tide::TideModelWire;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const CLOUD_URL: &str = "https://cloud.zed.dev";

#[cfg(test)]
static TEST_CLOUD_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[allow(dead_code)] // used from task 4
fn cloud_url() -> String {
    #[cfg(test)]
    if let Some(url) = TEST_CLOUD_URL.lock().unwrap_or_else(|p| p.into_inner()).clone() {
        return url;
    }
    CLOUD_URL.to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZedCredential {
    pub user_id: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
}

impl ZedCredential {
    pub fn to_blob(&self) -> anyhow::Result<String> {
        ensure_creds(self)?;
        Ok(serde_json::to_string(self).context("could not serialize the zed credential")?)
    }

    pub fn from_blob(blob: &str) -> anyhow::Result<Self> {
        let cred: Self = serde_json::from_str(blob)
            .with_context(|| "the stored zed credential is not a valid blob".to_owned())?;
        ensure_creds(&cred)?;
        Ok(cred)
    }
}

fn ensure_creds(cred: &ZedCredential) -> anyhow::Result<()> {
    if cred.user_id.trim().is_empty() || cred.access_token.trim().is_empty() {
        bail!("zed credential is missing the user id or access token");
    }
    if cred
        .organization_id
        .as_deref()
        .is_some_and(|org| org.trim().is_empty())
    {
        bail!("zed credential has an empty organization id");
    }
    Ok(())
}

#[allow(dead_code)] // used from task 4
pub(crate) fn http_client() -> anyhow::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .context("could not build the zed client")
}

#[allow(dead_code)] // used from task 4
pub(crate) fn parse_zed_models(json: &Value) -> anyhow::Result<Vec<TideModelWire>> {
    let list = json
        .get("models")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(|| anyhow::anyhow!("the zed model list response contained no models"))?;
    let mut models: Vec<TideModelWire> = list
        .iter()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.to_owned();
            Some(TideModelWire {
                alias: model
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_owned(),
                context_window: model
                    .get("max_token_count")
                    .and_then(Value::as_u64)
                    .filter(|v| *v > 0)
                    .unwrap_or(crate::tide_providers::DEFAULT_CONTEXT_WINDOW),
                reasoning: model.get("supports_thinking").and_then(Value::as_bool).unwrap_or(false),
                vision: model.get("supports_images").and_then(Value::as_bool).unwrap_or(false),
                match_state: "live".to_owned(),
                price_label: None,
                supported_efforts: Vec::new(),
                catalog_id: None,
                model_id: id,
            })
        })
        .collect();
    if models.is_empty() {
        bail!("the zed model list response contained no models");
    }
    models.sort_by(|a, b| a.model_id.cmp(&b.model_id));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_round_trip() {
        let cred = ZedCredential {
            user_id: "605409".into(),
            access_token: "tok".into(),
            organization_id: Some("org_1".into()),
        };
        let blob = cred.to_blob().unwrap();
        assert_eq!(blob, r#"{"userId":"605409","accessToken":"tok","organizationId":"org_1"}"#);
        assert_eq!(ZedCredential::from_blob(&blob).unwrap(), cred);
    }

    #[test]
    fn blob_omits_null_org_and_rejects_empty() {
        let blob = ZedCredential { user_id: "1".into(), access_token: "t".into(), organization_id: None }
            .to_blob().unwrap();
        assert!(!blob.contains("organizationId"));
        // A blob without the organizationId key deserializes to `None`.
        assert_eq!(
            ZedCredential::from_blob(r#"{"userId":"1","accessToken":"t"}"#)
                .unwrap()
                .organization_id,
            None
        );
        assert!(ZedCredential::from_blob(r#"{"userId":"","accessToken":"t"}"#).is_err());
    }

    #[test]
    fn parse_zed_models_maps_fields() {
        let json = serde_json::json!({ "models": [
            { "id": "claude-sonnet-5", "provider": "anthropic", "display_name": "Claude Sonnet 5",
              "max_token_count": 1_000_000, "max_output_tokens": 128_000,
              "supports_tools": true, "supports_images": true, "supports_thinking": true },
            { "id": "bare", "max_token_count": 0 }
        ]});
        let models = parse_zed_models(&json).unwrap();
        assert_eq!(models.len(), 2);
        // sorted by model_id: "bare" < "claude-sonnet-5"
        assert_eq!(models[0].model_id, "bare");
        assert_eq!(models[0].alias, "bare"); // alias falls back to the id
        assert_eq!(models[0].context_window, crate::tide_providers::DEFAULT_CONTEXT_WINDOW);
        assert!(!models[0].reasoning && !models[0].vision);
        let first = &models[1];
        assert_eq!(first.model_id, "claude-sonnet-5");
        assert_eq!(first.alias, "Claude Sonnet 5");
        assert_eq!(first.context_window, 1_000_000);
        assert!(first.reasoning && first.vision);
        assert_eq!(first.match_state, "live");
        assert!(models[0].model_id <= models[1].model_id);
    }

    #[test]
    fn parse_zed_models_rejects_empty() {
        assert!(parse_zed_models(&serde_json::json!({})).is_err());
        assert!(parse_zed_models(&serde_json::json!({ "models": [] })).is_err());
    }

    #[test]
    fn blob_rejects_invalid_credentials_in_both_directions() {
        let empty_user =
            ZedCredential { user_id: "".into(), access_token: "t".into(), organization_id: None };
        assert!(empty_user.to_blob().is_err());
        assert!(ZedCredential::from_blob(r#"{"userId":"   ","accessToken":"t"}"#).is_err());
        assert!(
            ZedCredential::from_blob(r#"{"userId":"1","accessToken":"t","organizationId":""}"#)
                .is_err()
        );
    }
}
