//! Desktop ownership of the Tide backend.
//!
//! The backend used to run in a spawned `tide-daemon` child process. It now
//! serves the same versioned WebSocket protocol from an app-owned listener,
//! so the supervisor/client stack and every `daemon.client()` call site keep
//! working unchanged — the process boundary is gone, not the protocol.

use std::net::TcpListener;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, bail};
use client::DaemonExposureSettings;

pub fn start_process() -> anyhow::Result<client::DaemonSupervisor> {
    let address = std::env::var(client::DAEMON_ADDRESS_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty());
    let token = std::env::var(client::DAEMON_TOKEN_ENV)
        .ok()
        .filter(|value| !value.is_empty());
    match (address, token) {
        (Some(address), Some(token)) => {
            return client::DaemonSupervisor::connect(address.trim(), token);
        }
        (Some(_), None) => bail!(
            "{} is set but {} is missing",
            client::DAEMON_ADDRESS_ENV,
            client::DAEMON_TOKEN_ENV
        ),
        (None, Some(_)) => bail!(
            "{} is set but {} is missing",
            client::DAEMON_TOKEN_ENV,
            client::DAEMON_ADDRESS_ENV
        ),
        (None, None) => {}
    }
    // `load_or_create_app_settings` guarantees a persisted, non-empty token.
    let app_settings = client::persistence::load_or_create_app_settings()
        .context("could not load desktop daemon settings")?;
    let mut exposure = app_settings.daemon_exposure.clone();
    // Remote Control is session-scoped: every launch starts disabled, even
    // if the previous run quit (or crashed) while it was live. The reset is
    // persisted before the UI loads its state, so desktop and daemon agree.
    if exposure.enabled {
        exposure.enabled = false;
        let mut persisted = app_settings.clone();
        persisted.daemon_exposure = exposure.clone();
        let _ = client::persistence::save_app_settings(&persisted);
    }
    serve_in_process(exposure)
}

/// Bind the desktop's permanent local listener, open the daemon stores, and
/// hand everything to [`transport::serve_with_core`] on a dedicated thread.
/// Mirrors the retired `tide-daemon` binary's main: same stores, same token,
/// same origin rules — minus the child process and its watchdog.
///
/// Two listeners share one [`transport::ServerCore`] so both see a single
/// event lifecycle: the loopback plane this desktop talks to — its
/// connections outlive every exposure change — and the Remote Control
/// plane, which the exposure controller binds to 0.0.0.0 only while
/// enabled.
fn serve_in_process(exposure: DaemonExposureSettings) -> anyhow::Result<client::DaemonSupervisor> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .context("could not bind the Tide backend to a local port")?;
    let address = listener.local_addr()?;
    let token = exposure.token.clone();

    let task_path = backend::persistence::StateStore::default_path();
    let settings = backend::DaemonSettingsStore::open_with_legacy(
        backend::DaemonSettings::default_path(),
        [task_path.with_file_name("settings.json")],
    )
    .context("could not load daemon settings")?;
    let task_store = backend::persistence::StateStore::daemon(task_path);
    let backend = Arc::new(backend::daemon::TideBackend::new(settings, task_store)?);
    let core = Arc::new(transport::ServerCore::new(backend));

    // Serves until the process exits; exposure changes never touch it, so
    // its handle may detach.
    spawn_server(&listener, &core, &token, &exposure)?;

    let supervisor = client::DaemonSupervisor::connect_local(&address.to_string(), token)
        .context("could not connect to the in-process Tide daemon")?;

    // Settings → Remote Control: the controller starts and stops only the
    // exposure plane; the local plane above never moves, so desktop turns
    // are unaffected by exposure changes.
    let exposure_plane: Arc<Mutex<Option<LocalServer>>> = Arc::new(Mutex::new(None));
    let controller_plane = Arc::clone(&exposure_plane);
    let controller_core = Arc::clone(&core);
    supervisor.set_exposure_controller(Arc::new(move |next| {
        apply_exposure(&controller_plane, &controller_core, next)
    }));
    Ok(supervisor)
}

/// Start or stop only the exposure plane: validate the policy, tear down
/// any previous exposure listener, and — while enabled — bind the exposed
/// address and serve the shared core on it. The local plane is never
/// touched, and when exposure is off no externally bound socket exists at
/// the kernel level.
fn apply_exposure(
    plane: &Mutex<Option<LocalServer>>,
    core: &Arc<transport::ServerCore>,
    next: DaemonExposureSettings,
) -> anyhow::Result<()> {
    let next = next
        .validate()
        .context("daemon exposure settings are invalid")?;
    // Stop the previous plane first: a fixed port cannot rebind while the
    // old listener still holds it.
    if let Some(server) = plane.lock().unwrap().take() {
        server.stop();
    }
    if !next.enabled {
        return Ok(());
    }
    let listener = TcpListener::bind(next.bind_address())
        .with_context(|| format!("could not bind the Tide backend to {}", next.bind_address()))?;
    let token = next.token.clone();
    *plane.lock().unwrap() = Some(spawn_server(&listener, core, &token, &next)?);
    Ok(())
}

/// The live handles for one backend listener: the flag that stops its serve
/// loop and the thread running that loop. Established connection threads
/// are owned separately and finish on their own.
struct LocalServer {
    shutdown: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl LocalServer {
    /// Stop the accept loop and wait for its thread to exit so a fixed port
    /// can be rebound immediately afterwards.
    fn stop(self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(handle) = self.thread {
            let _ = handle.join();
        }
    }
}

fn spawn_server(
    listener: &TcpListener,
    core: &Arc<transport::ServerCore>,
    token: &str,
    exposure: &DaemonExposureSettings,
) -> anyhow::Result<LocalServer> {
    let shutdown = Arc::new(AtomicBool::new(false));
    let allowed_origins = exposure.allowed_origins.iter().cloned().collect();
    let thread_listener = listener
        .try_clone()
        .context("could not clone the Tide backend listener")?;
    let thread = std::thread::Builder::new()
        .name("tide-backend".into())
        .spawn({
            let shutdown = Arc::clone(&shutdown);
            let core = Arc::clone(core);
            let token = token.to_owned();
            move || {
                // The loop exits when the flag flips (exposure reconfigure or
                // app shutdown); the listener drops with the thread.
                let _ = transport::serve_with_core(
                    thread_listener,
                    token,
                    &core,
                    shutdown,
                    transport::ServerOptions {
                        allowed_origins,
                        allow_shutdown: false,
                    },
                );
            }
        })
        .context("could not start the Tide backend thread")?;
    Ok(LocalServer {
        shutdown,
        thread: Some(thread),
    })
}

/// Resolve the local host name once during app construction. Settings can
/// then show a useful LAN URL without touching the OS from a render frame.
pub fn local_hostname() -> Option<String> {
    #[cfg(unix)]
    {
        let mut buffer = [0_u8; 256];
        let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        if result == 0 {
            let length = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            let hostname = String::from_utf8_lossy(&buffer[..length]).trim().to_owned();
            if !hostname.is_empty() {
                return Some(hostname);
            }
        }
    }
    // `COMPUTERNAME` is the Windows equivalent and is always set; `HOSTNAME`
    // covers the shells that export it.
    ["COMPUTERNAME", "HOSTNAME"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|hostname| hostname.trim().to_owned())
        .find(|hostname| !hostname.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exposure-plane lifecycle only needs the `Backend` trait object to
    /// exist; no request ever reaches it.
    struct UnusedBackend;

    impl transport::Backend for UnusedBackend {
        fn handle(
            &self,
            _request: transport::Request,
            _events: transport::EventSink,
        ) -> anyhow::Result<transport::ResponsePayload> {
            Err(anyhow::anyhow!("no requests are dispatched in this test"))
        }
    }

    fn exposure_on(port: u16) -> DaemonExposureSettings {
        DaemonExposureSettings {
            enabled: true,
            port,
            allowed_origins: vec!["http://localhost:3001".into()],
            token: DaemonExposureSettings::new_token(),
            relay_path: None,
        }
    }

    fn port_is_listening(port: u16) -> bool {
        // Probe actively rather than by re-binding: duplicate-bind semantics
        // differ per platform, but a live listener always accepts and a dead
        // port always refuses.
        std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
    }

    #[test]
    fn exposure_plane_binds_while_enabled_and_frees_its_port_when_disabled() {
        let core = Arc::new(transport::ServerCore::new(Arc::new(UnusedBackend)));
        let plane: Mutex<Option<LocalServer>> = Mutex::new(None);
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();

        apply_exposure(&plane, &core, exposure_on(port)).expect("enable exposure");
        assert!(port_is_listening(port), "the exposed port should listen");

        let mut off = exposure_on(port);
        off.enabled = false;
        apply_exposure(&plane, &core, off).expect("disable exposure");
        assert!(!port_is_listening(port), "the exposed port should close");

        apply_exposure(&plane, &core, exposure_on(port)).expect("re-enable exposure");
        assert!(
            port_is_listening(port),
            "the exposed port should listen again"
        );

        let mut off = exposure_on(port);
        off.enabled = false;
        apply_exposure(&plane, &core, off).expect("final disable");
        assert!(
            !port_is_listening(port),
            "the exposed port should close again"
        );
    }
}
