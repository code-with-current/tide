//! Keychain reads AND writes using the exact item naming
//! `app/platform/secrets.ts` used: service `tide`, account
//! `kcv2-<accountId>` for v2 handles (or the raw account embedded in a
//! `kcv1:` legacy handle). The stored item data is a hex envelope of the
//! secret (`-` for the empty string), never the raw bytes. The config's
//! `encryptedKey` is base64 of the `kcv2:<accountId>:<salt>:<verifier>`
//! handle; verifier is sha256(salt || plaintext) hex truncated to 32 chars.
//!
//! Both directions go through the `security` CLI exactly like the TS did:
//! the items' ACLs trust the CLI binary, so keys resolve without a per-app
//! macOS authorization prompt (an in-process read via the keyring crate
//! prompts, and ad-hoc-signed dev rebuilds would re-trigger it). Writes
//! use the interactive `security -i` session the TS relied on — commands
//! on stdin, so the secret never appears in argv (`ps`-visible), and a
//! failed head-of-batch delete (item missing) is harmless because the
//! session's exit status reflects the last command. `add-generic-password
//! -X <hex>` must carry the envelope hex-encoded twice and `-X` stays the
//! LAST option (an empty payload would otherwise swallow the next token).

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
/// not enumerable); provider ids come from `config.providers`. Sorted so the
/// list is deterministic regardless of `serde_json`'s map ordering (the
/// `preserve_order` feature flips it from sorted to insertion order).
pub fn list_known(config: &Config) -> Vec<String> {
    let mut names: Vec<String> = config
        .secrets
        .as_ref()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
}

pub fn decrypt_stored(stored: &str) -> SecretsResult<Option<String>> {
    decrypt_with(real_keychain_get, stored)
}

// ── write side (the kcv2 envelope + keychain item creation) ─────────

/// Stored keychain data for a value: hex of the utf8 bytes, `-` for the
/// empty string (an empty `-X` payload is not expressible — see header).
#[cfg(any(target_os = "macos", test))]
fn to_envelope(value: &str) -> String {
    if value.is_empty() {
        EMPTY_ENVELOPE.to_owned()
    } else {
        hex_encode(value.as_bytes())
    }
}

/// The `-X` argument: the envelope string hex-encoded once more, so the
/// bytes `security` decodes-and-stores are always printable ASCII hex.
#[cfg(any(target_os = "macos", test))]
fn keychain_payload(value: &str) -> String {
    hex_encode(to_envelope(value).as_bytes())
}

/// Interactive-mode accounts must be single tokens: the `-i` tokenizer has
/// no quoting, so whitespace/control characters would split or inject
/// commands (port of the TS `assertTokenSafe`).
#[cfg(any(target_os = "macos", test))]
fn assert_token_safe(account: &str) -> SecretsResult<()> {
    let ok =
        (1..=512).contains(&account.len()) && account.bytes().all(|b| (0x21..=0x7e).contains(&b));
    if ok {
        Ok(())
    } else {
        Err(SecretsError::Malformed(format!(
            "invalid keychain account name: {:?}",
            &account[..account.len().min(40)]
        )))
    }
}

/// OS randomness for the per-write account id + salt. /dev/urandom is the
/// only source this crate needs — the keychain write path runs on macOS.
#[cfg(target_os = "macos")]
fn random_bytes(n: usize) -> SecretsResult<Vec<u8>> {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| SecretsError::Access(format!("reading /dev/urandom failed: {e}")))?;
    Ok(buf)
}

/// The kcv2 handle math + keychain item creation, with the randomness and
/// the keychain write injected so tests verify the envelope without
/// touching the real keychain. Returns the base64 `encryptedKey` to store
/// in config.json.
#[cfg(any(target_os = "macos", test))]
fn encrypt_handle_with(
    random: impl Fn(usize) -> SecretsResult<Vec<u8>>,
    mut keychain_set: impl FnMut(&str, &str) -> SecretsResult<()>,
    value: &str,
) -> SecretsResult<String> {
    let account_id = hex_encode(&random(16)?);
    let salt = random(16)?;
    let verifier = verification_value(&salt, value);
    let account = format!("{ACCOUNT_INFIX}{account_id}");
    keychain_set(&account, &keychain_payload(value))?;
    let handle = format!(
        "{HANDLE_PREFIX}:{account_id}:{}:{verifier}",
        hex_encode(&salt)
    );
    Ok(base64::engine::general_purpose::STANDARD.encode(handle))
}

/// Port of the TS `keychainSet`: delete-then-add inside one `security -i`
/// session fed via stdin (secrets never in argv). A missing item on the
/// delete is harmless — the add still runs and the session's exit status
/// reflects the add.
#[cfg(target_os = "macos")]
fn cli_keychain_set(account: &str, payload: &str) -> SecretsResult<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    assert_token_safe(account)?;
    let script = format!(
        "delete-generic-password -a {account} -s {KEYCHAIN_SERVICE}\n\
         add-generic-password -a {account} -s {KEYCHAIN_SERVICE} -U -X {payload}\n"
    );
    let mut child = Command::new("security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| SecretsError::Access(format!("failed to launch security: {e}")))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| SecretsError::Access(format!("keychain write failed: {e}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| SecretsError::Access(format!("keychain write failed: {e}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(SecretsError::Access(format!(
        "keychain write failed for account {account}: {stderr}"
    )))
}

/// Encrypt an API key for storage in config.json (the TS store.ts
/// `crypto.encrypt`). Empty string → empty string (no item written); on
/// macOS the key lands in the keychain under a fresh `kcv2-<accountId>`
/// item and the return value is the base64 handle; on other platforms —
/// where the TS backend was an honest null stub that stored plaintext —
/// this stores base64(plaintext) so this crate's read path (which always
/// base64-decodes before its plaintext passthrough) round-trips.
pub fn encrypt_stored(value: &str) -> SecretsResult<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    encrypt_stored_impl(value)
}

#[cfg(not(target_os = "macos"))]
fn encrypt_stored_impl(value: &str) -> SecretsResult<String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(value))
}

#[cfg(target_os = "macos")]
fn encrypt_stored_impl(value: &str) -> SecretsResult<String> {
    encrypt_handle_with(random_bytes, cli_keychain_set, value)
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
            return Err(SecretsError::Malformed(
                "malformed kcv2 secret handle".into(),
            ));
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

#[cfg(not(target_os = "macos"))]
fn real_keychain_get(_account: &str) -> SecretsResult<Option<String>> {
    // Off darwin the TS backend was an honest null stub; absent key, not error.
    Ok(None)
}

#[cfg(target_os = "macos")]
fn real_keychain_get(account: &str) -> SecretsResult<Option<String>> {
    cli_keychain_get(account)
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
            decrypt_with(
                |_| panic!("passthrough never reads keychain"),
                &b64("sk-plain")
            )
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
        let handle = format!(
            "kcv2:{}:{}:{}",
            "a".repeat(32),
            "b".repeat(32),
            "c".repeat(32)
        );
        assert_eq!(
            decrypt_with(|_| Ok(None), &b64(&handle)).unwrap(),
            None,
            "missing keychain item is an absent key, not an error"
        );
        let tamper_handle = format!(
            "kcv2:{}:{}:{}",
            "a".repeat(32),
            "b".repeat(32),
            "c".repeat(32)
        );
        assert!(matches!(
            decrypt_with(reader_with("not-hex!"), &b64(&tamper_handle)),
            Err(SecretsError::Malformed(_))
        ));
    }

    #[test]
    fn kcv1_legacy_read_is_raw() {
        assert_eq!(
            decrypt_with(
                |account| {
                    assert_eq!(account, "legacyacct");
                    Ok(Some("raw-value".to_string()))
                },
                &b64("kcv1:legacyacct")
            )
            .unwrap(),
            Some("raw-value".to_string())
        );
        assert_eq!(decrypt_with(|_| Ok(None), &b64("kcv1:gone")).unwrap(), None);
    }

    #[test]
    fn list_known_enumerates_config_secret_names() {
        let cfg: Config =
            serde_json::from_str(r#"{"secrets":{"web_search":"enc","github":"enc2"}}"#).unwrap();
        assert_eq!(
            list_known(&cfg),
            vec!["github".to_string(), "web_search".to_string()]
        );
        assert!(list_known(&Config::default()).is_empty());
    }

    // ── write side ──────────────────────────────────────────────────

    /// Deterministic randomness: 0x00.. for the first call, 0xff.. for the
    /// second (account id then salt), so handle math is assertable.
    fn fake_random(n: usize, salt: u8) -> SecretsResult<Vec<u8>> {
        Ok(vec![salt; n])
    }

    #[test]
    fn encrypt_builds_a_verifiable_kcv2_handle_and_double_hex_envelope() {
        let mut written: Vec<(String, String)> = Vec::new();
        let handle = encrypt_handle_with(
            |n| fake_random(n, 0xab),
            |account, payload| {
                written.push((account.to_owned(), payload.to_owned()));
                Ok(())
            },
            "sk-live-key",
        )
        .unwrap();
        // Item account is kcv2-<accountId>; payload is hex(hex(plain)).
        assert_eq!(written.len(), 1);
        assert_eq!(
            written[0].0,
            format!("{}{}", "kcv2-", "ab".repeat(16)),
            "account id is hex of the 16 random bytes"
        );
        assert_eq!(
            written[0].1,
            hex_encode(hex_encode(b"sk-live-key").as_bytes())
        );
        // The handle round-trips through the read side.
        assert_eq!(
            decrypt_with(|a| Ok(written_first(&written, a)), &handle).unwrap(),
            Some("sk-live-key".to_owned())
        );
    }

    /// Invert the `-X` double-hex to recover the item data a later
    /// `find-generic-password -w` would echo (the envelope string).
    fn written_first(written: &[(String, String)], account: &str) -> Option<String> {
        written
            .iter()
            .find(|(a, _)| a == account)
            .map(|(_, payload)| String::from_utf8(hex_decode(payload).unwrap()).unwrap())
    }

    #[test]
    fn encrypt_empty_value_stores_empty() {
        assert_eq!(encrypt_stored("").unwrap(), "");
        // The raw handle path (TS encryptString) still writes an item — the
        // EMPTY_ENVELOPE placeholder, since an empty -X payload is not
        // expressible.
        let mut written: Vec<(String, String)> = Vec::new();
        let handle = encrypt_handle_with(
            |n| fake_random(n, 0x01),
            |account, payload| {
                written.push((account.to_owned(), payload.to_owned()));
                Ok(())
            },
            "",
        )
        .unwrap();
        assert_eq!(written[0].1, keychain_payload(""));
        assert_eq!(written[0].1, hex_encode(b"-"));
        assert_eq!(
            decrypt_with(|a| Ok(written_first(&written, a)), &handle).unwrap(),
            Some(String::new())
        );
    }

    #[test]
    fn random_account_and_salt_make_handles_unique_per_write() {
        let make = |seed: u8| {
            encrypt_handle_with(move |n| fake_random(n, seed), |_, _| Ok(()), "same-plain").unwrap()
        };
        assert_ne!(make(0x11), make(0x22), "salt differs → verifier differs");
    }

    #[test]
    fn keychain_write_failure_surfaces_as_access_error() {
        let err = encrypt_handle_with(
            |n| fake_random(n, 0x00),
            |_, _| Err(SecretsError::Access("denied".into())),
            "sk-x",
        )
        .unwrap_err();
        assert!(matches!(err, SecretsError::Access(_)));
    }

    #[test]
    fn token_safety_rejects_whitespace_accounts() {
        assert!(assert_token_safe("kcv2-abc123").is_ok());
        assert!(assert_token_safe("bad account").is_err());
        assert!(assert_token_safe("").is_err());
    }

    // Writes then reads then deletes a REAL keychain item under a random
    // kcv2- account; run explicitly: cargo test -p store -- --ignored
    #[test]
    #[ignore = "writes to the real macOS keychain"]
    fn live_keychain_write_round_trips() {
        let plain = "tide-live-write-check";
        let stored = encrypt_stored(plain).unwrap();
        assert_ne!(stored, plain);
        assert_eq!(decrypt_stored(&stored).unwrap(), Some(plain.to_owned()));
        // Cleanup: recover the account from the handle and delete the item.
        let text = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(&stored)
                .unwrap(),
        )
        .unwrap();
        let account_id = text.split(':').nth(1).unwrap();
        let account = format!("{ACCOUNT_INFIX}{account_id}");
        let out = std::process::Command::new("security")
            .args([
                "delete-generic-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                &account,
            ])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "cleanup delete failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            decrypt_stored(&stored).unwrap(),
            None,
            "item gone after delete"
        );
    }

    // Reads the user's REAL ~/.tide/config.json and keychain; run explicitly:
    //   cargo test -p store -- --ignored
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
                    eprintln!(
                        "live check: provider {} resolved ({} chars)",
                        p.id,
                        key.chars().count()
                    );
                }
                Ok(None) => eprintln!("live check: provider {} has no stored key", p.id),
                Err(e) => panic!("live check: provider {} failed: {e}", p.id),
            }
        }
        assert_eq!(
            resolved,
            expected.len(),
            "every stored key must resolve from the real keychain"
        );
    }
}
