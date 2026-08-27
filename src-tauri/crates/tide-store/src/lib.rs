//! rusqlite sessions-v2/config/RAG index (in-place ~/.tide).

pub mod config;
pub mod paths;
pub mod secrets;
pub mod sessions_v2;
pub mod sessions_v2_write;
pub mod usage;

#[cfg(test)]
mod tests {
    #[test]
    fn crate_version_matches_workspace() {
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.4.0");
    }
}
