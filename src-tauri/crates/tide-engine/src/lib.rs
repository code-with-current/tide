//! rig agent engine — the ONLY crate permitted to depend on rig (churn firewall).

#[cfg(test)]
mod tests {
    #[test]
    fn crate_version_matches_workspace() {
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.4.0");
    }
}
