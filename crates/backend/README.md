# backend

`backend` is Tide's daemon-only runtime. It contains the native session
drivers, provider discovery and model metadata, orchestration, and Computer
Use process control. Machine-level Git, worktree, checkpoint, and process
services live in [`host`](../host), persistence lives in [`store`](../store),
and the serializable contract lives in [`protocol`](../protocol). This crate
contains no desktop transport or UI.

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
