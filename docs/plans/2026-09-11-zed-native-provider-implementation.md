# Zed Native Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a third provider style `zed` that streams completions from Zed's cloud (`cloud.zed.dev`) using the local Zed desktop's Keychain credentials — one-click sign-in, org picker, live model list — with no proxy binary.

**Architecture:** Backend gains a `tide_zed.rs` module (credential blob, token dance, `/models` fetch, Keychain sign-in). The engine gains a `zed_bridge.rs`: a localhost TCP listener that rig's real Anthropic client posts to; the bridge coerces request bodies, wraps them in Zed's envelope, does the LLM-token lifecycle against `cloud.zed.dev`, and re-frames the NDJSON response as SSE. The wizard gains a "Zed" preset whose Connect step replaces the API-key field with a sign-in button + org picker.

**Tech Stack:** Rust (GPUI app, rig-core 0.42, reqwest blocking, std TcpListener bridge), serde_json, existing protocol command bus.

**Implementer notes:**
- The working tree carries unrelated uncommitted changes from another session. **Every commit stages only the files its task names — never `git add -A`.**
- Concurrent sessions may hold the cargo lock ("Blocking waiting for file lock") — wait it out.
- Verified API facts live in `docs/plans/2026-09-11-zed-native-provider-design.md` — read it first.
- The credential blob JSON contract (used by wizard state, `encrypted_key`, `EngineModelConfig.api_key`): `{"userId":"605409","accessToken":"…","organizationId":null}` (camelCase, `organizationId` omitted when null).

---

## Phase A — protocol + backend

### Task 1: Protocol wire types + command

**Files:**
- Modify: `crates/protocol/src/tide.rs`
- Modify: `crates/protocol/src/protocol.rs` (command block at :144-184; find the `ResponsePayload` variants `TideProviders`/`TideModels`/`TideProtocol`/`TideConnection` live in by grepping `TideConnection`)

**Step 1:** Append to `crates/protocol/src/tide.rs`:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TideZedOrganization {
    pub id: String,
    pub name: String,
    pub is_personal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TideZedSignInResult {
    pub user_id: String,
    pub access_token: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub organizations: Vec<TideZedOrganization>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_organization_id: Option<String>,
}
```

**Step 2:** In `protocol.rs`, after `Command::TideTestConnection` (~:184), add:

```rust
    /// Read Zed desktop's credentials from the OS keychain and validate
    /// them against cloud.zed.dev. The wizard's Zed Connect step.
    TideZedSignIn,
```

Add the matching `ResponsePayload::TideZedSignIn` variant beside `TideConnection`'s:

```rust
    TideZedSignIn {
        result: Option<TideZedSignInResult>,
        error: Option<String>,
    },
```

Import `TideZedSignInResult` the same way the file imports the other `tide::` types. Grep for every other place `TideTestConnection` appears (serde lists, permission lists in `crates/backend/src/daemon.rs` ~:1538) and mirror the new variant where appropriate — it is auth-free like `TideDetectProtocol`.

**Step 3:** Run: `cargo check -p protocol` — Expected: clean.

**Step 4:** Commit:

```bash
git add crates/protocol/src/tide.rs crates/protocol/src/protocol.rs
git commit -m "feat(protocol): zed sign-in wire types and command"
```

### Task 2: Credential blob type (backend)

**Files:**
- Create: `crates/backend/src/tide_zed.rs`
- Modify: `crates/backend/src/lib.rs:48` (beside `pub mod tide_providers;` add `pub mod tide_zed;`)

**Step 1:** Create `crates/backend/src/tide_zed.rs`:

```rust
//! Zed cloud credential handling for the `zed` provider style. The
//! credential is a three-field JSON blob stored (encrypted) in the tide
//! provider config's `encrypted_key` column and passed to the engine
//! verbatim as `EngineModelConfig::api_key`.

use anyhow::{Context as _, anyhow, bail};
use protocol::tide::{TideModelWire, TideZedSignInResult, TideZedOrganization};
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
    Ok(())
}

pub(crate) fn http_client() -> anyhow::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .context("could not build the zed client")
}
```

**Step 2:** Write the failing test (same file, bottom):

```rust
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
        assert!(ZedCredential::from_blob(r#"{"userId":"","accessToken":"t"}"#).is_err());
    }
}
```

**Step 3:** Run: `cargo test -p backend tide_zed` — Expected: FAIL (no test module yet if you wrote impl first; write tests before impl if following strict TDD), then PASS after both exist.

**Step 4:** Commit:

```bash
git add crates/backend/src/tide_zed.rs crates/backend/src/lib.rs
git commit -m "feat(backend): zed credential blob type"
```

### Task 3: Parse `/models` payload (pure function)

**Files:**
- Modify: `crates/backend/src/tide_providers.rs` — make `DEFAULT_CONTEXT_WINDOW` (line ~40) `pub(crate)`
- Modify: `crates/backend/src/tide_zed.rs`

**Step 1:** Failing test in `tide_zed.rs` tests:

```rust
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
        let first = &models[0];
        assert_eq!(first.model_id, "claude-sonnet-5");
        assert_eq!(first.alias, "Claude Sonnet 5");
        assert_eq!(first.context_window, 1_000_000);
        assert!(first.reasoning && first.vision);
        assert_eq!(first.match_state, "live");
        assert_eq!(models[1].context_window, 200_000); // fallback
        assert!(models[0].model_id < models[1].model_id || models.len() == 2); // sorted
    }

    #[test]
    fn parse_zed_models_rejects_empty() {
        assert!(parse_zed_models(&serde_json::json!({})).is_err());
        assert!(parse_zed_models(&serde_json::json!({ "models": [] })).is_err());
    }
```

**Step 2:** Implement in `tide_zed.rs`:

```rust
pub(crate) fn parse_zed_models(json: &Value) -> anyhow::Result<Vec<TideModelWire>> {
    let list = json
        .get("models")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or_else(|| anyhow!("the zed model list response contained no models"))?;
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
```

**Step 3:** Run: `cargo test -p backend tide_zed` — Expected: PASS.

**Step 4:** Commit:

```bash
git add crates/backend/src/tide_zed.rs crates/backend/src/tide_providers.rs
git commit -m "feat(backend): parse zed /models payload into tide wires"
```

### Task 4: HTTP client — token dance, models, users/me (fake-cloud tests)

**Files:**
- Create: `crates/backend/src/tide_zed.rs` test helper (add to tests module)
- Modify: `crates/backend/src/tide_zed.rs`

**Step 1:** Add a fake-cloud helper to the tests module (one canned HTTP response per connection, captures the request):

```rust
    struct FakeCloud {
        base_url: String,
        requests: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>, // (path+query, body)
        _keep: std::sync::Arc<std::net::TcpListener>,
    }

    impl FakeCloud {
        fn spawn(responses: Vec<String>) -> Self {
            // Each entry: one connection's full raw HTTP response bytes.
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
                    let mut start = String::new();
                    reader.read_line(&mut start).unwrap();
                    let mut length = 0usize;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        let line = line.trim_end().to_owned();
                        if line.is_empty() { break; }
                        if let Some((n, v)) = line.split_once(':') {
                            if n.trim().eq_ignore_ascii_case("content-length") {
                                length = v.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    let mut body = vec![0u8; length];
                    reader.read_exact(&mut body).unwrap();
                    srv_requests.lock().unwrap().push((
                        start.trim().to_owned(),
                        String::from_utf8_lossy(&body).to_owned(),
                    ));
                    stream.write_all(response.as_bytes()).unwrap();
                }
            });
            Self { base_url, requests, _keep: std::sync::Arc::new(listener) }
        }

        fn request_bodies(&self) -> Vec<String> {
            self.requests.lock().unwrap().iter().map(|(_, b)| b.clone()).collect()
        }
    }

    fn http_ok_json(json: serde_json::Value) -> String {
        let body = json.to_string();
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body)
    }
```

**Step 2:** Failing tests:

```rust
    use super::*;

    fn set_cloud(url: Option<String>) {
        *TEST_CLOUD_URL.lock().unwrap() = url;
    }

    #[test]
    fn llm_token_sends_custom_auth_and_org_body() {
        let cloud = FakeCloud::spawn(vec![http_ok_json(serde_json::json!({"token": "llm-tok"}))]);
        set_cloud(Some(cloud.base_url.clone()));
        let cred = ZedCredential { user_id: "605409".into(), access_token: "acc".into(), organization_id: Some("org_9".into()) };
        let token = zed_llm_token(&http_client().unwrap(), &cred).unwrap();
        assert_eq!(token, "llm-tok");
        let (line, body) = cloud.requests.lock().unwrap()[0].clone();
        assert!(line.starts_with("POST /client/llm_tokens"));
        assert!(line.contains("authorization: 605409 acc"), "custom auth scheme, got: {line}");
        assert!(body.contains(r#""organization_id":"org_9""#));
        set_cloud(None);
    }

    #[test]
    fn models_uses_bearer_llm_token() {
        let cloud = FakeCloud::spawn(vec![
            http_ok_json(serde_json::json!({"token": "llm-tok"})),
            http_ok_json(serde_json::json!({"models": [
                {"id": "claude-sonnet-5", "max_token_count": 1000, "supports_thinking": true}
            ]})),
        ]);
        set_cloud(Some(cloud.base_url.clone()));
        let models = zed_models(&http_client().unwrap(), &ZedCredential {
            user_id: "1".into(), access_token: "a".into(), organization_id: None,
        }).unwrap();
        assert_eq!(models[0].model_id, "claude-sonnet-5");
        assert_eq!(models[0].context_window, 1000);
        let lines: Vec<String> = cloud.requests.lock().unwrap().iter().map(|(l, _)| l.clone()).collect();
        assert!(lines[1].starts_with("GET /models"));
        assert!(lines[1].contains("authorization: Bearer llm-tok"));
        set_cloud(None);
    }
```

**Step 3:** Implement:

```rust
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
    if !status.is_success() {
        bail!("Zed rejected the sign-in (HTTP {status}) — sign in to Zed desktop again, then retry");
    }
    response
        .json::<Value>()
        .context("the llm-token response was not JSON")?
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("the llm-token response had no token"))
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
    let text = response.text().context("could not read the models response")?;
    if !status.is_success() {
        bail!("HTTP {status}: {}", text.chars().take(200).collect::<String>());
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
        .header("Authorization", format!("{} {}", cred.user_id, cred.access_token))
        .send()
        .context("could not reach cloud.zed.dev/client/users/me")?;
    let status = response.status();
    let text = response.text().context("could not read the users/me response")?;
    if !status.is_success() {
        bail!("Zed rejected the credentials (HTTP {status}) — sign in to Zed desktop again, then retry");
    }
    serde_json::from_str(&text).context("the users/me response was not JSON")
}
```

**Step 4:** Run: `cargo test -p backend tide_zed` — Expected: PASS (note: the FakeCloud helper asserts lower-cased header lines only if you lowercase when capturing — reqwest sends `authorization`; if flaky, assert case-insensitively).

**Step 5:** Commit:

```bash
git add crates/backend/src/tide_zed.rs
git commit -m "feat(backend): zed token dance and models fetch"
```

### Task 5: `zed_sign_in` with injectable keychain

**Files:**
- Modify: `crates/backend/src/tide_zed.rs`

**Step 1:** Failing test (uses FakeCloud + verified users/me shape):

```rust
    #[test]
    fn sign_in_merges_orgs_with_plans() {
        let me = serde_json::json!({
            "user": { "id": 605409, "username": "yodeput", "name": "Yogi" },
            "organizations": [
                { "id": "org_p", "name": "yodeput's Organization", "is_personal": true },
                { "id": "org_v", "name": "Zed VIP", "is_personal": false }
            ],
            "default_organization_id": "org_v",
            "plans_by_organization": { "org_p": "zed_student", "org_v": "zed_vip" }
        });
        let cloud = FakeCloud::spawn(vec![http_ok_json(me)]);
        set_cloud(Some(cloud.base_url.clone()));
        let result = zed_sign_in(|| Ok(ZedCredential {
            user_id: "605409".into(), access_token: "acc".into(), organization_id: None,
        })).unwrap();
        assert_eq!(result.username, "yodeput");
        assert_eq!(result.display_name.as_deref(), Some("Yogi"));
        assert_eq!(result.organizations.len(), 2);
        assert_eq!(result.organizations[1].plan.as_deref(), Some("zed_vip"));
        assert!(result.organizations[0].is_personal);
        assert_eq!(result.default_organization_id.as_deref(), Some("org_v"));
        assert_eq!(result.access_token, "acc");
        set_cloud(None);
    }

    #[test]
    fn sign_in_propagates_keychain_error() {
        let result = zed_sign_in(|| Err(anyhow!("denied")));
        assert!(result.is_err());
    }
```

**Step 2:** Implement:

```rust
pub fn zed_sign_in(fetch_credential: impl FnOnce() -> anyhow::Result<ZedCredential>) -> anyhow::Result<TideZedSignInResult> {
    let cred = fetch_credential()?;
    let client = http_client()?;
    let me = zed_users_me(&client, &cred)?;
    let user = me.get("user").cloned().unwrap_or(Value::Null);
    let plans = me.get("plans_by_organization").cloned().unwrap_or(Value::Null);
    let mut organizations = Vec::new();
    if let Some(list) = me.get("organizations").and_then(Value::as_array) {
        for org in list {
            let id = org.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            organizations.push(TideZedOrganization {
                plan: plans.get(&id).and_then(Value::as_str).map(str::to_owned),
                id,
                name: org.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                is_personal: org.get("is_personal").and_then(Value::as_bool).unwrap_or(false),
            });
        }
    }
    Ok(TideZedSignInResult {
        user_id: cred.user_id,
        access_token: cred.access_token,
        username: user.get("username").and_then(Value::as_str).unwrap_or_default().to_owned(),
        display_name: user.get("name").and_then(Value::as_str).map(str::to_owned),
        organizations,
        default_organization_id: me
            .get("default_organization_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
```

**Step 3:** Run: `cargo test -p backend tide_zed` — Expected: PASS.

**Step 4:** Commit:

```bash
git add crates/backend/src/tide_zed.rs
git commit -m "feat(backend): zed sign-in with org/plan merge"
```

### Task 6: Keychain read + daemon command

**Files:**
- Modify: `crates/backend/src/tide_zed.rs`
- Modify: `crates/backend/src/daemon.rs` (command arms ~:230-282; the list ~:1538)

**Step 1:** Implement the thin, cfg-gated keychain reader (not unit-tested — it prompts macOS):

```rust
/// Read Zed desktop's credentials from the macOS login keychain. `-g`
/// prints the password to stdout and the item attributes (including the
/// account = user id) to stderr in one invocation.
#[cfg(target_os = "macos")]
pub(crate) fn read_zed_keychain() -> anyhow::Result<ZedCredential> {
    use anyhow::Context as _;
    let output = std::process::Command::new("/usr/bin/security")
        .args(["find-internet-password", "-g", "-s", "https://zed.dev"])
        .output()
        .context("could not run the macOS keychain tool")?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let token = stdout
        .lines()
        .chain(stderr.lines())
        .find_map(|line| line.strip_prefix("password: "))
        .map(str::trim)
        .map(|t| t.trim_matches('"').to_owned())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| anyhow!("no Zed credentials in the login keychain — is Zed desktop signed in?"))?;
    let user_id = stderr
        .lines()
        .find(|line| line.contains("\"acct\""))
        .and_then(|line| line.split('"').nth(3))
        .map(str::to_owned)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("the keychain entry carries no Zed user id"))?;
    ensure_creds(&ZedCredential { user_id, access_token: token, organization_id: None })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_zed_keychain() -> anyhow::Result<ZedCredential> {
    bail!("automatic Zed sign-in needs the macOS keychain — paste the credentials manually")
}
```

(Add `organization_id: None` to the constructed credential inside `ensure_creds` call — restructure to build then validate.)

**Step 2:** In `daemon.rs`, after the `Command::TideTestConnection` arm (~:282):

```rust
            Command::TideZedSignIn => {
                let (result, error) = match crate::tide_zed::zed_sign_in(
                    crate::tide_zed::read_zed_keychain,
                ) {
                    Ok(result) => (Some(result), None),
                    Err(error) => (None, Some(format!("{error:#}"))),
                };
                Ok(ResponsePayload::TideZedSignIn { result, error })
            }
```

**Step 3:** Run: `cargo check -p backend` — Expected: clean (fix any match-exhaustiveness fallout where the new `Command` variant appears).

**Step 4:** Commit:

```bash
git add crates/backend/src/tide_zed.rs crates/backend/src/daemon.rs
git commit -m "feat(backend): TideZedSignIn command over the macOS keychain"
```

### Task 7: Accept `zed` style in provider management

**Files:**
- Modify: `crates/backend/src/tide_providers.rs` — `validate_api_style` (~:106), `probe_models`, `test_connection`

**Step 1:** Failing tests (in `tide_providers.rs` wire-shape tests module or a new one):

```rust
    #[test]
    fn zed_style_passes_validation() {
        assert!(validate_api_style("zed").is_ok());
        assert!(validate_api_style("nope").is_err());
    }

    #[test]
    fn probe_models_dispatches_zed_branch() {
        // A zed blob against an unreachable cloud must fail with the zed
        // error, not the openai/anthropic /models path.
        let err = probe_models(
            "zed".into(),
            "https://cloud.zed.dev".into(),
            r#"{"userId":"1","accessToken":"t"}"#.into(),
        ).unwrap_err().to_string();
        assert!(err.contains("cloud.zed.dev") || err.contains("Zed") || err.contains("HTTP"), "{err}");
    }
```

**Step 2:** `validate_api_style` accepts `"zed"`. `probe_models` top branch, right after `validate_api_style`/`ensure_catalogs`/`http_client`:

```rust
    if api_style == "zed" {
        let cred = crate::tide_zed::ZedCredential::from_blob(&api_key)?;
        return crate::tide_zed::zed_models(&client, &cred);
    }
```

`test_connection` zed branch (after the empty-field guards):

```rust
    if api_style == "zed" {
        let cred = match crate::tide_zed::ZedCredential::from_blob(&api_key) {
            Ok(cred) => cred,
            Err(error) => return (false, Some(error.to_string())),
        };
        return match crate::tide_zed::zed_llm_token(
            &crate::tide_zed::http_client().map_err(|e| e.to_string()).expect("client"),
            &cred,
        ) {
            Ok(_) => (true, None),
            Err(error) => (false, Some(error.to_string())),
        };
    }
```

(Rebuild the client once instead of `expect` if cleaner.)

**Step 3:** Run: `cargo test -p backend tide` — Expected: PASS.

**Step 4:** Commit:

```bash
git add crates/backend/src/tide_providers.rs
git commit -m "feat(backend): zed api style in probe/test-connection"
```

---

## Phase B — engine bridge

### Task 8: Bridge skeleton — listener, request parse, SSE chunk writer

**Files:**
- Modify: `crates/engine/Cargo.toml:15` — reqwest features gain `"blocking"`
- Create: `crates/engine/src/zed_bridge.rs`
- Modify: `crates/engine/src/lib.rs` — register `pub(crate) mod zed_bridge;`

**Step 1:** Cargo.toml: `reqwest = { version = "0.13", default-features = false, features = ["json", "stream", "blocking"] }`.

**Step 2:** Create `crates/engine/src/zed_bridge.rs`. Study `crates/engine/src/mock_sse.rs:35-70` first — the bridge is the same `Arc<TcpListener>` + accept-thread pattern, plus one thread per connection (sub-agents stream concurrently). Core skeleton:

```rust
//! The Zed transport bridge: a localhost listener that rig's Anthropic
//! client posts to. Translates between Anthropic wire format and Zed's
//! cloud protocol (envelope + NDJSON). One bridge per credential,
//! process-wide, so the LLM-token cache survives across turns.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::Value;

const CLOUD_URL: &str = "https://cloud.zed.dev";
/// Pinned client version header — the server gates behavior on it. Bump
/// when the live API rejects requests (undocumented API; see design doc).
const ZED_VERSION: &str = "1.19.2";

static CLOUD_OVERRIDE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

pub(crate) fn set_cloud_url_for_tests(url: Option<String>) {
    *CLOUD_OVERRIDE.lock().unwrap_or_else(|p| p.into_inner()) = url;
}

fn cloud_url() -> String {
    CLOUD_OVERRIDE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .unwrap_or_else(|| CLOUD_URL.to_owned())
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct ZedCredential {
    pub user_id: String,
    pub access_token: String,
    #[serde(default)]
    pub organization_id: Option<String>,
}

pub(crate) struct ZedBridge {
    base_url: String,
    credential: ZedCredential,
    llm_token: Mutex<Option<String>>,
    _keep: Arc<TcpListener>,
}

static BRIDGES: LazyLock<Mutex<HashMap<String, Arc<ZedBridge>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// One shared bridge per credential blob. String errors — the caller wraps
/// them in `EngineError::Config`.
pub(crate) fn shared_bridge(blob: &str) -> Result<Arc<ZedBridge>, String> {
    let credential: ZedCredential =
        serde_json::from_str(blob).map_err(|e| format!("invalid zed credential blob: {e}"))?;
    if credential.user_id.is_empty() || credential.access_token.is_empty() {
        return Err("zed credential blob missing user id or access token".to_owned());
    }
    let mut bridges = BRIDGES.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(bridge) = bridges.get(blob) {
        return Ok(bridge.clone());
    }
    let bridge = Arc::new(ZedBridge::spawn(credential).map_err(|e| format!("zed bridge: {e}"))?);
    bridges.insert(blob.to_owned(), bridge.clone());
    Ok(bridge)
}

impl ZedBridge {
    /// Bind an ephemeral port; the accept loop owns a listener Arc clone
    /// AND an Arc<Self> clone (captured before spawn) so connection threads
    /// can call `self.handle(stream)`.
    fn spawn(credential: ZedCredential) -> std::io::Result<Self> {
        let listener = Arc::new(TcpListener::bind("127.0.0.1:0")?);
        let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let keep = Arc::clone(&listener);
        let bridge = Arc::new(Self {
            base_url: base_url.clone(),
            credential,
            llm_token: Mutex::new(None),
            _keep: keep,
        });
        let accept_bridge = Arc::clone(&bridge);
        let accept_listener = Arc::clone(&listener);
        std::thread::Builder::new()
            .name("zed-bridge".into())
            .spawn(move || {
                for stream in accept_listener.incoming().flatten() {
                    let bridge = Arc::clone(&accept_bridge);
                    std::thread::spawn(move || {
                        let _ = bridge.handle(stream);
                    });
                }
            })?;
        // Return a plain Self whose _keep still pins the listener; the
        // registry stores the Arc'd original.
        Ok(Self {
            base_url,
            credential: ZedCredential {
                user_id: String::new(),
                access_token: String::new(),
                organization_id: None,
            },
            llm_token: Mutex::new(None),
            _keep: Arc::clone(&listener),
        })
        // NOTE: this double-construct is awkward — prefer restructuring so
        // spawn() returns io::Result<Arc<Self>> and shared_bridge inserts
        // it directly. Take that path if it compiles cleaner.
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    fn handle(&self, mut stream: TcpStream) -> std::io::Result<()> {
        let (_start, _headers, body) = read_request(&mut stream)?;
        let _ = body;
        write_sse_head(&mut stream)?;
        let frame = format!(
            "event: message_start\ndata: {}\n\n",
            serde_json::json!({"type": "message_start"})
        );
        write_chunk(&mut stream, frame.as_bytes())?;
        end_chunks(&mut stream)
    }
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<(String, Vec<(String, String)>, Vec<u8>)> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut start = String::new();
    reader.read_line(&mut start)?;
    let mut headers = Vec::new();
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end().to_owned();
        if trimmed.is_empty() { break; }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok((start, headers, body))
}

fn write_sse_head(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
    )
}

fn write_chunk(stream: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    stream.write_all(format!("{:x}\r\n", bytes.len()).as_bytes())?;
    stream.write_all(bytes)?;
    stream.write_all(b"\r\n")
}

fn end_chunks(stream: &mut TcpStream) -> std::io::Result<()> {
    stream.write_all(b"0\r\n\r\n")
}

fn write_plain_error(stream: &mut TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    let body = format!("{{\"error\":{{\"message\":\"{message}\"}}}}");
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}
```

**Step 3:** Failing test first (tests module at file bottom):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_serves_sse_to_a_post() {
        set_cloud_url_for_tests(None);
        let blob = r#"{"userId":"1","accessToken":"t"}"#;
        let bridge = shared_bridge(blob).unwrap();
        let mut stream =
            std::net::TcpStream::connect(bridge.base_url().trim_start_matches("http://")).unwrap();
        use std::io::Write as _;
        let body = r#"{"model":"claude-haiku-4-5","messages":[]}"#;
        write!(stream, "POST /v1/messages HTTP/1.1\r\nHost: zb\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("text/event-stream"));
        assert!(response.contains("event: message_start"));
    }
}
```

**Step 4:** Run: `cargo test -p engine zed_bridge` — Expected: PASS.

**Step 5:** Commit:

```bash
git add crates/engine/src/zed_bridge.rs crates/engine/src/lib.rs crates/engine/Cargo.toml
git commit -m "feat(engine): zed bridge skeleton with SSE chunk framing"
```

### Task 9: Bridge translation — coercion, envelope, family guard

**Files:**
- Modify: `crates/engine/src/zed_bridge.rs`

**Step 1:** Add a FakeCloud helper to the test module (same shape as Task 4's backend helper — copy it; crates don't share test code). Add these tests:

```rust
    fn http_ok_json(json: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", json.len(), json)
    }

    fn ndjson_ok(events: &[Value]) -> String {
        let body = events
            .iter()
            .map(|e| serde_json::json!({ "event": e }).to_string())
            .collect::<Vec<_>>()
            .join("\n");
        format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", body.len(), body)
    }

    fn post_to_bridge(bridge: &ZedBridge, body: &Value) -> String {
        let mut stream =
            std::net::TcpStream::connect(bridge.base_url().trim_start_matches("http://")).unwrap();
        let body = body.to_string();
        use std::io::{Read, Write as _};
        write!(stream, "POST /v1/messages HTTP/1.1\r\nHost: zb\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn bridge_wraps_envelope_and_coerces_content() {
        let cloud = FakeCloud::spawn(vec![ndjson_ok(&[
            serde_json::json!({"type":"message_stop"}),
        ])]);
        set_cloud_url_for_tests(Some(cloud.base_url.clone()));
        let bridge = shared_bridge(r#"{"userId":"9","accessToken":"acc"}"#).unwrap();
        let response = post_to_bridge(&bridge, &serde_json::json!({
            "model": "claude-haiku-4-5", "max_tokens": 32, "stream": true,
            "messages": [{ "role": "user", "content": "Say OK" }]
        }));
        assert!(response.contains("event:"), "{response}");
        let (line, cloud_body) = cloud.requests.lock().unwrap()[0].clone();
        assert!(line.starts_with("POST /completions"), "{line}");
        let sent: Value = serde_json::from_str(&cloud_body).unwrap();
        assert_eq!(sent["intent"], "user_prompt");
        assert_eq!(sent["provider"], "anthropic");
        assert_eq!(sent["model"], "claude-haiku-4-5");
        assert_eq!(
            sent["provider_request"]["messages"][0]["content"],
            serde_json::json!([{ "type": "text", "text": "Say OK" }]),
            "string content coerced to block array"
        );
        set_cloud_url_for_tests(None);
    }

    #[test]
    fn bridge_refuses_non_claude_models() {
        let cloud = FakeCloud::spawn(vec![]);
        set_cloud_url_for_tests(Some(cloud.base_url.clone()));
        let bridge = shared_bridge(r#"{"userId":"9","accessToken":"acc2"}"#).unwrap();
        let response = post_to_bridge(&bridge, &serde_json::json!({
            "model": "gpt-5.6-sol", "messages": []
        }));
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
        assert!(response.contains("claude"));
        set_cloud_url_for_tests(None);
    }
```

**Step 2:** Replace the static `handle` body with the translation:

```rust
    fn handle(&self, mut stream: TcpStream) -> std::io::Result<()> {
        let (_start, _headers, body) = read_request(&mut stream)?;
        let Ok(mut provider_request) = serde_json::from_slice::<Value>(&body) else {
            return write_plain_error(&mut stream, "400 Bad Request", "request body was not JSON");
        };
        let Some(model) = provider_request.get("model").and_then(Value::as_str).map(str::to_owned)
        else {
            return write_plain_error(&mut stream, "400 Bad Request", "request missing model id");
        };
        // v1 scope: only Claude models speak Anthropic format natively on
        // Zed's cloud (the preset's routing needles filter the wizard list
        // to match).
        if !model.contains("claude") {
            return write_plain_error(
                &mut stream,
                "400 Bad Request",
                "the zed provider currently supports claude models only",
            );
        }
        coerce_block_arrays(&mut provider_request);

        let envelope = serde_json::json!({
            "intent": "user_prompt",
            "provider": "anthropic",
            "model": model,
            "provider_request": provider_request,
        });
        match self.cloud_completion(&envelope) {
            Ok(events) => {
                write_sse_head(&mut stream)?;
                for event in events {
                    let ty = event.get("type").and_then(Value::as_str).unwrap_or("event");
                    let frame = format!("event: {ty}\ndata: {event}\n\n");
                    write_chunk(&mut stream, frame.as_bytes())?;
                }
                end_chunks(&mut stream)
            }
            Err(error) => write_plain_error(&mut stream, "502 Bad Gateway", &error),
        }
    }

    /// One NDJSON response from cloud.zed.dev/completions as parsed inner
    /// events. v1 buffers the full body before emitting SSE — verify
    /// first-token latency in the Task 17 smoke test; switch to a
    /// line-by-line Read loop writing chunks as they arrive if it lags.
    fn cloud_completion(&self, envelope: &Value) -> Result<Vec<Value>, String> {
        let token = self.llm_token(false)?;
        let response = self.post_completions(&token, envelope)?;
        let status = response.status();
        if should_refresh(status.as_u16(), response.headers()) {
            let token = self.llm_token(true)?;
            let response = self.post_completions(&token, envelope)?;
            return self.read_ndjson(response);
        }
        if !status.is_success() {
            return Err(format!("zed cloud HTTP {status}"));
        }
        self.read_ndjson(response)
    }

    fn post_completions(
        &self,
        token: &str,
        envelope: &Value,
    ) -> Result<reqwest::blocking::Response, String> {
        let client = reqwest::blocking::Client::new();
        client
            .post(format!("{}/completions", cloud_url()))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .header("x-zed-version", ZED_VERSION)
            .header("x-zed-client-supports-status-messages", "true")
            .header("x-zed-client-supports-stream-ended-request-completion-status", "true")
            .json(envelope)
            .send()
            .map_err(|e| format!("cloud.zed.dev unreachable: {e}"))
    }

    fn read_ndjson(&self, response: reqwest::blocking::Response) -> Result<Vec<Value>, String> {
        let text = response.text().map_err(|e| format!("cloud stream read: {e}"))?;
        let mut events = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() { continue; }
            if let Ok(wrapped) = serde_json::from_str::<Value>(line) {
                if let Some(event) = wrapped.get("event") {
                    events.push(event.clone());
                }
            }
        }
        Ok(events)
    }

    fn llm_token(&self, force: bool) -> Result<String, String> {
        let mut cache = self.llm_token.lock().unwrap_or_else(|p| p.into_inner());
        if force {
            *cache = None;
        }
        if let Some(token) = cache.clone() {
            return Ok(token);
        }
        let client = reqwest::blocking::Client::new();
        let mut body = serde_json::Map::new();
        if let Some(org) = &self.credential.organization_id {
            body.insert("organization_id".into(), Value::String(org.clone()));
        }
        let response = client
            .post(format!("{}/client/llm_tokens", cloud_url()))
            .header("Authorization", format!("{} {}", self.credential.user_id, self.credential.access_token))
            .json(&body)
            .send()
            .map_err(|e| format!("cloud.zed.dev unreachable: {e}"))?;
        if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            return Err("Zed sign-in expired — sign in to Zed desktop, then re-add or re-sign-in the provider".to_owned());
        }
        if !response.status().is_success() {
            return Err(format!("llm-token HTTP {}", response.status()));
        }
        let token = response
            .json::<Value>()
            .ok()
            .and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_owned))
            .ok_or_else(|| "llm-token response missing token".to_owned())?;
        *cache = Some(token.clone());
        Ok(token)
    }
```

And the free function beside the other helpers:

```rust
/// Zed's Anthropic parser rejects string message content ("expected a
/// sequence") — always send block arrays.
fn coerce_block_arrays(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages.iter_mut() {
        let Some(text) = message.get("content").and_then(Value::as_str).map(str::to_owned)
        else { continue };
        message["content"] = serde_json::json!([{ "type": "text", "text": text }]);
    }
}

fn should_refresh(status: u16, headers: &reqwest::header::HeaderMap) -> bool {
    status == 401
        || headers.contains_key("x-zed-expired-token")
        || headers.contains_key("x-zed-outdated-token")
}
```

**Step 3:** Run: `cargo test -p engine zed_bridge` — Expected: PASS.

**Step 4:** Commit:

```bash
git add crates/engine/src/zed_bridge.rs
git commit -m "feat(engine): zed bridge envelope, coercion, family guard"
```

### Task 10: Bridge token lifecycle tests

The Task 9 implementation already contains the full lifecycle (cache, force-refresh on 401/expired headers, sign-in-expired on 401/403 at mint time). This task locks it in with tests.

**Files:**
- Modify: `crates/engine/src/zed_bridge.rs` (tests only)

**Step 1:** Add:

```rust
    #[test]
    fn expired_llm_token_is_recreated_once() {
        let unauthorized = "HTTP/1.1 401 Unauthorized\r\nx-zed-expired-token: true\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned();
        let cloud = FakeCloud::spawn(vec![
            http_ok_json(r#"{"token":"A"}"#),
            unauthorized,
            http_ok_json(r#"{"token":"B"}"#),
            ndjson_ok(&[serde_json::json!({"type":"message_stop"})]),
        ]);
        set_cloud_url_for_tests(Some(cloud.base_url.clone()));
        let bridge = shared_bridge(r#"{"userId":"9","accessToken":"acc"}"#).unwrap();
        let response = post_to_bridge(&bridge, &serde_json::json!({
            "model": "claude-haiku-4-5", "messages": [{ "role": "user", "content": "hi" }]
        }));
        assert!(response.contains("event:"), "{response}");
        let token_mints = cloud
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(line, _)| line.contains("llm_tokens"))
            .count();
        assert_eq!(token_mints, 2, "exactly one recreate");
        set_cloud_url_for_tests(None);
    }

    #[test]
    fn dead_access_token_surfaces_sign_in_expired() {
        let denied = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned();
        let cloud = FakeCloud::spawn(vec![denied]);
        set_cloud_url_for_tests(Some(cloud.base_url.clone()));
        let bridge = shared_bridge(r#"{"userId":"9","accessToken":"dead"}"#).unwrap();
        let response = post_to_bridge(&bridge, &serde_json::json!({
            "model": "claude-haiku-4-5", "messages": []
        }));
        assert!(response.starts_with("HTTP/1.1 502"), "{response}");
        assert!(response.contains("sign-in expired"), "{response}");
        set_cloud_url_for_tests(None);
    }
```

**Step 2:** Run: `cargo test -p engine zed_bridge` — Expected: PASS (all four tests).

**Step 3:** Commit:

```bash
git add crates/engine/src/zed_bridge.rs
git commit -m "test(engine): zed bridge token refresh and sign-in-expired"
```

### Task 11: `ProviderApiStyle::Zed` — model wiring + quirk + driver

**Files:**
- Modify: `crates/engine/src/model.rs` (:42 enum, :47 defaults, `EngineModelInner` ~:100, `EngineModelRef` ~:107, `from_config_with_transport` ~:110, `api_style` ~:163)
- Modify: `crates/engine/src/turn.rs:133` — match arm
- Modify: `crates/engine/src/quirk.rs:48` (hosts), `:728` (fixture parse)
- Modify: `crates/backend/src/driver/tide.rs:795` (`parse_api_style`)
- Test: `crates/engine/src/fixture_tests.rs`

**Step 1:** Failing test in `fixture_tests.rs` — mirror the smallest existing Anthropic fixture test's harness for driving `stream_step`; the fake cloud serves `{"token":"T"}` then a minimal NDJSON assistant turn (copy the event JSON — `message_start`, `content_block_start`, `content_block_delta`/`text_delta`, `content_block_stop`, `message_delta` with usage, `message_stop` — from an existing anthropic SSE fixture's data payloads):

```rust
    #[test]
    fn zed_style_streams_through_the_bridge() {
        // FakeCloud on an ephemeral port; set as the bridge's cloud URL.
        crate::zed_bridge::set_cloud_url_for_tests(Some(fake_cloud_url()));
        let config = EngineModelConfig {
            api_style: ProviderApiStyle::Zed,
            base_url: String::new(), // → zed default
            api_key: r#"{"userId":"1","accessToken":"t"}"#.to_owned(),
            model_id: "claude-haiku-4-5".to_owned(),
            provider_id: "p_zed".to_owned(),
            max_output_tokens: None,
        };
        let model = EngineModel::from_config(&config).unwrap();
        assert_eq!(model.api_style(), ProviderApiStyle::Zed);
        assert_eq!(model.provider_base_url(), "https://cloud.zed.dev");
        // ...drive one stream_step like the anthropic fixture test does;
        // assert the assistant text and Usage arrive.
        crate::zed_bridge::set_cloud_url_for_tests(None);
    }
```

**Step 2:** `model.rs`:

```rust
pub enum ProviderApiStyle {
    Anthropic,
    OpenAi,
    Zed,
}
```

Add `const ZED_DEFAULT_BASE_URL: &str = "https://cloud.zed.dev";` beside the other defaults. New arms:

```rust
enum EngineModelInner {
    Anthropic(rig_core::providers::anthropic::completion::CompletionModel),
    OpenAiCompatible(rig_core::providers::openai::CompletionModel),
    Zed(rig_core::providers::anthropic::completion::CompletionModel),
}
```

`EngineModelRef` gains `Zed(&'a rig_core::providers::anthropic::completion::CompletionModel)`. New `from_config_with_transport` arm:

```rust
            ProviderApiStyle::Zed => {
                let base = normalize_base(&config.base_url, ZED_DEFAULT_BASE_URL);
                // The transport_base_url seam is meaningless for zed: the
                // bridge IS the transport, and tests reroute the cloud side
                // via zed_bridge::set_cloud_url_for_tests instead.
                let bridge = crate::zed_bridge::shared_bridge(&config.api_key)
                    .map_err(EngineError::Config)?;
                let client = rig_core::providers::anthropic::Client::builder()
                    .api_key("zed-bridge".to_owned()) // bridge ignores it
                    .base_url(bridge.base_url().to_owned())
                    .http_client(http)
                    .build()
                    .map_err(|e| EngineError::Config(e.to_string()))?;
                let mut completion_model = client.completion_model(config.model_id.clone());
                if is_native_anthropic_host(Some(base)) {
                    completion_model = completion_model.with_automatic_caching();
                }
                Ok(Self {
                    provider_base_url: base.to_owned(),
                    provider_id: config.provider_id.clone(),
                    model_id: config.model_id.clone(),
                    max_output_tokens: config.max_output_tokens,
                    inner: EngineModelInner::Zed(completion_model),
                })
            }
```

`api_style()` returns `ProviderApiStyle::Zed` for the new arm; `inner_model()` maps `Zed(m) => EngineModelRef::Zed(m)`.

**Step 3:** `turn.rs:133` — add beside the other two:

```rust
            crate::model::EngineModelRef::Zed(m) => m.stream(completion_request).await,
```

**Step 4:** `quirk.rs:48`:

```rust
const THINKING_CAPABLE_HOSTS: [&str; 3] = ["api.anthropic.com", "api.z.ai", "cloud.zed.dev"];
```

and the string parse at `:728` gains `"zed" => ProviderApiStyle::Zed,`. This also turns thinking ON for the zed host at the quirk layer — but **note**: thinking bodies carry `thinking` config that Zed's parser may reject; the Task 17 smoke test must run a thinking-enabled turn, and if it 400s, strip `thinking` in `coerce_block_arrays` (one-line `body.as_object_mut().remove("thinking")`).

**Step 5:** `driver/tide.rs:795` — `parse_api_style` gains `"zed" => Some(ProviderApiStyle::Zed)`. The blob then flows untouched: `tide_api_key` (:1006) decrypts `encrypted_key` → `EngineSelection.api_key` (:442) → `EngineModelConfig` (:3645).

**Step 6:** Run: `cargo test -p engine` and `cargo test -p backend tide` — Expected: PASS.

**Step 7:** Commit:

```bash
git add crates/engine/src/model.rs crates/engine/src/turn.rs crates/engine/src/quirk.rs crates/engine/src/fixture_tests.rs crates/backend/src/driver/tide.rs
git commit -m "feat(engine): ProviderApiStyle::Zed through the bridge"
```

---

## Phase C — UI (preset, wizard, locales)

### Task 12: Zed logo asset + registration

**Files:**
- Create: `assets/icons/logo-zed.svg`
- Modify: `src/ui/brand.rs:39` (add match arm `"logo-zed" => "icons/logo-zed.svg",`)
- Modify: `src/assets.rs:215` (add `"logo-zed",` beside `"logo-ollama",`)

**Step 1:** Create `assets/icons/logo-zed.svg` — placeholder Z-mark (swap for brand art later):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0f0f0f"/><path d="M7.5 7.5h9l-5.5 9h5.5" stroke="#ffffff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

**Step 2:** Register in `brand.rs` and `assets.rs` as above.

**Step 3:** Run: `cargo check` — Expected: clean.

**Step 4:** Commit:

```bash
git add assets/icons/logo-zed.svg src/ui/brand.rs src/assets.rs
git commit -m "feat(assets): zed provider logo"
```

### Task 13: Preset entry, dedupe opt-out, wizard zed state

**Files:**
- Modify: `src/app/tide_providers.rs` — `TIDE_PRESETS` (:34, append after the LM Studio entry), `preset_added` (:246), `TideOpsEvent` (~:289), `TideWizard` (~:357)

**Step 1:** Append the preset:

```rust
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
        // v1: only Claude models speak Anthropic format natively on Zed's
        // cloud — the Models step dims everything else.
        routing: Some(("zed", &["claude"])),
    },
```

**Step 2:** `preset_added` — allow duplicates (personal + VIP orgs side by side):

```rust
pub(crate) fn preset_added(providers: &[TideProviderWire], preset: &TidePreset) -> bool {
    if preset.id == "zed" {
        return false; // org-scoped duplicates are legitimate
    }
    providers
        .iter()
        .any(|provider| provider.base_url == preset.base_url)
}
```

**Step 3:** `TideOpsEvent` gains:

```rust
    ZedSignIn(Result<client::tide::TideZedSignInResult, String>),
```

**Step 4:** Wizard state — add to `tide_providers.rs`:

```rust
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
        let access_token = self.manual_access_token.read(cx).content().trim().to_owned();
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
```

`TideWizard` gains `pub zed: Option<WizardZedState>` and:

```rust
    pub fn is_zed(&self) -> bool {
        self.zed.is_some()
    }

    pub fn zed_blob(&self, cx: &App) -> Option<String> {
        self.zed.as_ref()?.credential_blob(cx)
    }
```

In `TideWizard::new`, initialize:

```rust
            zed: preset.filter(|preset| preset.id == "zed").map(|_| WizardZedState {
                sign_in: None,
                organization_id: None,
                manual_user_id: cx.new(|cx| TextInput::new(window, cx).clear_on_escape().placeholder("605409")),
                manual_access_token: cx.new(|cx| TextInput::new(window, cx).clear_on_escape()),
                busy: false,
            }),
```

Import `App` from gpui (already in scope via `gpui::*`). `tide_open_edit_wizard` (runtime.rs:3330) finds the preset by base URL — `https://cloud.zed.dev` matches, so `TideWizard::new` initializes zed state on edit too.

**Step 5:** Run: `cargo check` — Expected: clean (warning about unused `ZedSignIn` variant is fine until Task 14).

**Step 6:** Commit:

```bash
git add src/app/tide_providers.rs
git commit -m "feat(ui): zed preset, dedupe opt-out, wizard zed state"
```

### Task 14: Runtime handlers — sign-in, continue gate, models fetch, save

**Files:**
- Modify: `src/app/runtime.rs` — wizard region :3290-3760 (`tide_wizard_continue_connect` :3394, `tide_wizard_step` :3452, `tide_refresh_models` :3492, `TideAddProvider` dispatch :3598, the TideOpsEvent pump — grep where `TideOpsEvent::Models` results land)

**Step 1:** Sign-in trigger:

```rust
    /// Zed Connect step: read Zed desktop's credentials via the backend
    /// (macOS keychain) and validate them against cloud.zed.dev.
    pub(super) fn tide_zed_sign_in(&mut self, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_mut() else { return };
        let Some(zed) = wizard.zed.as_mut() else { return };
        zed.busy = true;
        zed.sign_in = None;
        wizard.error = None;
        self.tide_dispatch(client::Command::TideZedSignIn);
        cx.notify();
    }

    /// Org radio row click.
    pub(super) fn tide_zed_pick_org(&mut self, org_id: String, cx: &mut Context<Self>) {
        let Some(wizard) = self.tide.wizard.as_mut() else { return };
        if let Some(zed) = wizard.zed.as_mut() {
            zed.organization_id = Some(org_id);
        }
        cx.notify();
    }
```

**Step 2:** In the TideOpsEvent response pump, add the arm:

```rust
            TideOpsEvent::ZedSignIn(result) => {
                let Some(wizard) = self.tide.wizard.as_mut() else { return };
                let Some(zed) = wizard.zed.as_mut() else { return };
                zed.busy = false;
                match result {
                    Ok(sign_in) => {
                        zed.organization_id = sign_in.default_organization_id.clone();
                        zed.sign_in = Some(sign_in);
                    }
                    Err(error) => wizard.error = Some(error),
                }
                cx.notify();
            }
```

**Step 3:** `tide_wizard_continue_connect` — zed branch before the base-URL guard:

```rust
        if wizard.is_zed() {
            let editing = wizard.edit_provider_id.is_some();
            if wizard.zed_blob(cx).is_none() && !editing {
                self.tide_wizard_error(cx, tr!("tide.zed_error_credentials"));
                return;
            }
            if let Some(wizard) = self.tide.wizard.as_mut() {
                wizard.tested = true; // the sign-in (or stored key) IS the test
                wizard.error = None;
            }
            self.tide_wizard_step(super::tide_providers::TideWizardStep::Models, cx);
            return;
        }
```

**Step 4:** `tide_wizard_step` and `tide_refresh_models` — the blob replaces the api-key input for zed, and an editing wizard without a fresh blob skips the fetch (keeps stored models):

```rust
        let api_key = if wizard.is_zed() {
            wizard.zed_blob(cx).unwrap_or_default()
        } else {
            wizard.api_key.read(cx).content().trim().to_owned()
        };
```

In `tide_wizard_step`, when `api_key.is_empty() && wizard.is_zed()` → just set the step (no dispatch). In `tide_refresh_models`, empty zed blob → set `fetching = false` and error "sign in again to refresh" (or reuse the wizard error row).

**Step 5:** Save — at the `TideAddProvider` dispatch (~:3598), compute the api_key argument the same way (blob for zed, input content otherwise), passing `Some(blob)` for zed when present; when editing zed without a fresh sign-in, pass `None` so the stored key is kept (`update_provider` treats `Some(empty)` as clear, `None` as keep — check the call site's current shape and preserve that semantics).

**Step 6:** Run: `cargo check` — Expected: clean.

**Step 7:** Commit:

```bash
git add src/app/runtime.rs
git commit -m "feat(ui): zed sign-in flow, continue gate, models and save wiring"
```

### Task 15: Connect-step render — sign-in button, account line, org picker

**Files:**
- Modify: `src/app/tide_wizard.rs` — `render_tide_wizard_connect` (:606), `render_tide_wizard_review` (:936)

**Step 1:** At the top of `render_tide_wizard_connect`, branch on `wizard.is_zed()`; the shared `field` closure stays. The zed body:

```rust
    fn render_tide_wizard_connect(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let wizard = self.tide.wizard.as_ref().expect("wizard open");
        // ...existing `field` closure...
        if wizard.is_zed() {
            return self.render_tide_wizard_connect_zed(theme, cx);
        }
        // ...existing body unchanged...
    }

    fn render_tide_wizard_connect_zed(&self, theme: &Theme, cx: &mut Context<Self>) -> Div {
        let wizard = self.tide.wizard.as_ref().expect("wizard open");
        let zed = wizard.zed.as_ref().expect("zed state present");
        let field = |label: String, input: Entity<crate::input::TextInput>| {
            div().flex().flex_col().gap(px(4.0))
                .child(div().text_size(sp(11.5)).font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_secondary).child(label))
                .child(TextField::new("tide-wizard-field", input).w(px(430.0)))
        };
        let mut body = div().p(px(20.0)).flex().flex_col().gap(px(10.0)).flex_1()
            .child(field(tr!("tide.field_name"), wizard.name.clone()));

        if let Some(sign_in) = &zed.sign_in {
            body = body.child(
                div().text_size(sp(12.5)).text_color(theme.text_secondary).child(
                    tr!("tide.zed_signed_in_as",
                        name = sign_in.display_name.clone().unwrap_or_else(|| sign_in.username.clone()),
                        username = sign_in.username.clone()),
                ),
            );
            if sign_in.organizations.len() > 1 {
                body = body.child(
                    div().text_size(sp(11.5)).font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_secondary).child(tr!("tide.zed_org")),
                );
                for org in &sign_in.organizations {
                    let selected = match &zed.organization_id {
                        Some(id) => id == &org.id,
                        None => sign_in.default_organization_id.as_deref() == Some(org.id.as_str()),
                    };
                    let mut row = div()
                        .id(SharedString::from(format!("tide-zed-org-{}", org.id)))
                        .tab_index(0)
                        .focus_visible(|el| el.border_color(theme.accent))
                        .px(px(8.0)).h(px(30.0)).rounded(px(6.0))
                        .border_1()
                        .border_color(if selected { theme.accent } else { theme.border_strong })
                        .flex().items_center().gap(px(8.0)).cursor_default()
                        .hover(|el| el.bg(theme.raised))
                        .child(checkbox(selected, false, theme))
                        .child(div().text_size(sp(12.0)).text_color(theme.text)
                            .child(org.name.clone()));
                    if org.is_personal {
                        row = row.child(div().text_size(sp(10.5)).text_color(theme.text_ghost)
                            .child(tr!("tide.zed_personal")));
                    }
                    if let Some(plan) = &org.plan {
                        row = row.child(div().text_size(sp(10.5)).text_color(theme.text_tertiary)
                            .child(plan.clone()));
                    }
                    let org_id = org.id.clone();
                    body = body.child(row.on_click(cx.listener(move |this, _, _, cx| {
                        this.tide_zed_pick_org(org_id.clone(), cx);
                    })));
                }
            }
            body = body.child(sign_in_button(zed.busy, theme, cx)); // "sign in again"
        } else {
            body = body
                .child(sign_in_button(zed.busy, theme, cx))
                .child(field(tr!("tide.zed_field_user_id"), zed.manual_user_id.clone()))
                .child(field(tr!("tide.zed_field_access_token"), zed.manual_access_token.clone()))
                .child(div().text_size(sp(11.0)).text_color(theme.text_ghost)
                    .child(tr!("tide.zed_manual_hint")));
        }
        // Same tail as the generic path: testing row + error row.
        if wizard.testing || zed.busy {
            body = body.child(div().text_size(sp(11.5)).text_color(theme.text_ghost)
                .child(tr!("tide.zed_signing_in")));
        }
        if let Some(error) = &wizard.error {
            body = body.child(div().text_size(sp(12.0)).text_color(theme.danger).child(error.clone()));
        }
        body
    }
```

With a small helper (file scope) — mirror the existing "tide-auto-detect" button styling:

```rust
fn sign_in_button(busy: bool, theme: &Theme, cx: &mut Context<crate::app::Tide>) -> Div {
    div()
        .id("tide-zed-sign-in")
        .tab_index(0)
        .focus_visible(|el| el.border_color(theme.accent))
        .h(px(28.0)).px(px(12.0)).rounded(px(6.0))
        .border_1().border_color(theme.border_strong)
        .flex().items_center().gap(px(6.0)).cursor_default()
        .text_size(sp(12.0)).text_color(theme.text_secondary)
        .hover(|el| el.bg(theme.raised))
        .child(icon("icons/key.svg", theme).size_3()) // any suitable asset
        .child(tr!(if busy { "tide.zed_signing_in" } else { "tide.zed_sign_in" }))
        .on_click(cx.listener(|this, _, _, cx| this.tide_zed_sign_in(cx)))
}
```

(If `icon("icons/key.svg")` doesn't fit the `icon` helper's signature, drop the icon child — label only. Check `src/app/tide_wizard.rs`'s existing icon usage.)

**Step 2:** Review step (:936): where it renders the key/status line, for zed show the org + username instead of a key hint — read `wizard.zed` and render `Signed in as @username · org name`; skip the "API key stored" line.

**Step 3:** Run: `cargo check` — Expected: clean. Manual visual check happens in Task 17.

**Step 4:** Commit:

```bash
git add src/app/tide_wizard.rs
git commit -m "feat(ui): zed connect step with sign-in and org picker"
```

### Task 16: Locale strings

**Files:**
- Modify: `locales/app.yml`, `locales/zh-CN.yml`, `locales/ja.yml` — append inside the existing `tide:` block (match its indentation exactly; `src/lib.rs:5-9` pins these files into the i18n registry)

**Step 1:** English keys:

```yaml
    zed_sign_in: "Use Zed desktop sign-in"
    zed_signing_in: "Signing in to Zed…"
    zed_signed_in_as: "Signed in as %{name} (@%{username})"
    zed_org: "Organization"
    zed_personal: "personal"
    zed_field_user_id: "User ID"
    zed_field_access_token: "Access token"
    zed_manual_hint: "Automatic sign-in uses Zed desktop's keychain credentials on this Mac. Otherwise paste the two values printed by zed-openai-api's extract-credentials script."
    zed_error_credentials: "Sign in with Zed desktop — or paste both credentials — to continue."
```

Chinese (zh-CN):

```yaml
    zed_sign_in: "使用 Zed 桌面版登录"
    zed_signing_in: "正在登录 Zed…"
    zed_signed_in_as: "已登录为 %{name}（@%{username}）"
    zed_org: "组织"
    zed_personal: "个人"
    zed_field_user_id: "用户 ID"
    zed_field_access_token: "访问令牌"
    zed_manual_hint: "自动登录使用本机 Zed 桌面版的钥匙串凭据；否则请粘贴 zed-openai-api 的 extract-credentials 脚本输出的两个值。"
    zed_error_credentials: "请使用 Zed 桌面版登录，或粘贴两项凭据后继续。"
```

Japanese (ja):

```yaml
    zed_sign_in: "Zed デスクトップでサインイン"
    zed_signing_in: "Zed にサインイン中…"
    zed_signed_in_as: "%{name}（@%{username}）としてサインイン済み"
    zed_org: "組織"
    zed_personal: "個人"
    zed_field_user_id: "ユーザー ID"
    zed_field_access_token: "アクセストークン"
    zed_manual_hint: "自動サインインはこの Mac の Zed デスクトップのキーチェーン資格情報を使います。それ以外は zed-openai-api の extract-credentials スクリプトが出力する 2 つの値を貼り付けてください。"
    zed_error_credentials: "Zed デスクトップでサインインするか、両方の資格情報を貼り付けてください。"
```

**Step 2:** Run: `cargo check` — Expected: clean (rust-i18n re-expands the YAML).

**Step 3:** Commit:

```bash
git add locales/app.yml locales/zh-CN.yml locales/ja.yml
git commit -m "feat(i18n): zed provider wizard strings"
```

---

## Phase D — verification

### Task 17: Full verification + live smoke

**Files:**
- Modify: `docs/plans/2026-09-11-zed-native-provider-design.md` (append the smoke-run results)

**Step 1:** `cargo test -p protocol -p backend -p engine` — Expected: PASS.

**Step 2:** `cargo clippy -p protocol -p backend -p engine --lib` — Expected: no new warnings from the touched files.

**Step 3:** Live smoke — run the app (`bun ./scripts/dev.ts` or the current debug build), then:
1. Providers → Add Provider → the Zed tile appears among aggregators (twice-addable).
2. Click Zed → Connect shows the sign-in button (no key/URL fields). Click it → macOS keychain prompt may appear → account line + org picker render (personal + Zed VIP on this machine), VIP preselected.
3. Continue → Models lists Claude models with live context windows; non-Claude rows dimmed by routing.
4. Select claude-sonnet-5 → Review → Add. A provider "Zed" exists with `api_style: "zed"` in `~/.tide/config.json` and an `encrypted_key` blob.
5. Start a session on `Zed/claude-sonnet-5`, send a prompt — a streamed reply arrives. Confirm in the timeline that usage/tokens render.
6. Thinking check: run a turn with thinking enabled; if the cloud 400s, apply the Task 11 note (strip `thinking` in `coerce_block_arrays`) and note it in the design doc.
7. Re-auth check: `security delete-internet-password -s https://zed.dev` is destructive — skip deleting; instead trust the Task 10 test for the expired path.
8. First-token latency: if noticeably slower than direct Anthropic, convert `read_ndjson` to incremental chunk writing (noted in Task 9).

**Step 4:** Append findings (thinking 400 or not, latency) to the design doc's "Verified API facts" section.

**Step 5:** Commit:

```bash
git add docs/plans/2026-09-11-zed-native-provider-design.md
git commit -m "docs: zed provider smoke-run findings"
```

---

## Follow-ups (explicitly out of scope)

- GPT / Gemini models via Responses-API and Gemini-format conversion in the bridge (preset `routing` needles widen after).
- Incremental NDJSON→SSE streaming (Task 9 note) if buffering latency shows up.
- Server-side compaction / `cloud-thinking-effort` / `open-ai-responses-api` feature flags from `/client/users/me`.
- Zed API churn monitoring: the `x-zed-outdated-token` machinery suggests versioned behavior; pin/bump `ZED_VERSION` when the cloud rejects.
