//! Durable references for daemon-owned binary task payloads.

/// Scheme for a stored blob reference, e.g. `tide-blob:3f2a...c1.png`.
pub const SCHEME: &str = "tide-blob:";

/// Persisted references written before the Tide rename keep this spelling.
pub const LEGACY_SCHEME: &str = "waku-blob:";

pub fn is_reference(value: &str) -> bool {
    value.starts_with(SCHEME) || value.starts_with(LEGACY_SCHEME)
}
