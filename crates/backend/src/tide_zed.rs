//! Zed cloud credential handling for the `zed` provider style. The
//! credential is a three-field JSON blob stored (encrypted) in the tide
//! provider config's `encrypted_key` column and passed to the engine
//! verbatim as `EngineModelConfig::api_key`.

use anyhow::{Context as _, bail};
use serde::{Deserialize, Serialize};
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
