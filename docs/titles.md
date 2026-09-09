# Session titles

How each session in the sidebar gets its name: who writes the title, how Tide
learns about it, and when.

## The two title fields

[`AgentSession`](../crates/protocol/src/model.rs) carries two:

| Field | Owner | Set by |
| --- | --- | --- |
| `title` | the user | inline rename; wins whenever it differs from `DEFAULT_TITLE` |
| `auto_title` | the agent | `DriverEvent::AutoTitleUpdated`, and the local fallback below |

[`display_title`] resolves them: an explicit `title` first, then
`auto_title`, then `DEFAULT_TITLE` (`"New task"`). An agent title therefore
never overwrites a name the user typed.

### The local fallback

[`set_title_from_prompt`] takes the **first seven words** of the first
prompt, capped at 54 characters, and writes them into `auto_title`. It is
called once per session from the app runtime and no-ops if the session
already has a second message, a user title, or any `auto_title`.

This is a placeholder, not a title. It shares the `auto_title` field precisely
so the real one replaces it silently when it arrives — which makes **latency
the thing that matters**. A generated title that lands after the turn ends is,
from the user's side, indistinguishable from no title at all: they stare at
truncated prompt text for the entire run.

## How the tide agent titles sessions

The tide driver generates titles in-process. A cheap one-shot completion
through [`crates/engine`](../crates/engine) summarizes the session's first
exchange; General Settings' **title model** override
(`titleModel`, resolved by `background_model_override("title")` in
[driver/tide.rs](../crates/backend/src/driver/tide.rs)) picks the model, and a
stale override falls through to the session's own selection instead of failing
generation. The result reaches the UI as
`DriverEvent::AutoTitleUpdated(Option<String>)`, consumed once in
`src/app/streaming.rs` → `set_auto_title`, which trims, maps empty to `None`,
and is the universal last-stage normalizer. `AutoTitleUpdated` is in the
`force_save` set (`src/app/runtime.rs`), so a title persists the moment it
lands.

The same override machinery serves the commit-message model
(`commitMessageModel`); see [providers.md](providers.md) for the provider
configuration those model refs resolve against.

[display_title]: ../crates/protocol/src/model.rs
[set_title_from_prompt]: ../crates/protocol/src/model.rs
