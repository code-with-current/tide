//! Desktop ownership of the Tide backend.
//!
//! The backend used to run in a spawned `tide-daemon` child process. It now
//! serves the same versioned WebSocket protocol from an app-owned listener,
//! so the supervisor/client stack and every `daemon.client()` call site keep
//! working unchanged — the process boundary is gone, not the protocol.

use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

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
    // Exposure persisted on: register with the relay so saved Remote Control
    // links keep working across desktop relaunches. A first-boot path is
    // generated once and written back so it stays stable.
    if exposure.enabled {
        if exposure.relay_path.is_none() {
            exposure.relay_path = Some(crate::remote_relay::generate_path());
            let mut persisted = app_settings.clone();
            persisted.daemon_exposure = exposure.clone();
            let _ = client::persistence::save_app_settings(&persisted);
        }
        crate::remote_relay::start(
            crate::remote_relay::RelayConfig {
                path: exposure.relay_path.clone().unwrap_or_default(),
                secret: exposure.token.clone(),
                local_port: exposure.port,
            },
            None,
        );
    }
    serve_in_process(exposure)
}

/// Bind the backend listener, open the daemon stores, and hand the socket to
/// `backend::serve` on a dedicated thread. Mirrors the retired
/// `tide-daemon` binary's main: same stores, same token, same origin rules —
/// minus the child process and its watchdog.
fn serve_in_process(
    mut exposure: DaemonExposureSettings,
) -> anyhow::Result<client::DaemonSupervisor> {
    if exposure.enabled {
        exposure = exposure
            .validate()
            .context("daemon exposure settings are invalid")?;
    }
    let listener = TcpListener::bind(exposure.bind_address()).with_context(|| {
        format!(
            "could not bind the Tide backend to {}",
            exposure.bind_address()
        )
    })?;
    let address = listener.local_addr()?;
    if !address.ip().is_loopback() && !exposure.enabled {
        bail!("refusing non-loopback backend bind {address}; enable daemon exposure to open it up");
    }
    let token = exposure.token.clone();

    let task_path = backend::persistence::StateStore::default_path();
    let settings = backend::DaemonSettingsStore::open_with_legacy(
        backend::DaemonSettings::default_path(),
        [task_path.with_file_name("settings.json")],
    )
    .context("could not load daemon settings")?;
    let task_store = backend::persistence::StateStore::daemon(task_path);
    let backend = Arc::new(backend::daemon::TideBackend::new(settings, task_store)?);
    let server = Arc::new(std::sync::Mutex::new(spawn_local_server(
        &listener, &backend, &token, &exposure,
    )?));

    let supervisor = client::DaemonSupervisor::connect_local(&address.to_string(), token)
        .context("could not connect to the in-process Tide daemon")?;

    // Settings → Daemon exposure: the restarter turns a policy change into a
    // serve-loop restart on the freshly bound listener, and the supervisor
    // reconnects to the (possibly different) address.
    let restarter_state = Arc::clone(&server);
    let restarter_backend = Arc::clone(&backend);
    supervisor.set_local_restarter(Arc::new(move |next: DaemonExposureSettings| {
        let next = next
            .validate()
            .context("daemon exposure settings are invalid")?;
        // Stop the previous loop first: it owns the old listener, and a fixed
        // port cannot rebind until that socket is gone.
        let previous = {
            let mut guard = restarter_state.lock().unwrap();
            guard
                .shutdown
                .store(true, std::sync::atomic::Ordering::SeqCst);
            guard.thread.take()
        };
        if let Some(handle) = previous {
            let _ = handle.join();
        }
        let listener = TcpListener::bind(next.bind_address()).with_context(|| {
            format!("could not bind the Tide backend to {}", next.bind_address())
        })?;
        let address = listener.local_addr()?;
        if !address.ip().is_loopback() && !next.enabled {
            bail!(
                "refusing non-loopback backend bind {address}; enable daemon exposure to open it up"
            );
        }
        let address = address.to_string();
        let spawned = spawn_local_server(&listener, &restarter_backend, &next.token, &next)?;
        *restarter_state.lock().unwrap() = spawned;
        Ok(address)
    }));
    Ok(supervisor)
}

/// The live handles for the in-process backend server: the flag that stops
/// its serve loop and the thread running that loop.
struct LocalServer {
    shutdown: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

fn spawn_local_server(
    listener: &TcpListener,
    backend: &Arc<backend::daemon::TideBackend>,
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
            let backend = Arc::clone(backend);
            let token = token.to_owned();
            move || {
                // The loop exits when the flag flips (exposure reconfigure or
                // app shutdown); the listener drops with the thread.
                let _ = backend::serve(
                    thread_listener,
                    token,
                    backend,
                    shutdown,
                    backend::ServerOptions {
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
