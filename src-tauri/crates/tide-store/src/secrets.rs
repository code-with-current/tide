//! Keychain reads using the exact item naming `app/platform/secrets.ts` @
//! 91ec558 wrote: service `tide`, account `kcv2-<accountId>` for v2 handles
//! (or the raw account embedded in a `kcv1:` legacy handle). The stored item
//! data is a hex envelope of the secret (`-` for the empty string), never the
//! raw bytes. The config's `encryptedKey` is base64 of the
//! `kcv2:<accountId>:<salt>:<verifier>` handle; verifier is
//! sha256(salt || plaintext) hex truncated to 32 chars.
//!
//! Reads go through the `security` CLI exactly like the TS did: the items'
//! ACLs trust the CLI binary, so keys resolve without a per-app macOS
//! authorization prompt (an in-process read via the keyring crate prompts,
//! and ad-hoc-signed dev rebuilds would re-trigger it).

use std::fmt;

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::config::Config;

pub const KEYCHAIN_SERVICE: &str = "tide";
const HANDLE_PREFIX: &str = "kcv2";
const LEGACY_HANDLE_PREFIX: &str = "kcv1";
const ACCOUNT_INFIX: &str = "kcv2-";
const EMPTY_ENVELOPE: &str = "-";

#[derive(Debug)]
pub enum SecretsError {
    /// Stored key or keychain data is structurally invalid.
    Malformed(String),
    /// Legacy Electron safeStorage blob — the TS key-migration path must run
    /// before this key can resolve.
    V10MigrationRequired,
    /// Keychain access failed (locked, denied, unavailable backend).
    Access(String),
    /// Handle verifier does not match the keychain plaintext.
    VerificationMismatch,
}

impl fmt::Display for SecretsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretsError::Malformed(m) => write!(f, "malformed secret: {m}"),
            SecretsError::V10MigrationRequired => {
                write!(f, "legacy Electron v10 blob (migration required)")
            }
            SecretsError::Access(m) => write!(f, "keychain access failed: {m}"),
            SecretsError::VerificationMismatch => write!(f, "keychain verification mismatch"),
        }
    }
}

impl std::error::Error for SecretsError {}

pub type SecretsResult<T> = Result<T, SecretsError>;

/// Resolve a provider's API key. An unknown provider, absent/empty stored
/// key, or missing keychain item → `Ok(None)`; only keychain access failures
/// and corrupt handles are errors.
pub fn get_api_key(config: &Config, provider_id: &str) -> SecretsResult<Option<String>> {
    let Some(provider) = config.provider(provider_id) else {
        return Ok(None);
    };
    let Some(stored) = provider.encrypted_key.as_deref() else {
        return Ok(None);
    };
    if stored.is_empty() {
        return Ok(None);
    }
    decrypt_stored(stored)
}

/// Named third-party secrets discoverable from config (the keychain itself is
/// not enumerable); provider ids come from `config.providers`.
pub fn list_known(config: &Config) -> Vec<String> {
    config
        .secrets
        .as_ref()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

pub fn decrypt_stored(stored: &str) -> SecretsResult<Option<String>> {
    decrypt_with(real_keychain_get, stored)
}

fn decrypt_with(
    read: impl Fn(&str) -> SecretsResult<Option<String>>,
    stored: &str,
) -> SecretsResult<Option<String>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(stored)
        .map_err(|e| SecretsError::Malformed(format!("invalid base64 encryptedKey: {e}")))?;
    if is_v10_blob(&bytes) {
        return Err(SecretsError::V10MigrationRequired);
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if let Some(account) = text.strip_prefix(&format!("{LEGACY_HANDLE_PREFIX}:")) {
        // kcv1 items hold the value raw, no envelope decode (matches TS).
        return read(account);
    }
    if let Some(handle) = text.strip_prefix(&format!("{HANDLE_PREFIX}:")) {
        let parts: Vec<&str> = handle.split(':').collect();
        let valid = parts.len() == 3
            && parts
                .iter()
                .all(|f| f.len() == 32 && f.bytes().all(|b| b.is_ascii_hexdigit()));
        if !valid {
            return Err(SecretsError::Malformed("malformed kcv2 secret handle".into()));
        }
        let (account_id, salt_hex, verifier) = (parts[0], parts[1], parts[2]);
        let Some(data) = read(&format!("{ACCOUNT_INFIX}{account_id}"))? else {
            return Ok(None);
        };
        let plain = from_envelope(&data)?;
        let salt = hex_decode(salt_hex)
            .ok_or_else(|| SecretsError::Malformed("malformed kcv2 salt".into()))?;
        if verification_value(&salt, &plain) != verifier {
            return Err(SecretsError::VerificationMismatch);
        }
        return Ok(Some(plain));
    }
    // Plaintext passthrough (stored while no keychain backend was available).
    Ok(Some(text))
}

fn real_keychain_get(account: &str) -> SecretsResult<Option<String>> {
    // Off darwin the TS backend was an honest null stub; absent key, not error.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        return Ok(None);
    }
    #[cfg(target_os = "macos")]
    {
        cli_keychain_get(account)
    }
}

/// Port of the TS `keychainRead`: one-shot `security find-generic-password`
/// read; the value comes back on stdout and never touches argv. A missing
/// item exits 44 with "could not be found".
#[cfg(target_os = "macos")]
fn cli_keychain_get(account: &str) -> SecretsResult<Option<String>> {
    use std::process::Command;
    let output = Command::new("security")
        .arg("find-generic-password")
        .arg("-s")
        .arg(KEYCHAIN_SERVICE)
        .arg("-a")
        .arg(account)
        .arg("-w")
        .output()
        .map_err(|e| SecretsError::Access(format!("failed to launch security: {e}")))?;
    if output.status.success() {
        let mut data = String::from_utf8_lossy(&output.stdout).into_owned();
        if data.ends_with('\n') {
            data.pop();
            if data.ends_with('\r') {
                data.pop();
            }
        }
        return Ok(Some(data));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.code() == Some(44) || stderr.to_lowercase().contains("could not be found") {
        return Ok(None);
    }
    Err(SecretsError::Access(format!(
        "keychain read failed for account {account}: {stderr}"
    )))
}

/// Structural v10 check ported from key-migration.ts: 3-byte ASCII prefix +
/// at least one AES block.
fn is_v10_blob(bytes: &[u8]) -> bool {
    bytes.len() >= 3 + 16 && (bytes.len() - 3).is_multiple_of(16) && &bytes[..3] == b"v10"
}

fn from_envelope(data: &str) -> SecretsResult<String> {
    if data == EMPTY_ENVELOPE {
        return Ok(String::new());
    }
    let Some(bytes) = hex_decode(data) else {
        return Err(SecretsError::Malformed(
            "keychain item does not hold a tide secret envelope".into(),
        ));
    };
    String::from_utf8(bytes)
        .map_err(|_| SecretsError::Malformed("secret envelope is not valid utf-8".into()))
}

fn verification_value(salt: &[u8], plain: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(plain.as_bytes());
    hex_encode(&hasher.finalize())[..32].to_owned()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[usize::from(b >> 4)] as char);
        out.push(HEX[usize::from(b & 0x0f)] as char);
    }
    out
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    fn b64(s: &str) -> String {
        STANDARD.encode(s)
    }

    fn reader_with(data: &str) -> impl Fn(&str) -> SecretsResult<Option<String>> + '_ {
        move |account: &str| {
            assert!(account.starts_with("kcv2-"), "unexpected account {account}");
            Ok(Some(data.to_string()))
        }
    }

    #[test]
    fn absent_key_is_none() {
        let cfg: Config = serde_json::from_str(
            r#"{"providers":[{"id":"p1","name":"n","apiStyle":"openai","baseUrl":"u","enabled":true,"models":[]}]}"#,
        )
        .unwrap();
        assert_eq!(get_api_key(&cfg, "p1").unwrap(), None);
        assert_eq!(get_api_key(&cfg, "nope").unwrap(), None);
        let cfg_empty: Config = serde_json::from_str(
            r#"{"providers":[{"id":"p1","name":"n","apiStyle":"openai","baseUrl":"u","encryptedKey":"","enabled":true,"models":[]}]}"#,
        )
        .unwrap();
        assert_eq!(get_api_key(&cfg_empty, "p1").unwrap(), None);
    }

    #[test]
    fn plaintext_passthrough() {
        assert_eq!(
            decrypt_with(|_| panic!("passthrough never reads keychain"), &b64("sk-plain"))
                .unwrap(),
            Some("sk-plain".to_string())
        );
    }

    #[test]
    fn v10_blob_requires_migration() {
        let mut blob = b"v10".to_vec();
        blob.extend_from_slice(&[0u8; 16]);
        assert!(matches!(
            decrypt_with(|_| panic!(), &STANDARD.encode(blob)),
            Err(SecretsError::V10MigrationRequired)
        ));
    }

    #[test]
    fn kcv2_handle_resolves_and_verifies() {
        let account = "0123456789abcdef0123456789abcdef";
        let salt = [0xabu8; 16];
        let plain = "sk-live-key";
        let handle = format!(
            "kcv2:{account}:{}:{}",
            hex_encode(&salt),
            verification_value(&salt, plain)
        );
        let envelope = hex_encode(plain.as_bytes());
        assert_eq!(
            decrypt_with(reader_with(&envelope), &b64(&handle)).unwrap(),
            Some(plain.to_string())
        );

        let empty_handle = format!(
            "kcv2:{account}:{}:{}",
            hex_encode(&salt),
            verification_value(&salt, "")
        );
        assert_eq!(
            decrypt_with(reader_with("-"), &b64(&empty_handle)).unwrap(),
            Some(String::new())
        );
    }

    #[test]
    fn kcv2_verifier_mismatch_errors() {
        let salt = [0x11u8; 16];
        let mut verifier = verification_value(&salt, "real");
        let last = verifier.pop().unwrap();
        verifier.push(if last == 'a' { 'b' } else { 'a' });
        let handle = format!("kcv2:{}:{}:{verifier}", "f".repeat(32), hex_encode(&salt));
        let envelope = hex_encode(b"other");
        assert!(matches!(
            decrypt_with(reader_with(&envelope), &b64(&handle)),
            Err(SecretsError::VerificationMismatch)
        ));
    }

    #[test]
    fn kcv2_malformed_handle_errors() {
        let short = b64("kcv2:zz:aa:bb");
        assert!(matches!(
            decrypt_with(|_| Ok(None), &short),
            Err(SecretsError::Malformed(_))
        ));
        let bad_b64 = "!!!not-base64!!!";
        assert!(matches!(
            decrypt_stored(bad_b64),
            Err(SecretsError::Malformed(_))
        ));
    }

    #[test]
    fn kcv2_missing_item_is_none_and_bad_envelope_errors() {
        let handle = format!("kcv2:{}:{}:{}", "a".repeat(32), "b".repeat(32), "c".repeat(32));
        assert_eq!(
            decrypt_with(|_| Ok(None), &b64(&handle)).unwrap(),
            None,
            "missing keychain item is an absent key, not an error"
        );
        let tamper_handle = format!("kcv2:{}:{}:{}", "a".repeat(32), "b".repeat(32), "c".repeat(32));
        assert!(matches!(
            decrypt_with(reader_with("not-hex!"), &b64(&tamper_handle)),
            Err(SecretsError::Malformed(_))
        ));
    }

    #[test]
    fn kcv1_legacy_read_is_raw() {
        assert_eq!(
            decrypt_with(|account| {
                assert_eq!(account, "legacyacct");
                Ok(Some("raw-value".to_string()))
            }, &b64("kcv1:legacyacct"))
            .unwrap(),
            Some("raw-value".to_string())
        );
        assert_eq!(
            decrypt_with(|_| Ok(None), &b64("kcv1:gone")).unwrap(),
            None
        );
    }

    #[test]
    fn list_known_enumerates_config_secret_names() {
        let cfg: Config =
            serde_json::from_str(r#"{"secrets":{"web_search":"enc","github":"enc2"}}"#).unwrap();
        assert_eq!(list_known(&cfg), vec!["github".to_string(), "web_search".to_string()]);
        assert!(list_known(&Config::default()).is_empty());
    }

    // Reads the user's REAL ~/.tide/config.json and keychain; run explicitly:
    //   cargo test -p tide-store -- --ignored
    #[test]
    #[ignore = "touches the real ~/.tide and macOS keychain (M1 homecoming check)"]
    fn live_keychain_resolves_real_provider_keys() {
        let cfg = crate::config::load(&crate::paths::config_path()).expect("load real config");
        if cfg.providers.is_empty() {
            eprintln!("live check: no providers in real config — nothing to resolve");
            return;
        }
        let expected: Vec<&str> = cfg
            .providers
            .iter()
            .filter(|p| p.encrypted_key.as_deref().is_some_and(|k| !k.is_empty()))
            .map(|p| p.id.as_str())
            .collect();
        let mut resolved = 0usize;
        for p in &cfg.providers {
            match get_api_key(&cfg, &p.id) {
                Ok(Some(key)) => {
                    resolved += 1;
                    eprintln!("live check: provider {} resolved ({} chars)", p.id, key.chars().count());
                }
                Ok(None) => eprintln!("live check: provider {} has no stored key", p.id),
                Err(e) => panic!("live check: provider {} failed: {e}", p.id),
            }
        }
        assert_eq!(resolved, expected.len(), "every stored key must resolve from the real keychain");
    }
}
