//! The Browser execution seam. The agentic browser tools ride one
//! request (`{ "op": ..., "args": ... }`) per call; the app installs the
//! webview bridge once at boot. Without it calls fail with a clean
//! "unavailable" outcome instead of a panic.

use std::sync::Arc;

use serde_json::Value;

/// The execution backend behind the browser tools — the seam the app
/// fills with the live webview surface. `request` is one browser op plus
/// its args; the response is the op's result JSON verbatim.
pub trait BrowserBackend: std::fmt::Debug + Send + Sync {
    /// No gating source exists yet (design v1): the installed impl
    /// always reports `true` — the settings toggle is out of scope.
    fn enabled(&self) -> bool;
    fn invoke(&self, request: &Value) -> Result<Value, String>;
}

static SHARED_BACKEND: std::sync::RwLock<Option<Arc<dyn BrowserBackend>>> =
    std::sync::RwLock::new(None);

/// Install (or clear) the process-wide browser backend.
pub fn set_shared_browser_backend(backend: Option<Arc<dyn BrowserBackend>>) {
    let mut slot = SHARED_BACKEND.write().unwrap();
    *slot = backend;
}

/// The installed backend, when the app booted a webview surface.
pub fn shared_browser_backend() -> Option<Arc<dyn BrowserBackend>> {
    SHARED_BACKEND.read().unwrap().clone()
}

/// Serializes every test that drives the one process-wide slot: the
/// seam's own tests below and the tool tests in
/// [`super::browser_tools`] both flip it, so they all take this lock
/// in order to stay deterministic under the parallel test harness.
#[cfg(test)]
pub(crate) static TEST_SLOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;


    #[derive(Debug)]
    struct StubBackend(bool);

    impl BrowserBackend for StubBackend {
        fn enabled(&self) -> bool {
            self.0
        }

        fn invoke(&self, request: &Value) -> Result<Value, String> {
            Ok(json!({ "echo": request }))
        }
    }

    #[derive(Debug)]
    struct FailingBackend;

    impl BrowserBackend for FailingBackend {
        fn enabled(&self) -> bool {
            true
        }

        fn invoke(&self, _request: &Value) -> Result<Value, String> {
            Err("webview gone".to_string())
        }
    }

    #[test]
    fn shared_backend_round_trips() {
        let _guard = super::TEST_SLOT_LOCK.lock().unwrap();
        set_shared_browser_backend(None);
        assert!(shared_browser_backend().is_none());
        set_shared_browser_backend(Some(Arc::new(StubBackend(true))));
        let backend = shared_browser_backend().unwrap();
        assert!(backend.enabled());
        assert_eq!(
            backend
                .invoke(&json!({ "op": "navigate", "args": { "url": "about:blank" } }))
                .unwrap()["echo"],
            json!({ "op": "navigate", "args": { "url": "about:blank" } })
        );
        set_shared_browser_backend(None);
        assert!(shared_browser_backend().is_none());
    }

    #[test]
    fn invoke_error_propagates() {
        let _guard = super::TEST_SLOT_LOCK.lock().unwrap();
        set_shared_browser_backend(Some(Arc::new(FailingBackend)));
        let backend = shared_browser_backend().unwrap();
        assert_eq!(
            backend.invoke(&json!({ "op": "navigate" })),
            Err("webview gone".to_string())
        );
        set_shared_browser_backend(None);
    }
}
