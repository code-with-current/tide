//! The Computer Use execution seam. The native Computer Use tools
//! ([`super::computer_tools`]) ride one helper request
//! (`{ "operation": "call", "tool": ..., "arguments": ... }`) per call;
//! the daemon installs the helper bridge once at boot. Without it (other
//! platforms, helper missing from the bundle) calls fail with a clean
//! "unavailable" outcome instead of a panic.

use std::sync::Arc;

use serde_json::Value;

/// The execution backend behind the Computer Use tools — the seam the
/// daemon fills with the helper bridge. `operation` is one helper request;
/// the response is the helper's `{ success, error?, result?, target?,
/// imageUrl?, summary? }` object verbatim.
pub trait ComputerBackend: std::fmt::Debug + Send + Sync {
    /// The app-level Computer Use toggle (Settings → Computer Use). The
    /// macOS TCC grants stay the hard gate; this is the master switch.
    fn enabled(&self) -> bool;
    fn invoke(&self, operation: &Value) -> Result<Value, String>;
}

static SHARED_BACKEND: std::sync::RwLock<Option<Arc<dyn ComputerBackend>>> =
    std::sync::RwLock::new(None);

/// Install (or clear) the process-wide Computer Use backend.
pub fn set_shared_computer_backend(backend: Option<Arc<dyn ComputerBackend>>) {
    let mut slot = SHARED_BACKEND.write().unwrap();
    *slot = backend;
}

/// The installed backend, when the build shipped the helper and the daemon
/// booted it.
pub fn shared_computer_backend() -> Option<Arc<dyn ComputerBackend>> {
    SHARED_BACKEND.read().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Debug)]
    struct StubBackend(bool);

    impl ComputerBackend for StubBackend {
        fn enabled(&self) -> bool {
            self.0
        }

        fn invoke(&self, operation: &Value) -> Result<Value, String> {
            Ok(json!({ "echo": operation }))
        }
    }

    #[test]
    fn shared_backend_round_trips() {
        set_shared_computer_backend(None);
        assert!(shared_computer_backend().is_none());
        set_shared_computer_backend(Some(Arc::new(StubBackend(true))));
        let backend = shared_computer_backend().unwrap();
        assert!(backend.enabled());
        assert_eq!(
            backend.invoke(&json!({ "operation": "call" })).unwrap()["echo"],
            json!({ "operation": "call" })
        );
        set_shared_computer_backend(None);
        assert!(shared_computer_backend().is_none());
    }
}
