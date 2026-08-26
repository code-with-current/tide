//! `providerList` — backs the TideRPC `providerList` method. Stored providers
//! pass through verbatim (models, limits, and any future fields ride
//! tide-store's flatten-preserved extras) with the keychain joined in: the
//! wire `apiKey` is the decrypted key when one resolves and is omitted
//! otherwise — the renderer derives `hasStoredKey` from its truthiness, the
//! same way it consumed the 91ec558 `crypto.decrypt(...)` result. A key that
//! fails to resolve (e.g. an unmigrated legacy blob) is reported as absent,
//! never a command failure, matching the TS decrypt-to-empty fallback.

use serde_json::Value;
use tide_store::config::StoredProvider;

use crate::state::AppState;

use super::CommandError;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

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
}
