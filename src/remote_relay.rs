//! Remote Control relay client — one outbound connection per exposed daemon.
//!
//! Cloudflare can't reach a desktop behind NAT, so the desktop dials the
//! relay instead: an outbound WSS to `/d/<path>?s=<secret>` registers this
//! machine under the path encoded in the Remote Control link. When a browser
//! opens the link, the relay asks for a channel; each channel gets a fresh
//! local connection into the in-process daemon (`ws://127.0.0.1:<port>/v1`),
//! and frames pipe 1:1 in both directions. The daemon protocol — hello,
//! token auth, replay — is spoken end-to-end between browser and daemon; the
//! relay and this client only move envelopes.
//!
//! Threading model: every socket belongs to exactly one thread. The relay
//! thread owns the outbound socket and reads it with a short timeout, so it
//! can also drain an mpsc of frames produced by channel threads (local daemon
//! → relay) and notice stop. Each channel thread owns its local daemon socket
//! the same way. Nothing shares a socket across threads.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tungstenite::Message;
use tungstenite::stream::MaybeTlsStream;

/// Default production relay. `TIDE_RELAY_URL` overrides it (local wrangler
/// dev runs on ws://127.0.0.1:8790).
pub const DEFAULT_RELAY_URL: &str = "wss://relay.remote.tide.codes";

const READ_POLL: Duration = Duration::from_millis(250);
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(1);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// The path embedded in the Remote Control link, e.g. `/a1b2/c3d4/e5f6a7b8c9d0`.
    pub path: String,
    /// Registration secret the relay requires at dial time.
    pub secret: String,
    /// Local daemon port (the in-process listener bound on loopback).
    pub local_port: u16,
}

/// Generate the link path: three random hex segments matching the relay's
/// `/xxxx/xxxx/xxxxxxxxxxxx` capability shape.
pub fn generate_path() -> String {
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("/{}/{}/{}", &hex[0..4], &hex[4..8], &hex[8..20])
}

/// Diagnostics land in the user temp dir: the relay client runs on a
/// background thread whose eprintln output only reaches the dev watcher
/// terminal.
fn relay_log(message: &str) {
    use std::io::Write as _;
    let path = std::env::temp_dir().join("tide-relay-client.log");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "[{stamp}] {message}");
    }
    eprintln!("[tide-relay] {message}");
}

static SESSION_ID: AtomicU64 = AtomicU64::new(0);
static ACTIVE: Mutex<Option<ActiveSession>> = Mutex::new(None);

struct ActiveSession {
    handle: RelayHandle,
    path: String,
}

#[derive(Clone)]
struct RelayHandle {
    state: Arc<SessionState>,
}

struct SessionState {
    stop: AtomicBool,
}

/// Current link path, so the settings/QR UI renders the same value the
/// client registered. `None` when no relay session is live.
pub fn active_path() -> Option<String> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|session| session.path.clone()))
}

/// Replace the active relay session; stops any previous one first. Each
/// start bumps a run id so threads from an older session exit promptly.
pub fn start(config: RelayConfig, relay_url: Option<String>) {
    stop();
    let run_id = SESSION_ID.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = RelayHandle {
        state: Arc::new(SessionState {
            stop: AtomicBool::new(false),
        }),
    };
    if let Ok(mut active) = ACTIVE.lock() {
        *active = Some(ActiveSession {
            handle: handle.clone(),
            path: config.path.clone(),
        });
    }
    let base = relay_url
        .or_else(|| std::env::var("TIDE_RELAY_URL").ok())
        .unwrap_or_else(|| DEFAULT_RELAY_URL.to_owned());
    std::thread::Builder::new()
        .name("tide-remote-relay".into())
        .spawn(move || run_session(base, config, handle, run_id))
        .expect("spawn remote relay thread");
}

/// Stop the relay session (Remote Control off or app shutdown).
pub fn stop() {
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some(session) = active.take() {
            session.handle.state.stop.store(true, Ordering::SeqCst);
        }
    }
}

fn stopped(handle: &RelayHandle) -> bool {
    handle.state.stop.load(Ordering::SeqCst)
}

fn run_session(base: String, config: RelayConfig, handle: RelayHandle, run_id: u64) {
    let mut backoff = RECONNECT_BASE_DELAY;
    while !stopped(&handle) && SESSION_ID.load(Ordering::SeqCst) == run_id {
        let url = format!(
            "{}/d{}?s={}",
            base.trim_end_matches('/'),
            config.path,
            config.secret
        );
        match tungstenite::connect(url.as_str()).map(|(socket, _)| socket) {
            Ok(socket) => {
                backoff = RECONNECT_BASE_DELAY;
                relay_log(&format!("relay registered at {}", config.path));
                serve_relay_socket(socket, &config, &handle);
            }
            Err(error) => relay_log(&format!("relay connect failed for {url}: {error:#}")),
        }
        if stopped(&handle) || SESSION_ID.load(Ordering::SeqCst) != run_id {
            return;
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(RECONNECT_MAX_DELAY);
    }
}

/// Owns the relay socket: dispatches envelopes, drains outbound frames.
fn serve_relay_socket(
    socket: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    config: &RelayConfig,
    handle: &RelayHandle,
) {
    set_poll_timeout(&socket);
    let mut socket = socket;
    let (out_tx, out_rx) = std::sync::mpsc::channel::<(u32, OutFrame)>();
    let channels: Arc<Mutex<HashMap<u32, Option<Sender<Message>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let mut last_ping = std::time::Instant::now();
    let mut last_pong = std::time::Instant::now();
    loop {
        if stopped(handle) {
            return;
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                relay_log(&format!(
                    "relay frame: {}",
                    &text.chars().take(80).collect::<String>()
                ));
                // Keepalive: the relay answers our ping with a pong.
                if text.as_str() == "{\"c\":0,\"t\":\"pong\"}" {
                    last_pong = std::time::Instant::now();
                    continue;
                }
                handle_envelope(&text, config, handle, &channels, out_tx.clone());
            }
            Ok(Message::Ping(payload)) => {
                let _ = socket.send(Message::Pong(payload));
            }
            Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => return,
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
        // Drain frames the channel threads produced for the relay.
        loop {
            match out_rx.try_recv() {
                Ok((_, OutFrame::Send(message))) => {
                    if let Message::Text(text) = &message {
                        relay_log(&format!(
                            "relay send: {}",
                            &text.chars().take(60).collect::<String>()
                        ));
                    }
                    if socket.send(message).is_err() {
                        return;
                    }
                }
                Ok((channel, OutFrame::NotifyClose)) => {
                    channels.lock().unwrap().remove(&channel);
                    let frame = serde_json::json!({ "c": channel, "t": "close" });
                    if socket
                        .send(Message::Text(frame.to_string().into()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        // Half-open detection: ping the relay on a tick; a pong silence
        // beyond the deadline means the socket is dead — reconnect.
        if last_ping.elapsed() >= Duration::from_secs(15) {
            last_ping = std::time::Instant::now();
            if socket
                .send(Message::Text("{\"c\":0,\"t\":\"ping\"}".into()))
                .is_err()
            {
                return;
            }
        }
        if last_pong.elapsed() > Duration::from_secs(45) {
            relay_log("relay pong overdue — reconnecting");
            return;
        }
    }
}

#[derive(Debug)]
enum OutFrame {
    Send(Message),
    NotifyClose,
}

fn handle_envelope(
    text: &str,
    config: &RelayConfig,
    handle: &RelayHandle,
    channels: &Arc<Mutex<HashMap<u32, Option<Sender<Message>>>>>,
    out_tx: Sender<(u32, OutFrame)>,
) {
    let Ok(envelope) = serde_json::from_str::<RelayEnvelope>(text) else {
        return;
    };
    match envelope.t.as_str() {
        "open" => open_channel(envelope.c, config, handle, channels, out_tx),
        "f" => {
            let channels = channels.lock().unwrap();
            if let Some(Some(sender)) = channels.get(&envelope.c) {
                if let Some(data) = envelope.d {
                    let _ = sender.send(Message::Text(data.into()));
                }
            }
        }
        "close" => {
            if let Some(Some(sender)) = channels.lock().unwrap().get(&envelope.c) {
                let _ = sender.send(Message::Close(None));
            }
        }
        _ => {}
    }
}

/// Dial the in-process daemon and own the channel: local frames go to the
/// relay via `out_tx`, relay frames arrive on `rx`.
fn open_channel(
    channel: u32,
    config: &RelayConfig,
    handle: &RelayHandle,
    channels: &Arc<Mutex<HashMap<u32, Option<Sender<Message>>>>>,
    out_tx: Sender<(u32, OutFrame)>,
) {
    let local_url = format!("ws://127.0.0.1:{}/v1", config.local_port);
    let socket = match tungstenite::connect(local_url.as_str()).map(|(socket, _)| socket) {
        Ok(socket) => {
            relay_log(&format!("channel {channel}: local daemon dialed"));
            socket
        }
        Err(error) => {
            let _ = out_tx.send((
                channel,
                OutFrame::Send(
                    serde_json::json!({ "c": channel, "t": "open-error", "error": error.to_string() })
                        .to_string()
                        .into(),
                ),
            ));
            return;
        }
    };
    let (to_socket_tx, to_socket_rx) = std::sync::mpsc::channel::<Message>();
    channels.lock().unwrap().insert(channel, Some(to_socket_tx));
    let mut socket = socket;
    set_poll_timeout(&socket);
    let handle_state = Arc::clone(&handle.state);
    std::thread::Builder::new()
        .name("tide-relay-channel".into())
        .spawn(move || {
            loop {
                if handle_state.stop.load(Ordering::SeqCst) {
                    return;
                }
                match socket.read() {
                    Ok(Message::Text(text)) => {
                        // The relay requires daemon frames as channel envelopes.
                        let envelope =
                            serde_json::json!({ "c": channel, "t": "f", "d": text.as_str() });
                        if out_tx
                            .send((
                                channel,
                                OutFrame::Send(Message::Text(envelope.to_string().into())),
                            ))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        let _ = socket.send(Message::Pong(payload));
                    }
                    Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => {
                        let _ = out_tx.send((channel, OutFrame::NotifyClose));
                        return;
                    }
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(error))
                        if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                    Err(_) => {
                        let _ = out_tx.send((channel, OutFrame::NotifyClose));
                        return;
                    }
                }
                loop {
                    match to_socket_rx.try_recv() {
                        Ok(message) => {
                            if socket.send(message).is_err() {
                                return;
                            }
                        }
                        Err(TryRecvError::Empty) => break,
                        Err(TryRecvError::Disconnected) => {
                            let _ = socket.close(None);
                            let _ = out_tx.send((channel, OutFrame::NotifyClose));
                            return;
                        }
                    }
                }
            }
        })
        .ok();
}

fn set_poll_timeout(socket: &tungstenite::WebSocket<MaybeTlsStream<TcpStream>>) {
    // The relay socket is wss (TLS) while local daemon dials are plain —
    // both need the poll timeout or reads block forever on silent deaths.
    let tcp = match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => stream,
        MaybeTlsStream::NativeTls(stream) => stream.get_ref(),
        _ => return,
    };
    let _ = tcp.set_read_timeout(Some(READ_POLL));
    let _ = tcp.set_write_timeout(Some(READ_POLL));
}

#[derive(serde::Deserialize)]
struct RelayEnvelope {
    c: u32,
    t: String,
    #[serde(default)]
    d: Option<String>,
}
