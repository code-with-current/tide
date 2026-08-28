//! `startAtLogin` OS parity (the old Electron shell's
//! `app.setLoginItemSettings`): the login item itself lives in
//! tauri-plugin-autostart, gated behind this trait so the settings commands
//! and the boot reconcile run against an in-memory fake in tests instead of
//! the real login-item store.

/// The slice of the autostart plugin the settings path needs.
pub trait AutoStartBackend: Send + Sync {
    fn is_enabled(&self) -> Result<bool, String>;
    fn set_enabled(&self, enabled: bool) -> Result<(), String>;
}

/// Production backend: borrows the plugin's process-wide manager from the
/// app handle. The manager exists once the plugin is registered in `run()`.
pub struct PluginAutostart<'a> {
    manager: &'a tauri_plugin_autostart::AutoLaunchManager,
}

impl<'a> PluginAutostart<'a> {
    pub fn new<R: tauri::Runtime>(app: &'a tauri::AppHandle<R>) -> Self {
        use tauri_plugin_autostart::ManagerExt as _;
        Self {
            manager: app.autolaunch().inner(),
        }
    }
}

impl AutoStartBackend for PluginAutostart<'_> {
    fn is_enabled(&self) -> Result<bool, String> {
        self.manager.is_enabled().map_err(|e| e.to_string())
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let result = if enabled {
            self.manager.enable()
        } else {
            self.manager.disable()
        };
        result.map_err(|e| e.to_string())
    }
}

/// Make the OS login item match `desired` — the stored setting is
/// authoritative (TS main.ts boot sync: reinstalling or hand-editing
/// config.json can drift the login item). Skips the write when the states
/// already match so a normal boot touches nothing.
pub fn reconcile(backend: &dyn AutoStartBackend, desired: bool) -> Result<(), String> {
    if backend.is_enabled()? != desired {
        backend.set_enabled(desired)?;
    }
    Ok(())
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MockAutoStart {
    inner: std::sync::Mutex<MockInner>,
}

#[cfg(test)]
#[derive(Default)]
struct MockInner {
    enabled: bool,
    calls: Vec<String>,
    fail_is_enabled: bool,
    fail_set: bool,
}

#[cfg(test)]
impl MockAutoStart {
    pub fn with_enabled(enabled: bool) -> Self {
        Self {
            inner: std::sync::Mutex::new(MockInner {
                enabled,
                ..MockInner::default()
            }),
        }
    }

    pub fn fail_is_enabled(&self) {
        self.inner.lock().unwrap().fail_is_enabled = true;
    }

    pub fn fail_set(&self) {
        self.inner.lock().unwrap().fail_set = true;
    }

    pub fn calls(&self) -> Vec<String> {
        self.inner.lock().unwrap().calls.clone()
    }
}

#[cfg(test)]
impl AutoStartBackend for MockAutoStart {
    fn is_enabled(&self) -> Result<bool, String> {
        let mut guard = self.inner.lock().unwrap();
        guard.calls.push("is_enabled".into());
        if guard.fail_is_enabled {
            return Err("is_enabled boom".into());
        }
        Ok(guard.enabled)
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        guard.calls.push(format!("set_enabled({enabled})"));
        if guard.fail_set {
            return Err("set_enabled boom".into());
        }
        guard.enabled = enabled;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconcile_noops_when_already_matching() {
        for desired in [false, true] {
            let mock = MockAutoStart::with_enabled(desired);
            reconcile(&mock, desired).unwrap();
            assert_eq!(mock.calls(), ["is_enabled".to_owned()]);
        }
    }

    #[test]
    fn reconcile_writes_when_drifted() {
        let mock = MockAutoStart::with_enabled(false);
        reconcile(&mock, true).unwrap();
        assert_eq!(
            mock.calls(),
            ["is_enabled".to_owned(), "set_enabled(true)".to_owned()]
        );

        let mock = MockAutoStart::with_enabled(true);
        reconcile(&mock, false).unwrap();
        assert_eq!(
            mock.calls(),
            ["is_enabled".to_owned(), "set_enabled(false)".to_owned()]
        );
    }

    #[test]
    fn reconcile_propagates_state_and_write_errors() {
        let mock = MockAutoStart::default();
        mock.fail_is_enabled();
        assert_eq!(reconcile(&mock, true).unwrap_err(), "is_enabled boom");

        let mock = MockAutoStart::with_enabled(false);
        mock.fail_set();
        assert_eq!(reconcile(&mock, true).unwrap_err(), "set_enabled boom");
    }

    #[test]
    fn plugin_adapter_resolves_the_registered_manager() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.handle()
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .unwrap();
        // Read-only on the host: LaunchAgent is_enabled is a plist/directory
        // existence check, so this only proves the adapter reaches the
        // plugin's manager without touching the login item.
        PluginAutostart::new(app.handle())
            .is_enabled()
            .expect("manager state resolves");
    }
}
