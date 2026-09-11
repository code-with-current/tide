#![cfg(unix)]

use std::net::TcpListener;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use backend::daemon::TideBackend;
use backend::terminal::DaemonTerminal;
use backend::{Backend, Command, EventSink, Request, ResponsePayload, ServerOptions, serve};
use base64::Engine as _;
use client::DaemonClient;
use crossbeam_channel::{Sender, bounded};
use protocol::model::{AgentSession, Project, ProviderKind};
use store::persistence::StateStore;
use store::settings::DaemonSettingsStore;
use uuid::Uuid;

fn start_server(backend: Arc<dyn Backend>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let shutdown = Arc::new(AtomicBool::new(false));
    let server = std::thread::spawn(move || {
        serve(
            listener,
            "secret".into(),
            backend,
            shutdown,
            ServerOptions {
                allow_shutdown: true,
                ..ServerOptions::default()
            },
        )
        .unwrap()
    });
    (address, server)
}

#[test]
fn stale_projection_cannot_resurrect_a_removed_session() {
    let root = std::env::temp_dir().join(format!("tide-remove-race-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let backend = TideBackend::new(
        DaemonSettingsStore::open(root.join("settings.json")).unwrap(),
        StateStore::daemon(root.join("app.db")),
    )
    .unwrap();
    let (address, server) = start_server(Arc::new(backend));

    let stale_client = DaemonClient::connect(&address, "secret".into()).unwrap();
    let remover = DaemonClient::connect(&address, "secret".into()).unwrap();
    let project = Project::from_path(root.join("repo"));
    let mut session = AgentSession::new(project.id, ProviderKind::Tide);
    session.begin_turn("persist me");
    stale_client
        .request(
            Uuid::nil(),
            Uuid::nil(),
            Command::SaveTaskState {
                projects: vec![project.clone()],
                live_session_ids: vec![session.id],
                sessions: vec![session.clone()],
            },
        )
        .unwrap();
    remover
        .request(session.id, Uuid::nil(), Command::RemoveSession)
        .unwrap();
    let ResponsePayload::TaskStateSaved { sessions } = stale_client
        .request(
            Uuid::nil(),
            Uuid::nil(),
            Command::SaveTaskState {
                projects: vec![project],
                live_session_ids: vec![session.id],
                sessions: vec![session],
            },
        )
        .unwrap()
    else {
        panic!("expected task-state save response");
    };
    assert!(sessions.is_empty());
    let ResponsePayload::TaskState { sessions, .. } = stale_client
        .request(Uuid::nil(), Uuid::nil(), Command::LoadTaskState)
        .unwrap()
    else {
        panic!("expected task state");
    };
    assert!(sessions.is_empty());

    stale_client.shutdown();
    server.join().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

struct SinkCaptureBackend {
    sink: Mutex<Option<Sender<EventSink>>>,
}

impl Backend for SinkCaptureBackend {
    fn handle(&self, _request: Request, events: EventSink) -> anyhow::Result<ResponsePayload> {
        if let Some(sink) = self.sink.lock().unwrap().take() {
            let _ = sink.send(events);
        }
        Ok(ResponsePayload::Ack)
    }
}

#[test]
fn dropping_an_idle_terminal_does_not_wait_for_output() {
    let root = std::env::temp_dir().join(format!("tide-terminal-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let (sink_tx, sink_rx) = bounded(1);
    let (address, server) = start_server(Arc::new(SinkCaptureBackend {
        sink: Mutex::new(Some(sink_tx)),
    }));
    let client = DaemonClient::connect(&address, "secret".into()).unwrap();
    client
        .request(Uuid::new_v4(), Uuid::new_v4(), Command::GetSettings)
        .unwrap();
    let events = sink_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    client.shutdown();
    server.join().unwrap();

    let terminal = DaemonTerminal::open(&root, 80, 24, events).unwrap();
    let (dropped, finished) = bounded(1);
    std::thread::spawn(move || {
        drop(terminal);
        let _ = dropped.send(());
    });
    assert!(
        finished.recv_timeout(Duration::from_secs(3)).is_ok(),
        "dropping an idle daemon terminal blocked on its output reader"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn websocket_terminal_round_trip_streams_input_and_output() {
    let root = std::env::temp_dir().join(format!("tide-terminal-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let backend = TideBackend::new(
        DaemonSettingsStore::open(root.join("settings.json")).unwrap(),
        StateStore::daemon(root.join("app.db")),
    )
    .unwrap();
    let (address, server) = start_server(Arc::new(backend));

    let client = DaemonClient::connect(&address, "secret".into()).unwrap();
    let terminal_id = Uuid::new_v4();
    let events = client.subscribe(terminal_id, terminal_id);
    assert!(matches!(
        client
            .request(
                terminal_id,
                terminal_id,
                Command::OpenTerminal {
                    cwd: root.clone(),
                    cols: 80,
                    rows: 24,
                },
            )
            .unwrap(),
        ResponsePayload::Ack
    ));
    client
        .request(
            terminal_id,
            terminal_id,
            Command::WriteTerminal {
                data: b"tide-terminal-round-trip\r".to_vec(),
            },
        )
        .unwrap();

    let marker = b"tide-terminal-round-trip";
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut output = Vec::new();
    let mut seen_events = Vec::new();
    while std::time::Instant::now() < deadline
        && !output.windows(marker.len()).any(|window| window == marker)
    {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let Ok(event) = events.recv_timeout(remaining) else {
            break;
        };
        seen_events.push(event.event.kind.clone());
        if event.event.kind != "terminalOutput" {
            continue;
        }
        let data = event.event.payload["data"].as_str().unwrap();
        output.extend(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap(),
        );
    }
    assert!(
        output.windows(marker.len()).any(|window| window == marker),
        "daemon terminal did not return the shell marker; events={seen_events:?}, output={}",
        String::from_utf8_lossy(&output)
    );
    assert!(matches!(
        client
            .request(terminal_id, terminal_id, Command::CloseTerminal)
            .unwrap(),
        ResponsePayload::Ack
    ));

    client.shutdown();
    server.join().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
