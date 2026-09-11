//! Zed cloud credential handling for the `zed` provider style. The
//! credential is a three-field JSON blob stored (encrypted) in the tide
//! provider config's `encrypted_key` column and passed to the engine
//! verbatim as `EngineModelConfig::api_key`.

use anyhow::{Context as _, bail};
use protocol::tide::{TideModelWire, TideZedOrganization, TideZedSignInResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const CLOUD_URL: &str = "https://cloud.zed.dev";

#[cfg(test)]
static TEST_CLOUD_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn cloud_url() -> String {
    #[cfg(test)]
    if let Some(url) = TEST_CLOUD_URL
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return url;
    }
    CLOUD_URL.to_owned()
}

/// The cloud URL override is process-global and tests run in parallel, so
/// every test that points the client at a FakeCloud holds this lock for
/// its whole body. Shared with sibling test modules (tide_providers).
#[cfg(test)]
pub(crate) static CLOUD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn set_cloud_url_for_tests(url: Option<String>) {
    *TEST_CLOUD_URL.lock().unwrap_or_else(|p| p.into_inner()) = url;
}

/// Points the global cloud URL override at `url` until the guard drops.
/// The held lock serializes FakeCloud tests, and Drop clears the override
/// even when a failing assertion unwinds, so a later test can't inherit a
/// URL pointing at a dead listener.
#[cfg(test)]
pub(crate) struct CloudGuard(std::sync::MutexGuard<'static, ()>);

#[cfg(test)]
pub(crate) fn cloud_guard(url: String) -> CloudGuard {
    let guard = CloudGuard(CLOUD_LOCK.lock().unwrap_or_else(|p| p.into_inner()));
    set_cloud_url_for_tests(Some(url));
    guard
}

#[cfg(test)]
impl Drop for CloudGuard {
    fn drop(&mut self) {
        set_cloud_url_for_tests(None);
    }
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
    // A control character in either field would make `HeaderValue::from_str`
    // fail when the request is sent, surfacing as a misleading network error.
    if cred.user_id.chars().any(char::is_control) || cred.access_token.chars().any(char::is_control)
    {
        bail!("zed credential contains control characters");
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

pub(crate) fn http_client() -> anyhow::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .context("could not build the zed client")
}

/// Decode the hex body of `security`'s hex-dumped password line.
#[cfg(any(target_os = "macos", test))]
fn decode_hex(hex: &str) -> anyhow::Result<Vec<u8>> {
    if hex.len() % 2 != 0 {
        bail!("the hex dump has an odd length");
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let hi = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(|| anyhow::anyhow!("the hex dump has a bad digit"))?;
            let lo = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(|| anyhow::anyhow!("the hex dump has a bad digit"))?;
            u8::try_from(hi * 16 + lo).context("the hex dump has an out-of-range byte")
        })
        .collect()
}

/// Pull the password out of `security find-internet-password -g`'s output.
/// The line reads `password: "literal"` for printable passwords and
/// `password: 0x…` (a hex dump, followed by a best-effort quoted rendering)
/// when the stored bytes aren't clean text. Pure so tests can exercise both
/// shapes without touching the keychain.
#[cfg(any(target_os = "macos", test))]
fn keychain_password(stdout: &str, stderr: &str) -> anyhow::Result<String> {
    let line = stdout
        .lines()
        .chain(stderr.lines())
        .find_map(|line| line.strip_prefix("password: "))
        .ok_or_else(|| {
            anyhow::anyhow!("no Zed credentials in the login keychain — is Zed desktop signed in?")
        })?;
    let trimmed = line.trim();
    let password = if let Some(hex) = trimmed.strip_prefix("0x") {
        // Only the first whitespace-delimited token is hex; the rest is
        // security's quoted guess at the bytes.
        let hex = hex.split_whitespace().next().unwrap_or_default();
        String::from_utf8(decode_hex(hex)?)
            .context("the keychain Zed password is not valid UTF-8")?
    } else {
        // Strip exactly one outer pair of quotes: `trim_matches` would eat
        // the real quotes of a password that itself starts or ends with `"`.
        trimmed
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(trimmed)
            .to_owned()
    };
    if password.is_empty() {
        bail!("the keychain Zed entry has an empty password");
    }
    Ok(password)
}

/// Pull the account (= Zed user id) out of the attribute dump `security`
/// prints. Which stream carries the dump varies by macOS build (stdout on
/// current ones, stderr on older), so scan both.
#[cfg(any(target_os = "macos", test))]
fn keychain_account(stdout: &str, stderr: &str) -> anyhow::Result<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .find(|line| line.contains("\"acct\""))
        .and_then(|line| line.split('"').nth(3))
        .map(str::to_owned)
        .filter(|id| !id.is_empty() && id != "<NULL>")
        .ok_or_else(|| anyhow::anyhow!("the keychain entry carries no Zed user id"))
}

/// Read Zed desktop's credentials from the macOS login keychain. `-g`
/// prints the password to stdout and the item attributes (including the
/// account = user id) to stderr in one invocation. Older/some Zed builds
/// file the item under the bare `zed.dev` host instead of the URL-scheme
/// name, so both are tried and the best diagnosis is kept for the error.
#[cfg(target_os = "macos")]
pub fn read_zed_keychain() -> anyhow::Result<ZedCredential> {
    let mut diagnosis = "security produced no diagnostic".to_owned();
    for server in ["https://zed.dev", "zed.dev"] {
        let output = std::process::Command::new("/usr/bin/security")
            .args(["find-internet-password", "-g", "-s", server])
            .output()
            .context("could not run the macOS keychain tool")?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() {
            // Deny, not-found, and interaction errors all exit non-zero;
            // security's last stderr line names which one this was.
            if let Some(line) = stderr.lines().rev().find(|line| !line.trim().is_empty()) {
                diagnosis = line.trim().to_owned();
            }
            continue;
        }
        let access_token = keychain_password(&stdout, &stderr)?;
        let user_id = keychain_account(&stdout, &stderr)?;
        let cred = ZedCredential {
            user_id,
            access_token,
            organization_id: None,
        };
        ensure_creds(&cred)?;
        return Ok(cred);
    }
    bail!("the macOS keychain has no usable Zed entry: {diagnosis}")
}

#[cfg(not(target_os = "macos"))]
pub fn read_zed_keychain() -> anyhow::Result<ZedCredential> {
    bail!("automatic Zed sign-in needs the macOS keychain — paste the credentials manually")
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
                reasoning: model
                    .get("supports_thinking")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                vision: model
                    .get("supports_images")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
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
        .header(
            "Authorization",
            format!("{} {}", cred.user_id, cred.access_token),
        )
        .json(&body)
        .send()
        .context("could not reach cloud.zed.dev")?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        bail!(
            "Zed rejected the sign-in (HTTP {status}) \u{2014} sign in to Zed desktop again, then retry"
        );
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
    let text = response
        .text()
        .context("could not read the models response")?;
    if !status.is_success() {
        bail!(
            "HTTP {status}: {}",
            text.chars().take(200).collect::<String>()
        );
    }
    let json: Value = serde_json::from_str(&text).context("the models response was not JSON")?;
    parse_zed_models(&json)
}

pub(crate) fn zed_users_me(
    client: &reqwest::blocking::Client,
    cred: &ZedCredential,
) -> anyhow::Result<Value> {
    let response = client
        .get(format!("{}/client/users/me", cloud_url()))
        .header(
            "Authorization",
            format!("{} {}", cred.user_id, cred.access_token),
        )
        .send()
        .context("could not reach cloud.zed.dev/client/users/me")?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        bail!(
            "Zed rejected the credentials (HTTP {status}) \u{2014} sign in to Zed desktop again, then retry"
        );
    }
    let text = response
        .text()
        .context("could not read the users/me response")?;
    if !status.is_success() {
        bail!("users/me endpoint HTTP {status}");
    }
    serde_json::from_str(&text).context("the users/me response was not JSON")
}

pub fn zed_sign_in(
    fetch_credential: impl FnOnce() -> anyhow::Result<ZedCredential>,
) -> anyhow::Result<TideZedSignInResult> {
    let cred = fetch_credential()?;
    let client = http_client()?;
    let me = zed_users_me(&client, &cred)?;
    let user = me.get("user").cloned().unwrap_or(Value::Null);
    let plans = me
        .get("plans_by_organization")
        .cloned()
        .unwrap_or(Value::Null);
    let mut organizations = Vec::new();
    if let Some(list) = me.get("organizations").and_then(Value::as_array) {
        for org in list {
            let id = org.get("id").and_then(Value::as_str).unwrap_or_default();
            if id.trim().is_empty() {
                continue;
            }
            let id = id.to_owned();
            organizations.push(TideZedOrganization {
                plan: plans.get(&id).and_then(Value::as_str).map(str::to_owned),
                id,
                name: org
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                is_personal: org
                    .get("is_personal")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
    }
    Ok(TideZedSignInResult {
        user_id: cred.user_id,
        access_token: cred.access_token,
        username: user
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        display_name: user.get("name").and_then(Value::as_str).map(str::to_owned),
        organizations,
        default_organization_id: me
            .get("default_organization_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// A fake cloud.zed.dev: serves one canned raw HTTP response per
/// connection (in order) and captures each request's start line,
/// headers (minus content-length), and body. When the canned responses
/// run out the accept thread exits and closes the listener, so an
/// overrun request fails immediately instead of stalling until the
/// client timeout.
#[cfg(test)]
pub(crate) struct FakeCloud {
    pub(crate) base_url: String,
    pub(crate) requests: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>, // (start line + headers, body)
}

#[cfg(test)]
impl FakeCloud {
    pub(crate) fn spawn(responses: Vec<String>) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let srv_requests = requests.clone();
        std::thread::spawn(move || {
            let mut remaining = responses.into_iter();
            for stream in listener.incoming().flatten() {
                let Some(response) = remaining.next() else {
                    break;
                };
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
                    if !trimmed_end
                        .to_ascii_lowercase()
                        .starts_with("content-length")
                    {
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

#[cfg(test)]
pub(crate) fn http_ok_json(json: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
        json.len(),
        json
    )
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
        assert_eq!(
            blob,
            r#"{"userId":"605409","accessToken":"tok","organizationId":"org_1"}"#
        );
        assert_eq!(ZedCredential::from_blob(&blob).unwrap(), cred);
    }

    #[test]
    fn blob_omits_null_org_and_rejects_empty() {
        let blob = ZedCredential {
            user_id: "1".into(),
            access_token: "t".into(),
            organization_id: None,
        }
        .to_blob()
        .unwrap();
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
        assert_eq!(
            models[0].context_window,
            crate::tide_providers::DEFAULT_CONTEXT_WINDOW
        );
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
        assert!(
            err.to_string().contains("usable id"),
            "unexpected error: {err}"
        );
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
        let empty_user = ZedCredential {
            user_id: "".into(),
            access_token: "t".into(),
            organization_id: None,
        };
        assert!(empty_user.to_blob().is_err());
        assert!(ZedCredential::from_blob(r#"{"userId":"   ","accessToken":"t"}"#).is_err());
        assert!(
            ZedCredential::from_blob(r#"{"userId":"1","accessToken":"t","organizationId":""}"#)
                .is_err()
        );
    }

    #[test]
    fn blob_rejects_control_characters() {
        // A control character would fail HeaderValue::from_str when the
        // request is sent, surfacing as a misleading network error.
        let bad_user = ZedCredential {
            user_id: "1\u{0}".into(),
            access_token: "t".into(),
            organization_id: None,
        };
        let bad_token = ZedCredential {
            user_id: "1".into(),
            access_token: "t\n".into(),
            organization_id: None,
        };
        assert!(bad_user.to_blob().is_err());
        assert!(bad_token.to_blob().is_err());
        let err = bad_user.to_blob().unwrap_err().to_string();
        assert!(err.contains("control characters"), "{err}");
    }

    #[test]
    fn keychain_password_parses_quoted_and_hex_forms() {
        // The common shape: `security` prints the password quoted, on
        // stdout or stderr.
        let quoted = "keychain: \"login\"\nclass: \"inet\"\n";
        assert_eq!(
            keychain_password("password: \"sekret-token\"\n", quoted).unwrap(),
            "sekret-token"
        );
        // Exactly one outer pair of quotes is stripped, so a password that
        // itself starts or ends with a quote survives (trim_matches ate it).
        assert_eq!(
            keychain_password("password: \"a\"b\"\n", "").unwrap(),
            "a\"b"
        );
        // An unrenderable password comes back as a hex dump followed by
        // security's quoted guess; only the hex is the password.
        assert_eq!(
            keychain_password("password: 0x746F6B656E  \"token\"\n", "").unwrap(),
            "token"
        );
        // An empty password is never usable.
        assert!(keychain_password("password: \"\"\n", "").is_err());
        // No password line anywhere is the not-signed-in case.
        let err = keychain_password(
            "keychain: \"login\"\n",
            "SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
        )
        .unwrap_err();
        assert!(err.to_string().contains("no Zed credentials"), "{err}");
    }

    #[test]
    fn keychain_account_rejects_null_and_missing() {
        let attributes =
            "attributes:\n    \"acct\"<blob>=\"605409\"\n    \"srvr\"<blob>=\"zed.dev\"\n";
        // The dump arrives on stdout on current macOS builds, stderr on
        // older ones — both must work.
        assert_eq!(keychain_account("", attributes).unwrap(), "605409");
        assert_eq!(keychain_account(attributes, "").unwrap(), "605409");
        // An unset account prints as the literal <NULL>.
        let null_acct = "attributes:\n    \"acct\"<blob>=\"<NULL>\"\n";
        let err = keychain_account(null_acct, "").unwrap_err();
        assert!(err.to_string().contains("no Zed user id"), "{err}");
        assert!(keychain_account("", "attributes:\n    \"srvr\"<blob>=\"zed.dev\"\n").is_err());
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
        let err = zed_llm_token(
            &http_client().unwrap(),
            &ZedCredential {
                user_id: "1".into(),
                access_token: "dead".into(),
                organization_id: None,
            },
        )
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
        let models = zed_models(
            &http_client().unwrap(),
            &ZedCredential {
                user_id: "1".into(),
                access_token: "a".into(),
                organization_id: None,
            },
        )
        .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model_id, "claude-sonnet-5");
        assert_eq!(models[0].context_window, 1000);
        assert!(models[0].reasoning);
        let captured: Vec<String> = cloud
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|(c, _)| c.clone())
            .collect();
        assert!(captured[1].contains("GET /models"), "{captured:?}");
        assert!(
            captured[1].contains("authorization: Bearer llm-tok"),
            "{captured:?}"
        );
        assert!(
            captured[1].contains("x-zed-client-supports-x-ai: true"),
            "{captured:?}"
        );
    }

    #[test]
    fn models_surfaces_http_error_body() {
        let denied = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_owned();
        let cloud = FakeCloud::spawn(vec![http_ok_json(r#"{"token":"T"}"#), denied]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let err = zed_models(
            &http_client().unwrap(),
            &ZedCredential {
                user_id: "1".into(),
                access_token: "a".into(),
                organization_id: None,
            },
        )
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
        let cred = ZedCredential {
            user_id: "1".into(),
            access_token: "a".into(),
            organization_id: None,
        };
        let auth_err = zed_users_me(&http_client().unwrap(), &cred)
            .unwrap_err()
            .to_string();
        assert!(
            auth_err.to_lowercase().contains("sign in to zed"),
            "{auth_err}"
        );
        // A 5xx outage is a plain HTTP error, not a sign-in prompt.
        let outage_err = zed_users_me(&http_client().unwrap(), &cred)
            .unwrap_err()
            .to_string();
        assert!(outage_err.contains("500"), "{outage_err}");
        assert!(!outage_err.to_lowercase().contains("sign"), "{outage_err}");
    }

    #[test]
    fn sign_in_merges_orgs_with_plans() {
        let me = r#"{"user":{"id":605409,"username":"yodeput","name":"Yogi"},
            "organizations":[{"id":"org_p","name":"yodeput's Organization","is_personal":true},{"id":"org_v","name":"Zed VIP","is_personal":false}],
            "default_organization_id":"org_v",
            "plans_by_organization":{"org_p":"zed_student","org_v":"zed_vip"}}"#;
        let cloud = FakeCloud::spawn(vec![http_ok_json(me)]);
        let _cloud_guard = cloud_guard(cloud.base_url.clone());
        let result = zed_sign_in(|| {
            Ok(ZedCredential {
                user_id: "605409".into(),
                access_token: "acc".into(),
                organization_id: None,
            })
        })
        .unwrap();
        assert_eq!(result.username, "yodeput");
        assert_eq!(result.display_name.as_deref(), Some("Yogi"));
        assert_eq!(result.user_id, "605409");
        assert_eq!(result.access_token, "acc");
        assert_eq!(result.organizations.len(), 2);
        assert_eq!(result.organizations[0].id, "org_p");
        assert!(result.organizations[0].is_personal);
        assert!(!result.organizations[1].is_personal);
        assert_eq!(result.organizations[0].plan.as_deref(), Some("zed_student"));
        assert_eq!(result.organizations[1].plan.as_deref(), Some("zed_vip"));
        assert_eq!(result.default_organization_id.as_deref(), Some("org_v"));
    }

    #[test]
    fn sign_in_propagates_keychain_error() {
        let result = zed_sign_in(|| Err(anyhow::anyhow!("denied")));
        assert!(result.is_err());
    }

    #[test]
    fn sign_in_tolerates_missing_optional_fields() {
        // organizations absent, default_organization_id absent, plans absent,
        // user without name — must still succeed with empty orgs and None fields.
        let me = r#"{"user":{"username":"solo"},"organizations":[{"id":"","name":"Ghost","is_personal":false}]}"#;
        let cloud = FakeCloud::spawn(vec![http_ok_json(me)]);
        let _cloud_guard = cloud_guard(cloud.base_url.clone());
        let result = zed_sign_in(|| {
            Ok(ZedCredential {
                user_id: "7".into(),
                access_token: "t".into(),
                organization_id: None,
            })
        })
        .unwrap();
        assert!(result.organizations.is_empty());
        assert_eq!(result.display_name, None);
        assert_eq!(result.default_organization_id, None);
        assert_eq!(result.organizations.len(), 0);
    }

    #[test]
    fn fake_cloud_overrun_fails_fast() {
        let cloud = FakeCloud::spawn(vec![http_ok_json(r#"{"token":"one"}"#)]);
        let _cloud = cloud_guard(cloud.base_url.clone());
        let cred = ZedCredential {
            user_id: "1".into(),
            access_token: "a".into(),
            organization_id: None,
        };
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
