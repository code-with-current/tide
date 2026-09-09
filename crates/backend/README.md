# backend

`backend` is Tide's daemon-only runtime. It contains the native session
drivers, provider discovery and model metadata, task persistence, attachment
storage, workspace filesystem and Git services, Computer Use process control,
and daemon-owned settings. It depends on the serializable contract in
[`protocol`](../protocol), but contains no desktop transport or UI.

The transport is an authenticated WebSocket (loopback by default). Requests
have stable UUIDs for idempotency; session events carry monotonically
increasing sequence numbers and runtime-generation IDs. The server keeps a
bounded replay journal, and stale events or commands from a replaced runtime
are ignored.

`DaemonClient` lives in [`client`](../client), which is what Tide
Desktop depends on. `serve` and `TideBackend` are used by the `tide-daemon`
binary.

Configuration ownership is explicit:

- the desktop owns `~/.tide/app.json` in Release and checkout-local
  `temp/app.json` in Debug;
- the daemon owns `~/.tide/settings.json`.

Task SQLite rows and durable attachment materializations are daemon-owned as
well. Client-local attachment paths are upload inputs or caches only; provider
prompts and persisted messages use daemon-issued paths and references.
Projectless task directories are daemon-owned too and live beneath
`~/.tide/projects`.

The protocol types use Serde's tagged JSON representation and are exported by
`protocol`, including checked-in TypeScript bindings.
