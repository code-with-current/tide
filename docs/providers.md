# Provider integrations

Tide runs one provider: its own embedded agent. The CLI integrations (Amp,
Claude Code, Codex CLI, Cursor CLI, Fx, Grok Build, Kimi Code, OpenCode,
Oh My Pi, Pi) were removed together with their drivers, session modules, and
UI; `ProviderKind` is `Tide`-only and the Providers screen in Settings
manages the tide engine's configured endpoints (name, API style, base URL,
key, models).

## The tide driver

The agent loop runs in the daemon process — there is no child CLI to launch
or supervise. `driver::start_local` constructs `TideDriver`
([driver/tide.rs](../crates/backend/src/driver/tide.rs)), which drives
[`crates/engine`](../crates/engine) (rig-backed streaming with the provider
quirk layer) over a toolset from [`crates/tools`](../crates/tools)
(permissions, hooks, computer use, background shells, dispatched sub-agents).

The wire surface is unchanged in shape: the UI sends commands through
`DriverControl` and receives `DriverEvent`s — `Connected`, `TurnStarted`,
`TextDelta`, `ReasoningDelta`, `Activity`, `RichActivity`, `Permission`,
`BackgroundWork`, `SteerAccepted`/`SteerRejected`, `TurnFinished`, `Error`.
Steering injects into the running turn's next step boundary
(`TurnInbox::push_step`); a prompt while idle queues a follow-up turn
(`push_turn`). Every tool event normalizes into one `ActivityItem`
(`Reasoning | Command | FileChange | Search | Plan | Tool`) via
[driver/activity.rs](../crates/backend/src/driver/activity.rs).

## Resume and identity

A tide session resumes from its `ProviderResumeCursor::Tide { session_id }`
— the daemon's own session record, not a foreign CLI's thread. Session
titles are tide-generated. Git attribution records the tide provider.

## Background work

Detached work (background shells, dispatched sub-agents) reports through the
`BackgroundWorkEvent` stream and renders in the session header summary, the
right panel, and the Agents panel. The registry design and rollout plan live
in [plans](plans/2026-09-04-native-background-jobs-design.md).

## Adding a provider

There is no provider abstraction to extend anymore: a new execution
backend means a new driver beside `tide.rs` behind `DriverControl`, a
`ProviderKind` variant, a resume cursor, and its own session module — the
weighted decision the CLI removal closed. Do not reintroduce per-CLI
branching without revisiting that decision.
