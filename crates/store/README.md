# store

`store` owns Tide's durable local state: task and session SQLite records,
desktop and daemon settings, provider configuration, attachments, binary
transcript blobs, secrets, usage data, and the RAG index.

The crate depends on `protocol` for persisted domain types. It does not depend
on provider runtimes, agent tools, WebSocket transport, or UI code.
