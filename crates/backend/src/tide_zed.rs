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

#[allow(dead_code)] // used from task 5
pub(crate) fn http_client() -> anyhow::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .context("could not build the zed client")
}

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
            if id.trim().is_empty() {
                return None;
            }
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
        bail!("the zed model list contained no models with a usable id");
    }
    models.sort_by(|a, b| a.model_id.cmp(&b.model_id));
    Ok(models)
}

#[allow(dead_code)] // used from task 5
pub(crate) fn zed_llm_token(
    client: &reqwest::blocking::Client,
    cred: &ZedCredential,
) -> anyhow::Result<String> {
    let mut body = serde_json::Map::new();
    if let Some(org) = &cred.organization_id {
        body.insert("organization_id".into(), Value::String(org.clone()));
    }
    let response = client
        .post(format!("{}/client/llm_tokens", cloud_url()))
        .header("Authorization", format!("{} {}", cred.user_id, cred.access_token))
        .json(&body)
        .send()
        .context("could not reach cloud.zed.dev")?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        bail!("Zed rejected the sign-in (HTTP {status}) \u{2014} sign in to Zed desktop again, then retry");
    }
    if !status.is_success() {
        bail!("llm-token endpoint HTTP {status}");
    }
    response
        .json::<Value>()
        .context("the llm-token response was not JSON")?
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("the llm-token response had no token"))
}

#[allow(dead_code)] // used from task 5
pub(crate) fn zed_models(
    client: &reqwest::blocking::Client,
    cred: &ZedCredential,
) -> anyhow::Result<Vec<TideModelWire>> {
    let token = zed_llm_token(client, cred)?;
    let response = client
        .get(format!("{}/models", cloud_url()))
        .header("Authorization", format!("Bearer {token}"))
        .header("x-zed-client-supports-x-ai", "true")
        .send()
        .context("could not reach cloud.zed.dev/models")?;
    let status = response.status();
    let text = response.text().context("could not read the models response")?;
    if !status.is_success() {
        bail!("HTTP {status}: {}", text.chars().take(200).collect::<String>());
    }
    let json: Value = serde_json::from_str(&text).context("the models response was not JSON")?;
    parse_zed_models(&json)
}

#[allow(dead_code)] // used from task 5
pub(crate) fn zed_users_me(
    client: &reqwest::blocking::Client,
    cred: &ZedCredential,
) -> anyhow::Result<Value> {
    let response = client
        .get(format!("{}/client/users/me", cloud_url()))
        .header("Authorization", format!("{} {}", cred.user_id, cred.access_token))
        .send()
        .context("could not reach cloud.zed.dev/client/users/me")?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        bail!("Zed rejected the credentials (HTTP {status}) \u{2014} sign in to Zed desktop again, then retry");
    }
    let text = response.text().context("could not read the users/me response")?;
    if !status.is_success() {
        bail!("users/me endpoint HTTP {status}");
    }
    serde_json::from_str(&text).context("the users/me response was not JSON")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cloud URL override is process-global and tests run in parallel,
    /// so every test that points the client at a FakeCloud holds this lock
    /// for its whole body.
    static CLOUD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn set_cloud(url: Option<String>) {
        *TEST_CLOUD_URL.lock().unwrap_or_else(|p| p.into_inner()) = url;
    }

    /// Points the global cloud URL override at `url` until the guard drops.
    /// The held lock serializes FakeCloud tests, and Drop clears the
    /// override even when a failing assertion unwinds, so a later test
    /// can't inherit a URL pointing at a dead listener.
    struct CloudGuard(std::sync::MutexGuard<'static, ()>);

    fn cloud_guard(url: String) -> CloudGuard {
        let guard = CloudGuard(CLOUD_LOCK.lock().unwrap_or_else(|p| p.into_inner()));
        set_cloud(Some(url));
        guard
    }

    impl Drop for CloudGuard {
        fn drop(&mut self) {
            set_cloud(None);
        }
    }

    /// A fake cloud.zed.dev: serves one canned raw HTTP response per
    /// connection (in order) and captures each request's start line,
    /// headers (minus content-length), and body. When the canned responses
    /// run out the accept thread exits and closes the listener, so an
    /// overrun request fails immediately instead of stalling until the
    /// client timeout.
    struct FakeCloud {
        base_url: String,
        requests: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>, // (start line + headers, body)
    }

    impl FakeCloud {
        fn spawn(responses: Vec<String>) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let srv_requests = requests.clone();
            std::thread::spawn(move || {
                let mut remaining = responses.into_iter();
                for stream in listener.incoming().flatten() {
                    let Some(response) = remaining.next() else { break };
                    let mut stream = stream;
                    use std::io::{BufRead, BufReader, Read, Write};
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut captured = String::new();
                    let mut length = 0usize;
                    // read start line + headers, capture them, then the body
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        let trimmed_end = line.trim_end();
                        if trimmed_end.is_empty() {
                            break;
                        }
                        if let Some((n, v)) = trimmed_end.split_once(':') {
                            if n.trim().eq_ignore_ascii_case("content-length") {
                                length = v.trim().parse().unwrap_or(0);
                            }
                        }
                        if !trimmed_end.to_ascii_lowercase().starts_with("content-length") {
                            captured.push_str(trimmed_end);
                            captured.push('\n');
                        }
                    }
                    let mut body = vec![0u8; length];
                    reader.read_exact(&mut body).unwrap();
                    srv_requests.lock().unwrap().push((
                        captured.trim().to_owned(),
                        String::from_utf8_lossy(&body).into_owned(),
                    ));
                    stream.write_all(response.as_bytes()).unwrap();
                }
            });
            Self { base_url, requests }
        }
    }

    fn http_ok_json(json: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            json.len(),
            json
        )
    }

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
    fn parse_zed_models_skips_unusable_ids() {
        // A non-string id, a missing id, and a blank id are all skipped; when
        // every entry is skipped the parse fails with its own message.
        let all_bad = serde_json::json!({ "models": [
            { "display_name": "x" }, { "id": "  " }, { "id": 7 }
        ]});
        let err = parse_zed_models(&all_bad).unwrap_err();
        assert!(err.to_string().contains("usable id"), "unexpected error: {err}");
        // A mix keeps only the usable entry, with the id as alias fallback.
        let models = parse_zed_models(&serde_json::json!({ "models": [
            { "display_name": "x" }, { "id": "good-one" }
        ]}))
        .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_id, "good-one");
        assert_eq!(models[0].alias, "good-one");
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

    #[test]
    fn llm_token_sends_custom_auth_and_org_body() {
        let cloud = FakeCloud::spawn(vec![http_ok_json(r#"{"token":"llm-tok"}"#)]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let cred = ZedCredential {
            user_id: "605409".into(),
            access_token: "acc".into(),
            organization_id: Some("org_9".into()),
        };
        let token = zed_llm_token(&http_client().unwrap(), &cred).unwrap();
        assert_eq!(token, "llm-tok");
        let (captured, body) = cloud.requests.lock().unwrap()[0].clone();
        assert!(captured.contains("POST /client/llm_tokens"), "{captured}");
        assert!(
            captured.contains("authorization: 605409 acc"),
            "custom auth scheme, got: {captured}"
        );
        assert!(body.contains(r#""organization_id":"org_9""#), "{body}");
    }

    #[test]
    fn llm_token_rejects_dead_credentials() {
        let denied =
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned();
        let cloud = FakeCloud::spawn(vec![denied]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let err = zed_llm_token(&http_client().unwrap(), &ZedCredential {
            user_id: "1".into(),
            access_token: "dead".into(),
            organization_id: None,
        })
        .unwrap_err()
        .to_string();
        assert!(err.to_lowercase().contains("sign"), "{err}");
    }

    #[test]
    fn models_uses_bearer_llm_token() {
        let cloud = FakeCloud::spawn(vec![
            http_ok_json(r#"{"token":"llm-tok"}"#),
            http_ok_json(
                r#"{"models":[{"id":"claude-sonnet-5","max_token_count":1000,"supports_thinking":true}]}"#,
            ),
        ]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let models = zed_models(&http_client().unwrap(), &ZedCredential {
            user_id: "1".into(),
            access_token: "a".into(),
            organization_id: None,
        })
        .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_id, "claude-sonnet-5");
        assert_eq!(models[0].context_window, 1000);
        assert!(models[0].reasoning);
        let captured: Vec<String> =
            cloud.requests.lock().unwrap().iter().map(|(c, _)| c.clone()).collect();
        assert!(captured[1].contains("GET /models"), "{captured:?}");
        assert!(captured[1].contains("authorization: Bearer llm-tok"), "{captured:?}");
        assert!(captured[1].contains("x-zed-client-supports-x-ai: true"), "{captured:?}");
    }

    #[test]
    fn models_surfaces_http_error_body() {
        let denied =
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned();
        let cloud = FakeCloud::spawn(vec![http_ok_json(r#"{"token":"T"}"#), denied]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let err = zed_models(&http_client().unwrap(), &ZedCredential {
            user_id: "1".into(),
            access_token: "a".into(),
            organization_id: None,
        })
        .unwrap_err()
        .to_string();
        assert!(err.contains("401"), "{err}");
    }

    #[test]
    fn users_me_uses_custom_auth() {
        let cloud = FakeCloud::spawn(vec![http_ok_json(r#"{"id":"605409"}"#)]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let cred = ZedCredential {
            user_id: "605409".into(),
            access_token: "acc".into(),
            organization_id: None,
        };
        let me = zed_users_me(&http_client().unwrap(), &cred).unwrap();
        assert_eq!(me["id"], "605409");
        let (captured, _) = cloud.requests.lock().unwrap()[0].clone();
        assert!(captured.contains("GET /client/users/me"), "{captured}");
        assert!(
            captured.contains("authorization: 605409 acc"),
            "custom auth scheme, got: {captured}"
        );
    }

    #[test]
    fn users_me_splits_auth_failures_from_outages() {
        let cloud = FakeCloud::spawn(vec![
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_owned(),
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_owned(),
        ]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let cred =
            ZedCredential { user_id: "1".into(), access_token: "a".into(), organization_id: None };
        let auth_err = zed_users_me(&http_client().unwrap(), &cred).unwrap_err().to_string();
        assert!(auth_err.to_lowercase().contains("sign in to zed"), "{auth_err}");
        // A 5xx outage is a plain HTTP error, not a sign-in prompt.
        let outage_err = zed_users_me(&http_client().unwrap(), &cred).unwrap_err().to_string();
        assert!(outage_err.contains("500"), "{outage_err}");
        assert!(!outage_err.to_lowercase().contains("sign"), "{outage_err}");
    }

    #[test]
    fn fake_cloud_overrun_fails_fast() {
        let cloud = FakeCloud::spawn(vec![http_ok_json(r#"{"token":"one"}"#)]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let cred =
            ZedCredential { user_id: "1".into(), access_token: "a".into(), organization_id: None };
        let client = http_client().unwrap();
        assert_eq!(zed_llm_token(&client, &cred).unwrap(), "one");
        // A request beyond the canned responses must fail immediately (the
        // listener closes when they run out), not stall for the 20s timeout.
        let start = std::time::Instant::now();
        assert!(zed_llm_token(&client, &cred).is_err());
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "overrun stalled for {:?}",
            start.elapsed()
        );
    }
}
