# backend

`backend` is Tide's request-orchestration crate. It implements the transport
request handler and composes provider sessions from [`runtime`](../runtime),
machine-level services from [`host`](../host), persistence from
[`store`](../store), and the serializable contract from
[`protocol`](../protocol). It contains no socket server, persistence
implementation, provider engine, or UI.

The authenticated WebSocket, request idempotency, subscriptions, event
sequencing, and bounded replay journal live in [`transport`](../transport).
This crate implements its `Backend` trait with Tide's runtime behavior.

`DaemonClient` lives in [`client`](../client). Tide Desktop hosts the transport
listener in-process and composes it with `TideBackend`.

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
