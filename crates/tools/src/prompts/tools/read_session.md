<!--
name: "read_session"
description: "Read one saved session's conversation, oldest first, by cursor."
category: "Agent"
-->
- `read_session` — Read one saved session's conversation from this workspace — user and assistant messages in conversation order (oldest first), paged by cursor. Use after `list_sessions` to recover what a past session established. Tool and system traffic is omitted; long messages are truncated.
