# runtime

`runtime` owns Tide's provider-facing execution layer: session drivers,
provider and model discovery, skills, session-owned action jobs,
model-assisted Git operations, session-history adapters, and the bridge to
the local RAG engine.

It depends on `protocol` for domain types, `engine` and `tools` for agent
execution, `store` for configuration and history, and `host` for machine-level
services. It has no WebSocket server, request dispatcher, or GPUI dependency.
