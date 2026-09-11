# host

`host` owns operations against the machine where Tide's backend is running:
process environment discovery, Git status and mutation, checkpoint refs,
worktrees, and projectless workspace paths.

It depends on `protocol` for shared domain types and `store` for persisted Git
configuration. It does not depend on provider runtimes, WebSocket transport,
or GPUI.
