use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct RuntimeInfo {
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
}

#[tauri::command]
pub fn tide_ping() -> RuntimeInfo {
    RuntimeInfo {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_reports_version_and_platform() {
        let info = tide_ping();
        assert!(!info.version.is_empty());
        assert!(!info.os.is_empty());
        assert!(!info.arch.is_empty());
    }
}
