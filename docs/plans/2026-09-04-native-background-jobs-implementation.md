# Native Background Jobs — Implementation Plan

Date: 2026-09-05 (rewritten against the post-removal tree). Companion to
`2026-09-04-native-background-jobs-design.md` — the design owns the
decisions, this file owns the order and the file map. Stage 0 has already
landed; stages 1-6 build on the code as it exists today.

**Landing rule.** Stages 1-3, 5, and 6 are behavior-additive: nothing they
ship changes what the model has been told. Stage 4 is the behavior flip —
the wake and every prompt/description change land in the same change. The
one invariant that must never be violated mid-sequence: no prompt text
promises notification before the wake delivers it (design, Consequences).

## Stage 0 — CLI providers removed — LANDED

Verified in the tree: the provider drivers, session modules, and pools
are gone (`crates/backend/src/driver/` holds only `activity.rs`,
`hooks.rs`, `inbox.rs`, `mod.rs`, `tide.rs`); `ProviderKind` is
`Tide`-only; `ProbeProvider`/`FetchPlanUsage`/`ProviderProbe` and the
`disabled_providers`/`provider_binary_overrides` settings exist only as
legacy-persistence test fixtures; `BackgroundModel` is `Tide`-only;
`Monitor`/`Monitoring`/`ReconcileProcesses` no longer exist in
`crates/protocol` or the UI reducer; `is_stoppable` is already
`Starting | Running`; `stop_background_work`/`refresh_background_work`
are trait defaults nothing overrides yet.

**Open residue (fold into stage 1's PR, it is one locale commit):**
`background.monitor` and `background.status.monitoring` are still live
keys in `locales/ja.yml` (~lines 807/836) and `locales/zh-CN.yml`
(~lines 766/795); `locales/app.yml` is already clean. Remove them
symmetrically and re-run the settings-search keyword assertions.

## Stage 1 — the registry (`crates/tools/src/jobs/`)

New module, engine-free, no driver dependency. Two Cargo facts to act on
(both verified, both contradict the earlier draft of this plan):

- `crates/tools` **already depends on tokio** (`Cargo.toml`, features
  `["rt"]`). Add the `sync` feature for `tokio::sync::watch` and use it
  directly — there is no async-behind-a-feature surface and no
  `jobs::async_api` split.
- The registry imports `BackgroundWorkKey`, `BackgroundWorkStatus`, and
  `BackgroundWorkKind` from `crates/protocol`. This is a **new
  tools→protocol edge**; it is cycle-free (protocol has no tools
  dependency). Job ids and statuses are wire types from day one, so
  nothing is re-mapped at the driver boundary.

### `jobs/mod.rs`

- `pub struct JobRegistry` — all state behind one `Mutex` (the tools
  crate is sync; the orchestrator bridges with its runtime, the same
  discipline `ShellRegistry` follows today).
- Per session: `HashMap<BackgroundWorkKey, JobRecord>` + insertion-order
  `Vec<BackgroundWorkKey>` (the UI reorders; the registry preserves
  registration order) + per-prefix counters.
- `JobRecord { key, label, session_id, output_limit, status, detail,
  started_at_ms, finished_at_ms, reported, buffer: Option<JobBuffer>,
  output: Option<String>, hooks: Option<JobHooks>, settled: watch
  sender + cached outcome }`.
- `JobBuffer` — `Mutex<{ text (256 KB ring), model_cursor, ui_cursor }>`;
  `read_model()` advances only `model_cursor`, `read_ui()` only
  `ui_cursor`; trimming min-clamps both cursors (the discipline
  `ShellRegistry` applies to its single cursor today).

### `jobs/api.rs`

- `start(spec: JobStart) -> Result<BackgroundWorkKey, JobError>` —
  **all-or-nothing under the session lock** (design, "Start is
  all-or-nothing"):
  1. validate: non-empty label; `output_limit` is `None` or `0 < limit`
  2. admission: live count (`Starting`/`Running`/`Stopping`) for
     `owner_session` ≥ `max_concurrent_jobs_per_owner` → typed
     `JobError::AdmissionLimit { limit }` (the tool renders its copy)
  3. allocate the id: `spec.id` if supplied (subagent `child_id`),
     else mint `<prefix>-N`; a failed start consumes the counter
  4. insert the record (`Starting`), emit `Upsert(Starting)`
  5. call `spec.run(&handle)`; on success flip `Running`, emit `Upsert`;
     on panic settle the record `Failed` with the panic in `detail` —
     nothing vanishes silently and no ghost `Starting` survives.
  `run`'s contract (design, Architecture): quick, non-blocking, no
  awaits; it starts work and returns hooks. Because `settle` takes the
  same lock, an immediately-finishing producer cannot reorder events.
- `JobHandle { key, output: JobOutputSink }` — the sink appends bytes
  into the record's `JobBuffer`; a no-op for final-output jobs.
- `read(key, session, Reader::Model | Reader::Ui)` — session fence
  first; a terminal Model read sets `reported`; returns delta text plus
  a fresh snapshot.
- `wait(key, session, timeout, abort: &AbortFlag)` — resolves on
  settle, on timeout (returns the live snapshot; job untouched), or on
  **abort** (returns the live snapshot; job untouched — decision 11). A
  settled Model wait sets `reported`. The orchestrator calls this from
  tool bodies, which run under `spawn_blocking` (`spawn_gated_call`) —
  that is what makes `Handle::block_on` legal here; keep that
  justification in the doc comment, it is load-bearing.
- `kill(key, session, reason) -> KillOutcome { Requested,
  AlreadyFinished, Unknown }` — sets `Stopping` + `reported`, emits
  `Upsert`, calls `hooks.cancel` (sync, idempotent), emits
  `StopRequested`.
- `list_session(session)` — snapshots in registration order (feeds
  `ReconcileLive`).
- `settle(key, outcome)` — first-wins: writes terminal fields, releases
  waiters, emits `Upsert`, then runs the wake listener **last** and
  contained (a listener panic is logged, never propagated into the
  producer's `done` path).
- `set_event_sink(...)` / `set_waker(...)` — `Box<dyn Fn(...) + Send>`
  slots set once per session registry beside `Inner`. The event sink
  receives every `Upsert`/`OutputDelta`/`StopRequested`/`StopFailed`;
  the waker receives settlement notices. No transport types cross into
  the registry beyond the protocol enums it already imports.
- `close_session(session, grace)` — cancel live hooks **synchronously**
  (processes get their signals now), then spawn a reaper task on the
  runtime handle to await `done` bounded (5 s, then force-fail with an
  orphan detail — DSH's force-fail), mark everything `reported`, drop
  the records, emit final `Upsert`s. The reaper is a spawned task, not
  an inline await, because the caller (driver `Drop`) can be any thread
  and must not `block_on`.
- Config: `JobRegistryConfig { max_concurrent_jobs_per_owner: 10,
  stream_buffer_bytes: 256 * 1024 }`, defaults correct without a
  settings surface; wiring one is a later, optional slice.

### `jobs/wake.rs`

- `pub trait JobWake` exactly as the design specifies (`is_idle` /
  `inject_step` / `wake_turn`), `JobNotice { text, snapshot, source:
  NoticeSource }`, `WakeListener = Box<dyn Fn(JobNotice) + Send>`.
  No budget here — lane policy and budget live in the orchestrator's
  implementation, which reads loop state the registry must not see.

### Tests (`crates/tools/tests/jobs.rs`)

Port DSH's list, tide's states, plus the regressions this design adds:
id minting per prefix and per session; supplied-id adoption; failed
start consumes the counter and settles `Failed` (no events escape
except the terminal one); admission default and explicit;
`Stopping` occupies capacity, terminal releases it; two-cursor
isolation in both directions; ring trim keeps both cursors valid;
first-wins against a late producer outcome; kill sets `reported` and
the listener skips it; wait paths — settle, timeout, abort (job stays
live); listener panic containment; `close_session` force-fail under a
straggler; lock-ordering: settle-during-start cannot emit terminal
before `Upsert(Starting)`.

## Stage 2 — bash on the registry + the job tools

### `shell_registry.rs`

Shrinks to the process guard: `spawn` returns a handle exposing
`terminate()` and an exit watch; the buffer path moves into the
registry's `JobBuffer`. Keep the module temporarily as the subprocess
owner; delete it when the last caller migrates.

### `tools/bash.rs`

- `background: true` builds a `JobStart { kind: Process, prefix: "bash",
  id: None, ... }`; `run` forks, wires `cancel` = terminate, `done` =
  exit watch, and appends output through `JobHandle.output`.
- Result text: `started background job bash-1` plus the existing meta
  line. The tool result is final at ack time.
- Remove the `AbortFlag` tie for the background path only — foreground
  bash keeps it unchanged (decision 4).
- **The description rewrite does NOT happen here.** The ToolSpec still
  says "poll output via bash_output, stop via kill_shell", and that
  sentence stays true through this stage via the aliases below. The
  rewrite lands in stage 4.

### `tools/job_tools.rs` (renames `background_shell.rs`)

- `job_output(job_id, wait?, timeout_ms?)` — `RiskTier::ReadOnly`.
  Stream jobs: delta since the model's last read + `[status: ...]`.
  Final-output jobs: the stored result after settlement. `wait: true`
  clamps to `timeout_ms` (default 30 s, hard cap 600 s); timeout
  returns the running status, never cancels; the wait is abort-aware
  (decision 11).
- `job_list()` — `bash-1 [bash] running — cargo test`; `(no background
  jobs)` when empty.
- `job_kill(job_id, reason?)` — `RiskTier::Write` (matches today's
  `kill_shell`).
- `ToolContext` gains `runtime: Option<tokio::runtime::Handle>`
  (`None` → `wait: true` renders "waiting is unavailable in this
  context" — the same degrade pattern `workspace_id` uses). The
  orchestrator fills it at `ToolContext` construction; `session_id` is
  already filled there today — the registry becomes its first checker.
- Deprecation aliases, one release: `bash_output` and `kill_shell`
  stay registered with descriptions prefixed "renamed:", bodies
  forwarding to the job tools. The id parameter is looked up directly
  as a job id — old `sh_` ids correctly render the unknown-id copy (ids
  are session-scoped now; strictly safer than the process-global
  namespace).

### Tests (`crates/tools/tests/job_tools.rs`)

End-to-end against a real registry: background `sleep` → `job_output`
deltas → `job_kill` settles `Stopped`; wait timeout and abort paths;
admission rejection copy; alias forwarding; stale `sh_` id renders
unknown-id copy. Migrate the existing `background_shell` tests (spawn →
read → kill keeps its shape).

## Stage 3 — transport glue (still no contract change)

### `driver/tide.rs`

- `Inner` gains `jobs: Arc<JobRegistry>`, constructed in
  `TideDriver::start` — once per session, never recreated (options
  changes reconfigure in place; cancel only fires the per-turn flag).
- Wire the seams: `set_event_sink` → forward to
  `DriverEvent::BackgroundWork` on the existing emit path;
  `ToolContext` construction passes `runtime: Some(handle)`.
- **`OutputDelta` pusher**: a session-lifetime task on `inner.rt` that
  polls `registry.read_ui` for each live stream job every 250 ms and
  emits `OutputDelta` when non-empty (design, Buffers bullet). The UI
  keeps its existing `output_refresh_delay` throttling on top; the
  daemon push cadence and the UI refresh cadence are deliberately
  independent.
- `stop_background_work` (today an unoverridden trait default):
  map the key to a job → `registry.kill` → emit `StopRequested`; a
  `cancel` that panics or a `done` that never settles surfaces as
  `StopFailed` with the registry's diagnostic. The job id is the
  control id — there is no provider negotiation left.
- `RefreshBackgroundWork` (today a no-op default): answer
  `ReconcileLive { items: registry.list_session(id) }`.
- `Drop for TideDriver` keeps today's abort + `aborted_notify` and
  additionally calls `close_session` (sync cancel + reaper, stage 1).
- Test: fixture asserting the event order `Starting` → `Running` →
  terminal through the `DriverEvent` stream, `ReconcileLive` contents
  after settlement, and `StopRequested` → `Stopped` on
  `stop_background_work`.

## Stage 4 — the wake (the behavior flip; lands with its prompt change)

### `driver/inbox.rs`

`StepMessage` gains `source: StepSource { User, Job, Agent }`, default
`User` at every existing constructor — all current pushes are prompts
or agent messages.

### `driver/tide.rs`

- `OrchestratorWake implements JobWake`:
  - `is_idle()` — `!turn_active.load()`. Advisory lane-picking only.
  - `inject_step` — `inbox.push_step(StepMessage::job(text))`; the
    running loop drains it at the next boundary through the existing
    `step_input.rewrite(inbox.drain_step())` path, so N jobs settling
    in one turn still cost one step.
  - `wake_turn` — budget check → **the `prompt()` claim, verbatim**:
    `turn_active.compare_exchange(false, true)`; won →
    `spawn_turn(inner, notice.text)`; lost → `inbox.push_turn(text)`.
    Never push-then-spawn (the pushed copy would be popped and run
    again at this turn's end); never spawn unclaimed (`spawn_turn`'s
    only current callers, `prompt()` and `turn_finished`, both claim
    first — an unclaimed spawn puts two turn loops on one `Inner`, and
    each `run_turn` resets the abort flag).
  - Budget: a `Cell<u32>` beside the inbox; a successful `wake_turn`
    spends, consuming a `User`-tagged message refills. Default 3.
    On refusal, fall back to `inject_step` (DSH's degrade lane).
- Listener registered once at construction: settle → skip `reported` →
  render (`background job {id} ({kind}: {label}) finished [status:
  {status}{, detail}]. Read its output with job_output.`) → lane →
  deliver. For subagent jobs the `{id}` is the `child_id`, which the
  model already knows from the dispatch ack.
- Notices ride the ordinary prompt path (`push_user_message` at turn
  start), so model-visible ⟺ logged holds with no new transcript
  event kinds; steers already render as user-role turns, and
  `TurnStarted` is already unconditional post-removal, so either lane
  gets a proper turn boundary.

### Prompts and descriptions (same change — not before, not after)

- `prompts.rs` `tool_guidance()`: the background-jobs fragment from the
  design.
- `bash.rs`: the ToolSpec sentence and the `background` param
  description flip from poll-via-bash_output to notify-and-collect.
- `dispatch_agent.rs`: description gains the notification contract.
- Snapshot: `system_prompt()` output changes — update the composing
  test and add a content assertion for the jobs fragment.

### Tests

- Fixture (`fixture_tests.rs` / mock-SSE pattern): background bash
  started, turn ends, job settles → a new turn opens whose first user
  message is the notice, and `job_output` is called into the mock
  model. Second scenario: notice during an active turn drains at the
  next step boundary (same turn's `step/start`).
- Budget: three notices wake three turns; the fourth injects; a user
  prompt refills. Drive `OrchestratorWake` directly.
- Race regression: `wake_turn` concurrent with `prompt()` never yields
  two turn loops (drive both from test threads; assert a single
  `run_turn` entry).

## Stage 5 — background dispatch

- `run_dispatch` splits into `run_dispatch_foreground` (today's body)
  and `spawn_dispatch_background`: the child loop moves onto
  `inner.rt.spawn` with a **child-owned** `AbortFlag` (today
  `spawn_child` clones the turn's flag — that is the tie decision 4
  removes for jobs), and the producer registers with the registry as
  `JobStart { kind: Subagent, id: Some(child_id), prefix: "sub", .. }`
  — the job id **is** the `child_id` (decision 10).
- Hooks: `cancel` aborts the child's flag; `done` resolves when the
  child loop settles *and* the child state is stored in `Children`;
  the final report becomes `JobOutcome.output` (final-output job, no
  buffer). `SubagentBlocks` streaming is unchanged — it stays on the
  child-loop emit path, not the registry's.
- `Upsert` keyed by `child_id` with `background: true, can_stop: true,
  control_id = child_id`. The tool result is the one-line ack carrying
  the dispatch id; completion arrives as a wake notice.
- Depth gating (`MAX_AGENT_DEPTH`) and resumability (child state in
  `Children`, mailbox parking for `send_message`) are unchanged —
  background does not bypass the tree bound or the resume path, and
  because the job id is the durable id, `resumeFrom` keeps working
  against a background child exactly as against a foreground one.
- Tests: ack returns immediately; completion wakes the parent (reuse
  the stage-4 harness); `job_kill` mid-run settles `Stopped` and
  aborts the child loop; the Agents panel stream reaches settlement;
  foreground (durable id) and background items coexist in one
  `list_session` without collisions.

## Stage 6 — composer jobs indicator (UI)

Mockup: `docs/mockups/composer-background-jobs-indicator.html` (hover
the badge in stage A; stage B shows the pinned popup). It reads only the
client-side registry, so it may land at any point — before stage 1
even, since dispatch timelines already feed items — but it earns its
keep once stage 2's Process jobs exist.

### `src/app/chat_composer.rs`

- `render_composer_toolbar`'s right cluster gains the indicator in
  first position, before the submit control — Send/Stop/Preparing
  compose beside it unchanged, and the feature adds no control of its
  own outside the popover.
- The indicator is a 26×26 hover target holding a 17px accent pill with
  the **running-job count** for the selected session — badge only, no
  icon, no spinner; the number is the state. Hidden entirely when the
  running count is 0; it disappears when the last job settles.
- Data: `background_work_counts` / `session_has_live_background_work`
  for the selected session. No new tick — the existing
  `background_changed` notify and `BACKGROUND_WORK_TICK_INTERVAL`
  refresh already cover re-render, and elapsed times tick from the same
  path.

### `src/app/background_work.rs`

- Hover popup, pinned open while the pointer is inside (not
  `Tooltip::text` — the rows are interactive): header `Background jobs`
  plus an `Agents panel →` link
  (`open_right_panel_surface(RightPanelSurface::Agents)`); rows from
  `ordered_items()` — status glyph (static blue dot for live, dimmed
  check for settled), job id in mono, label, elapsed time, and a
  per-row stop on row hover through the existing `stop_background_work`
  path; settled rows dim under a separator. No stop control anywhere
  outside the popover.
- Locale: one new key (`background.jobs.title`); status and count
  labels reuse the existing `background.*` keys.
- Tests: badge hidden at zero live and matching `background_work_counts`
  otherwise; popup rows in registration order with the dimmed settled
  tail; row stop routes through the covered `stop_background_work` path.

## Known leftovers (accepted)

- `DriverStartOptions.binary`/`agent_preset` and the
  `AgentPresetSelected`/`PlanUsageUpdated` events still exist in the
  wire and client plumbing, fed `None`/matched-and-ignored from `src/`.
  Harmless with a single provider; removal is a separate
  protocol-hygiene pass.
- `DriverEvent::ProcessExited` handling stays — the tide driver can
  still emit it for daemon-owned process groups.

## Risk notes

- **Sync registry, async loop.** No lock is held across an await;
  `settle`'s listener runs after the lock drops (the children
  `Mutex` discipline). `start` holds the lock across `run()`, which is
  safe because `run` is contractually quick and non-blocking — the
  contract is asserted in tests with a slow-`run` producer.
- **Blocking-pool legality.** `Handle::block_on` in `job_output` waits
  is legal because tool bodies run under `spawn_blocking`; the serial
  path shares `run_gated_call`, so both paths keep that guarantee.
  A `wait` never occupies a runtime worker.
- **Notice storms.** N settles during a turn cost one drained step; N
  settles while idle cost at most `max_consecutive_wakes` turns, then
  degrade to inject. The budget is the storm valve.
- **Alias window.** Old `sh_` ids never resolve — correctly: ids are
  session-scoped, strictly safer than today's process-global ones.
  Stored prompts naming `bash_output`/`kill_shell` keep working through
  the aliases for one release.
- **Coverage gate.** `crates/tools/src/jobs` lands fully covered; the
  orchestrator stages extend files that are already covered.
