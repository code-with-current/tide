# Tide × Tide — daemon removal + Tide provider integration

Goal: remove the spawned `tide-daemon` CLI process and drive Tide's UI with
Tide's provider system (tide-engine + tide-tools + tide-store), in-process.

Repos:
- Tide fork: `/Volumes/512gb/TestAi/tide` (GPL-3.0 upstream; fork diverges here)
- Tide: `/Volumes/512gb/TestAi/tide` — upstream only. The three crates
  (`tide-engine`, `tide-tools`, `tide-store`) are vendored into
  `tide/crates/` (moved 2026-08-31); tide remains the upstream — re-vendor
  deliberately.

## Architecture (decided)

```
GPUI UI (unchanged views, src/app/*)
  └─ DaemonSupervisor/DaemonClient (client, unchanged)
       ↕ WebSocket on 127.0.0.1 loopback socket
     backend::serve(listener, token, TideBackend, …)  ← served by an app-owned thread (Phase A)
       ├─ persistence (app.db), workspace/git, skills, blobs, drafts — unchanged
       └─ driver::start_local registry
            └─ ProviderKind::Tide → driver/tide.rs (Phase B)
                 ├─ tide-engine: EngineModel::from_config + stream_step (owns its tokio runtime)
                 ├─ tide-tools: core_tools(), Tool trait, PermissionGate, AbortFlag
                 └─ tide-store: config.json providers + keychain API keys (macOS `security` CLI)
```

Why loopback-socket instead of direct calls: DaemonClient/DaemonSupervisor and
all ~60 `self.daemon.client()` call sites stay untouched; the external-daemon
env path (`TIDE_DAEMON_ADDRESS`/`TIDE_DAEMON_TOKEN`) keeps working for free.

## Phase A — in-process backend (DONE list below)
- `src/daemon.rs`: `start_process()` keeps env-var connect path; otherwise
  binds per `DaemonExposureSettings` (loopback ephemeral by default, exposed
  port when enabled), opens daemon stores, spawns thread running
  `backend::serve`, then `DaemonSupervisor::connect`.
- Root Cargo.toml: app gains `backend` dep; workspace drops `crates/tide-daemon` (dir deleted).
- `daemon_executable_path()` / `TIDE_DAEMON_PATH` removed.

## Phase B — ProviderKind::Tide + TideDriver

### Event mapping (tide EngineEvent → tide DriverEvent)
- turn start → `TurnStarted`; `Delta` → `TextDelta`; `Reasoning` → `ReasoningDelta`
- `ToolCallStart`/`ToolCall` → `Activity { id: tool_call_id, kind: ActivityKind::from_tool_name, complete: false }` (+ detail from args)
- tool finished → `Activity { complete: true, detail: output preview }`
- `Usage` → `UsageUpdated { context_tokens, context_window }`
- permissions: Tide's Plan/Build chip is the whole gate (reworked
  2026-09-02 from tide's autonomy gate) — Build runs every tool, Plan
  allows only read-tier calls (tide's per-tool risk table, git refined
  per subcommand) and rejects the rest with a plan-mode reason; no
  permission cards, no session/project rules, RuntimeMode unused
- steer while running → queued user message + `SteerAccepted`; else `SteerRejected`
- cancel → AbortFlag → `TurnFinished { success: false }`
- step EndTurn → `TurnFinished { success: true }`; error → `Error(String)`
- at start: `Connected { provider_cursor: None }`

### Driver internals (driver/tide.rs)
- One `tokio::runtime::Runtime` owned by the driver (tide is sync/crossbeam; rig+reqwest need tokio).
- Command loop thread: mpsc<Cmd> { Prompt, Steer, Cancel, Respond, ApplyOptions, Rollback }.
- Turn loop: history `Vec<HistoryMessage>` (tide-engine types) → `stream_step` → map events →
  on `StepEnd{ToolUse}` execute pending calls (`spawn_blocking` + `ToolContext`), append
  `ToolResult` history, continue; `EndTurn` → finish.
- History seeding: `TideBackend::handle(Command::Start)` for Tide rebuilds text-level history
  from the persisted `AgentSession` in task_state (new `prior_history` field on DriverStartOptions).
- System prompt: copy of tide's `src-tauri/system-prompt.md` embedded via `include_str!`.
- `apply_options` → true (model/effort changes absorbed in place).
- `rollback(turns)` → truncate in-memory history at turn boundaries, return `Ok(None)`.
- `fork` → unsupported (v1). computer-use/goal/user-input → trait defaults.

### Provider plumbing
- `ProviderKind::Tide` added to protocol (id "tide", display "Tide"); compiler-guided
  match arms across app/core; `supports_conversation_rollback() = true`.
- Probe (`provider_probe`): installed iff tide config has ≥1 provider with resolvable key.
- Model catalog + `discover_provider_models`: from tide `config.json`
  (`StoredProvider{id, api_style, base_url, models[StoredModel{model_id,…}]}`).
- Model selection string: `"<provider_id>::<model_id>"` (driver parses; falls back to
  first enabled provider serving the model id).

## Phase C — later
- Prune/feature-gate CLI drivers (claude/codex/amp/acp/opencode/pi/deepseek) behind `cli-providers`.
- Branding, updater, release legs.

## Status log
- [x] Baseline clone ae14d1d; rustc 1.97.1 ok
- [x] Phase A: `src/daemon.rs` serves `backend::serve` on an app-owned
      listener (loopback ephemeral; exposure settings honored when enabled);
      `crates/tide-daemon` deleted from the workspace; `bind_address()` made
      pub in client; supervisor connects over the same socket as before.
- [x] Phase B: `ProviderKind::Tide` end-to-end — resume cursor variant, probe
      (installed = tide config has an enabled provider; models inline from
      config.json as "provider/model" entries with reasoning options),
      `driver/tide.rs` (per-turn AbortFlag, permission gate w/ remember,
      steer between steps, in-memory rollback, prior-session history seeding
      on Start and headless rollback restart, per-turn engine construction,
      orchestrator-owned tools filtered out), commit-message generation gated
      to a clear error, rewind joins the driver-based group, fork unsupported.
- [x] rusqlite unified at 0.40.2 across backend and tide-store (single
      libsqlite3-sys).
- [x] Packaging scripts (dev/release/bundle/bundle-linux/bundle-windows)
      de-daemonized; `provider-tide.svg` icon embedded.
- [x] `cargo test --workspace`: 798 passed, 0 failed.
- [x] Add Provider + model selector matched to tide (2026-08-29 PM):
      Settings → Providers → Tide row now manages tide providers — preset
      tiles (tide's 14 presets incl. z.ai alt-URL + OpenCode Zen), name/API
      key/base URL/protocol fields, live `/models` fetch with recommended
      pre-checks, enable/disable + delete; writes go through new protocol
      commands (TideProviders/Add/Update/Delete/ProbeModels, PROTOCOL_VERSION
      5, TS bindings regenerated) into tide config + keychain via
      tide-store. Model picker rows now show the alias first with the
      provider name in the sub-line, and default effort tiers are tide's
      minimal…max vocabulary.
- [x] Exact-match provider screen + wizard + selector (2026-08-29 late):
      Settings split into CLI (old page) + Providers (tide screen); 4-step
      wizard overlay w/ detect-race gate, Auto-Detect, models.dev+OpenRouter
      enrichment (ported, tests green), three-section model list, review,
      edit/delete; picker rows = alias + brain/eye + ctx · price sub-line.
      Protocol v6; TS bindings regenerated; 755 tests green.
- [x] Tide crates vendored into tide/crates (moved 2026-08-31):
      tide-engine/tide-tools/tide-store copied from tide's src-tauri/crates,
      agent prompts (.md, 9 files) into tide-tools/src/prompts/agents with
      SOURCES include_str!s repointed, workspace inheritance de-resolved to
      literals (0.4.0-beta.2 / edition 2021), tide-repo version-guard tests
      dropped; tide builds standalone — no ../../../tide path deps remain.
- [x] Tool-result call-id pairing fixed (2026-09-02): streamed ToolCall
      events carry rig's internal correlator ids while the step message
      replays provider-issued ids — results answered the wrong namespace, so
      Anthropic-style endpoints (z.ai) silently dropped them and the model
      read its tool output as empty ("the workspace is empty" despite a
      successful list_dir). Ported the tide orchestrator's `map_call_ids`
      (match by (name, arguments) in order) into `driver/tide.rs`.
- [ ] Live smoke run (needs Yogi): pick Tide in the new-task provider list.
- [x] Permission gate reworked to Tide's Plan/Build chip alone (2026-09-02):
      tide's PermissionGate/AutonomyMode mapping, workspace rules, session
      "always allow" rules, and permission cards removed from the driver;
      Plan allows read-tier calls only (rejections surface as completed
      activities), Build runs everything; the composer hides the RuntimeMode
      access dropdown on Tide sessions (the Plan/Build chip replaces it).
- [ ] Phase C leftovers: prune/feature-gate CLI drivers; revisit Settings →
      Daemon page copy (the page still describes a separate daemon process).
