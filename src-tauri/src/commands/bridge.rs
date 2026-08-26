//! Bridge handshake + runtime probe. `tide_ping` predates the bridge (M0
//! splash badge + renderer tests reference it); `bridge_version` is the M1
//! handshake the renderer bridge invokes before installing itself.

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

/// Version of the bridge command surface (names + arg shapes of the M1
/// domains). The renderer refuses to install on any other value.
pub const BRIDGE_PROTOCOL: u32 = 1;

#[derive(Serialize, Debug)]
pub struct BridgeVersion {
    pub version: String,
    pub protocol: u32,
}

#[tauri::command]
pub fn bridge_version() -> BridgeVersion {
    BridgeVersion {
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol: BRIDGE_PROTOCOL,
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

    #[test]
    fn bridge_version_is_protocol_one_with_app_version() {
        let handshake = bridge_version();
        assert_eq!(handshake.protocol, 1);
        assert_eq!(handshake.version, env!("CARGO_PKG_VERSION"));
    }
}
