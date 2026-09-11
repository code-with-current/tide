//! Binds host-owned terminal sessions to the backend's WebSocket event sink.

use std::path::Path;

struct TransportEvents(transport::EventSink);

impl host::terminal::TerminalEventSink for TransportEvents {
    fn send_ephemeral(&self, event: protocol::WireDriverEvent) -> anyhow::Result<()> {
        self.0.send_ephemeral(event)
    }
}

pub(crate) fn open(
    cwd: &Path,
    cols: u16,
    rows: u16,
    events: transport::EventSink,
) -> anyhow::Result<host::terminal::DaemonTerminal> {
    host::terminal::DaemonTerminal::open(cwd, cols, rows, Box::new(TransportEvents(events)))
}
