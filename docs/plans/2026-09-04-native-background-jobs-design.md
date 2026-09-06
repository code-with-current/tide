# Native Background Jobs — Design

Date: 2026-09-04. Scope: the background-work layer for tide's own agent stack
(`driver/tide.rs` loop + `crates/engine` + `crates/tools`), built on the
CLI-provider removal: the provider integrations (`driver/{claude,codex,amp,
opencode,deepseek,pi,acp}.rs`, the per-provider session modules and pools),
the CLI wire surface (`ProbeProvider`, `FetchPlanUsage`, `ProviderProbe`,
`DaemonSettings.disabled_providers`/`provider_binary_overrides`), and the CLI
UI are deleted; `ProviderKind` is `Tide`-only. Companion: the implementation
plan (`2026-09-04-native-background-jobs-implementation.md`).

Reference architecture: DeepSeek Harness's background-job runtime
(`ctx.jobs` registry / `tool-jobs` controls / settlement-wake chain), studied
in `.dsh-research/deepseek-harness/` (`docs/subsystems/jobs.md`, notes
`2026-06-20-generic-long-running-tool-runtime.md`,
`2026-08-11-background-job-completion-wakes-an-idle-owner.md`,
`2026-08-08-web-background-job-display.md`). Where tide already solved a
problem differently and well, tide wins; DSH fills the holes.

## Problem

The CLI providers were the only producers that ever fed `BackgroundWorkItem`s
to the UI (Claude's background bash, monitors, Task subagents), and the
removal took them with it. What remains is tide's native stack, whose
background support is three disconnected pieces:

- `crates/tools/src/shell_registry.rs` — process-global `sh_N` shells with a
  256 KB ring buffer and a consuming read cursor. No session fence, no
  lifecycle states beyond `exited`, no completion notification, and the UI
  never sees them.
- `crates/backend/src/driver/tide.rs` dispatched children — rich per-session
  state, block timelines, mailboxing, but strictly synchronous
  (`background = false`): a `dispatch_agent` call awaits the whole child run.
- The `BackgroundWork*` protocol and the entire GPUI surface
  (`src/app/background_work.rs`, summary card, right panel, Agents panel) —
  driver-agnostic, alive, and fed by nothing native except dispatch
  timelines.

A model that starts a dev server with `bash background:true` gets a `shell_id`
and a poll loop. Nobody tells it when the command exits or fails; if the turn
ended, nothing will, because the shell cannot reach the loop. That is the gap
this design closes.

## Decisions

1. **One registry owns background work.** A per-session `JobRegistry`
   (daemon-side, in `crates/tools/src/jobs/`) subsumes `ShellRegistry` and the
   live half of the children registry. Producers register hooks; the registry
   owns ids, status, settlement, admission, and observation. Shells and
   dispatched children become job kinds, not parallel mechanisms.
2. **The registry emits the existing `BackgroundWorkEvent` variants**
   (`Upsert`, `OutputDelta`, `SubagentBlocks` from the child loop,
   `ReconcileLive`, `StopRequested`, `StopFailed`) and every UI surface
   keeps working without new shapes; `provider_id` keeps its name on the
   wire and carries the job id — the registry-minted `bash-N` for Process
   jobs, the durable `child_id` for Subagent jobs (decision 10). The
   CLI-only members are already gone with the removal: `Monitor`,
   `Monitoring`, and `ReconcileProcesses` no longer exist in the protocol
   or the reducer, and `is_stoppable` is already `Starting | Running`.
   This design builds on that landed state; the only residue it cleans up
   is the dead locale keys (`background.monitor`,
   `background.status.monitoring` still present in `ja.yml`/`zh-CN.yml`).
3. **Settlement wakes the loop.** A job settling during an active turn
   injects a notice at the next step boundary (`inbox.push_step`). A job
   settling on an idle session opens a follow-up turn, bounded by a
   per-session wake budget (default 3, refilled only by user input).
   Opening the turn goes through the same claim `prompt()` uses —
   `turn_active.compare_exchange(false, true)`; won → `spawn_turn(text)`,
   lost → `inbox.push_turn` (held for the next turn). `spawn_turn` is a
   raw spawner whose only current callers claim first; a wake that pushed
   and spawned without claiming could run two turn loops on one `Inner`
   and would duplicate the notice (the pushed copy is popped again at
   this turn's end). This is DSH's chain, ported; tide now owns the loop,
   so it is finally implementable.
4. **Background jobs detach from the turn's abort flag.** Today
   `ShellRegistry::spawn` ties the shell to the spawning turn — stopping the
   turn kills the dev server the model was told to poll across turns. Under
   the registry, a published job dies only by `job_kill`, session close, or
   daemon teardown. The abort tie was compensation for having no completion
   path; the wake removes the reason.
5. **Tool surface renames to the job vocabulary**: `job_output`,
   `job_list`, `job_kill` with a `job_id` parameter, replacing
   `bash_output`/`kill_shell`. `dispatch_agent` gains `background: true`.
6. **Two read cursors, never one shared.** The model's `job_output` and the
   UI's `OutputDelta` stream consume independent cursors over the same
   buffer. DSH's invariant ("no UI path ever calls the model's read") becomes
   "no reader ever advances another reader's cursor."
7. **`Monitor` and the CLI probe surface are deleted, not preserved.** No
   persisted record carries `Monitor` (`SubagentRun` rows carry no kind;
   background-work items live only in process memory), and the desktop and
   daemon ship together, so deleting variants costs no compatibility window.
8. **Admission is per session**: `max_concurrent_jobs_per_owner` (default 10,
   counting live jobs), rejection before `run()` with actionable copy
   ("kill one with job_kill, then retry").
9. **The background-model override collapses to tide-only — already
   landed.** `BackgroundModel` is `Tide`-only in the code today; the
   `Cli` arm went with the drivers. Nothing for this design to do beyond
   not reintroducing the choice.
10. **Job identity splits by kind.** Process jobs get a registry-minted
   `bash-N` (producer-chosen prefix, per-session counter). Subagent jobs
   adopt the child's existing durable `child_id` as the job id:
   `key.provider_id` for subagent items *is* the persisted
   `SubagentRun.child_id` and the model-facing `dispatchId` (the
   resumeFrom target), so a per-session counter would collide across
   sessions in the persisted store and mix two id schemes in one panel.
   One rule everywhere: the job id is the `provider_id` is the
   `control_id`.
11. **Waiting is abort-aware even though jobs are not.** Decision 4
   detaches the job from the turn's abort flag; `job_output` with
   `wait: true` must still return promptly when the turn aborts — the
   wait selects settlement-or-timeout against the caller's `AbortFlag`.
   A detached job surviving a stopped turn must not leave the stopped
   turn's step blocked for up to the 600 s cap.

## Architecture

### The registry (`crates/tools/src/jobs/`)

Lives in `crates/tools` because both sides of the seam already depend on that
crate: producers are tools, and the orchestrator imports tool infrastructure
today (`TurnInbox` stays in the driver tree; the registry must not depend on
it — the wake handle is a trait object, see below). Engine-free, like
`shell_registry`.

Placement rule: the registry's lifetime is the daemon session, never a
turn. Cancel does not drop the driver — `cancel()` only fires the
per-turn `AbortFlag`, and the `Inner` (runtime, history, inbox) lives for
the driver's lifetime — so the forcing function is the crate boundary,
not cancel semantics: the registry lives in `crates/tools`, below the
driver tree it must not depend on, so it is keyed by `SessionId`,
parameterized over the wake and event seams, and held by `Inner` (created
once per session at driver start, never recreated — options changes
reconfigure in place). Jobs die only by `job_kill`, session close, or
daemon teardown.

```rust
pub struct JobStart {
    pub kind: JobKind,                 // re-export of BackgroundWorkKind (Process | Subagent)
    pub id: Option<String>,            // None → registry mints "<prefix>-N" (decision 10)
    pub prefix: &'static str,          // mint prefix; "bash" for the shell producer
    pub label: String,                 // the command; the dispatch task
    pub owner_session: SessionId,      // fence + cleanup scope
    pub output_limit: Option<usize>,   // producer-owned cap on model-facing reads/notices
    pub run: Box<dyn FnOnce(&JobHandle) -> JobHooks + Send>,  // called once, after preflight + admission
}

pub struct JobHandle {
    pub key: BackgroundWorkKey,
    pub output: JobOutputSink,         // stream jobs append bytes; no-op for final-output jobs
}

pub struct JobHooks {
    pub cancel: Box<dyn FnOnce(Option<String>) + Send>,   // sync, idempotent, must settle done
    pub done: JobDone,                                    // watch channel; settles after resources release
}

pub struct JobOutcome { pub status: SettledStatus, pub detail: Option<String>, pub output: Option<String> }
```

`run` is quick and non-blocking — it starts work and returns hooks (the
bash producer forks and spawns its exit watch; the dispatch producer
`rt.spawn`s the child loop); it must not await. It is a boxed `FnOnce`,
not a fn pointer, because producers close over context (the dispatch
producer needs the runtime handle and the child's flag). The registry
owns the stream buffer, so there is no producer-side `read_output` hook
to get the two-cursor rule wrong — producers append through
`JobHandle.output` and the registry serves both readers. One new crate
edge this implies: `crates/tools` imports `BackgroundWorkKey`/
`BackgroundWorkStatus` from `crates/protocol` (cycle-free — protocol has
no tools dependency), so job ids and statuses are wire types from day
one.

Registry responsibilities, each ported from DSH with tide's states:

- **Ids**: the job id is the `provider_id` is the `control_id` (decision
  10) — `bash-N` minted per session from a producer-chosen prefix for
  Process jobs (DSH's counter scheme; kills the `sh_N` namespace), or the
  producer-supplied durable `child_id` for Subagent jobs. The
  `BackgroundWorkKey` wraps it for the wire.
- **Statuses**: the existing `BackgroundWorkStatus`. `Starting` covers
  DSH's pre-`running` window; `Stopping` means cancel requested but resources
  not released (still occupies admission capacity); `Lost` only ever arrives
  from the transport path, never from the registry.
- **Settlement is first-wins**: one terminal record; a late producer outcome
  cannot overwrite it. Waiters (job_output with `wait: true`) resolve before
  listeners run; listeners run last, contained, because a listener may open a
  turn.
- **`reported` bit**: kill, terminal read, a settled wait, or teardown cancel
  marks the job reported; the wake listener skips reported jobs. This is what
  keeps `job_kill` from producing a notice about a death the model caused.
- **Fencing**: reads, waits, and kills take the caller's session; a job is
  reachable only by its owner session (jobs are always owned in tide — the
  unowned-open bucket is a DSH hosting detail tide does not need).
- **Admission**: per owner session, live jobs (`Starting`/`Running`/
  `Stopping`) counted against `max_concurrent_jobs_per_owner`. Rejection is a
  typed error carrying the copy the tool renders.
- **Buffers**: the registry owns the stream buffer (256 KB ring — the
  shell's bound moves in). Two cursors per job: `model_cursor` advanced
  by `job_output`, `ui_cursor` advanced by the orchestrator's
  `OutputDelta` pusher — a session-lifetime task on `inner.rt` that
  polls `read_ui` at a fixed cadence (250 ms) and emits `OutputDelta`
  when non-empty; the UI keeps its existing `output_refresh_delay`
  throttling on top. `output` (final-output jobs, e.g. background
  dispatch results) is stored once at settlement and served idempotently
  to both readers.
- **Event sink**: the registry never touches transport. A `JobEventSink`
  closure, set once beside the waker, receives every `Upsert`/
  `OutputDelta`/`StopRequested`/`StopFailed`; the orchestrator's
  implementation forwards to `DriverEvent::BackgroundWork`.
- **Start is all-or-nothing**: `start` holds the session lock across
  insert → `Upsert(Starting)` → `run()`. A `run` that panics settles the
  record `Failed` (detail carrying the panic) rather than silently
  vanishing — no ghost `Starting` item outlives a failed start, and
  because `settle` takes the same lock, no event-ordering race exists.

### The wake handle (`crates/tools/src/jobs/wake.rs`)

The registry must open a turn without knowing what a turn is. `crates/tools`
defines the seam; the orchestrator implements it:

```rust
pub trait JobWake: Send + Sync {
    /// True while the session's loop is between turns.
    fn is_idle(&self) -> bool;
    /// Busy lane: notice lands at the running turn's next step boundary.
    fn inject_step(&self, notice: JobNotice);
    /// Idle lane: notice opens a follow-up turn. Returns false when the
    /// budget refuses; the caller then uses inject_step.
    fn wake_turn(&self, notice: JobNotice) -> bool;
}
```

`JobNotice` carries the rendered notice text, the job snapshot, and a source
tag (`JobNoticeSource::Job`). The orchestrator's implementation, built once
per session next to `Inner`:

- `is_idle()` reads `turn_active` (the existing `AtomicBool` — the same
  predicate DSH reads off `owner.status`).
- `inject_step` → `inbox.push_step(...)`. The running loop drains it at the
  next boundary through the existing `step_input.rewrite(inbox.drain_step())`
  path; a turn cannot close over pending step input (existing behavior —
  DSH's "several jobs settling together cost one step" falls out for free).
- `wake_turn` → budget check → **claim the turn exactly the way
  `prompt()` does**: `turn_active.compare_exchange(false, true)`; won →
  `spawn_turn(inner, notice.text)`; lost → `inbox.push_turn(...)`, held
  for the next turn exactly like a prompt that lands mid-turn. Never
  push-then-spawn: `spawn_turn` is a raw spawner (its only current
  callers, `prompt()` and `turn_finished`, both claim first), so an
  unclaimed spawn can put two turn loops on one `Inner` — each `run_turn`
  resets the abort flag — and the pushed copy would be popped and run
  again at this turn's end. `is_idle()` is advisory lane-picking only;
  the claim is the race guard. `StepMessage` gains a `source` field so
  the budget can distinguish a user-authored claim (refill) from a job
  notice (spend). The budget lives in the wake implementation
  (`max_consecutive_wakes`, default 3), not in the registry — it is a
  loop policy, not a job fact.
- Abort interplay: `spawn_turn` after an aborted turn already converges
  through the existing queued-prompt path. Session close calls
  `registry.close_session(id)`: cancel live jobs synchronously
  (`hooks.cancel` is sync — processes get their signals now), then a
  reaper task on the runtime handle awaits `done` bounded (5 s, then
  force-fail with an orphan warning), marks records reported, and drops
  the session's records. The reaper is a spawned task, not an inline
  await, because the caller (driver `Drop`) can be any thread and must
  not `block_on`. The transport's `mark_live_lost` keeps handling the
  *daemon-loss* case, which is a different failure (registry dead, work
  state unknown).

### Orchestrator changes (`driver/tide.rs`, moving with the loop)

- **Construction**: `Inner` gains `jobs: Arc<JobRegistry>` (created once
  per session at driver start) and `wake: Arc<OrchestratorWake>`; the
  registry gets `set_event_sink` (forwarding to
  `DriverEvent::BackgroundWork`), `set_waker(wake.clone())`, and the
  wake listener registered once: settle → if `snapshot.reported` skip →
  budget lane → render notice → deliver. The notice text is DSH's shape,
  tide's tool names: `background job bash-1 (bash: cargo test) finished
  [status: completed]. Read its output with job_output.` The
  `OutputDelta` pusher task (Buffers bullet) starts here too.
- **`run_dispatch` splits.** Foreground keeps today's await-inside-the-call
  semantics (`background` absent/false). `background: true` moves the child
  loop onto `inner.rt.spawn` with its own `AbortFlag`, registers hooks with
  the registry (`cancel` aborts the child's flag; `done` resolves when the
  child loop settles *and* the child state is stored), and emits the
  `Upsert` keyed by the child's durable id — `background: true,
  can_stop: true, control_id = child_id`, which is the job id (decision 10).
  The child's final report lands in the job's `output` (final-output job —
  no read cursor); the block timeline keeps streaming via `SubagentBlocks`
  exactly as today. The returned tool result is the one-line ack with the
  job id; the child's completion arrives as a wake notice.
- **`stop_background_work`** (driver trait): map the key to a job,
  `registry.kill(key, reason)`, emit `StopRequested`; a producer whose
  `cancel` panics or a `done` that never settles surfaces as `StopFailed`
  with the registry's diagnostic. There is no provider `control_id`
  negotiation; the job id is the control id.
- **`RefreshBackgroundWork`** answers from the registry:
  `ReconcileLive { items: registry.list_session(id) }` — the registry is the
  only source of background state in the process.
- **Teardown ordering** (session drop / daemon stop): close listeners →
  cancel live jobs synchronously (`hooks.cancel` is sync — processes
  get their signals now) → a reaper task on the runtime handle awaits
  `done` bounded (e.g. 5 s, then record `failed` with an orphan warning —
  DSH's force-fail) → drop records. The reaper is spawned, not
  inline-awaited, because the caller (driver `Drop`) can be any thread
  and must not `block_on`. Matches the existing `cancel` +
  `aborted_notify` convergence, which stays the single quiescence point.
- **CLI leftovers are gone with the drivers**: `background_task_kinds`,
  `pending_task_stops`, the `BackgroundModel::Cli` arm, the claude
  task-output tail threads, and the provider binary probe plumbing left in
  the removal; the background design builds only on what remains.

### Tools

- `bash.rs` — `background: true` calls `jobs::start` with
  `JobKind::Process` and prefix `"bash"`; the producer's `run` forks and
  appends output through `JobHandle.output` (`cancel` = terminate,
  `done` = exit watch — no `read_output` hook; the registry owns the
  buffer). The result text becomes `started background job bash-1` plus
  the existing meta line. The tool result is final at ack time; the
  tool-call abort no longer reaches the job (decision 4).
- `background_shell.rs` → `job_tools.rs` — three tools:
  - `job_output(job_id, wait?, timeout_ms?)` — stream jobs return the delta
    since the model's last read plus `[status: ...]`; final-output jobs
    return the stored result after settlement. `wait: true` bounds at
    `timeout_ms` (default 30 s, hard cap 600 s, clamped); a timeout returns
    the running status and never cancels, and the wait selects
    settlement-or-timeout against the turn's `AbortFlag` (decision 11) so
    an aborted turn unblocks immediately. Tool bodies execute on the
    blocking pool, which is what makes bridging the settlement watch
    through a runtime handle legal. RiskTier::ReadOnly.
  - `job_list()` — `bash-1 [bash] running — cargo test` lines; `(no
    background jobs)` when empty.
  - `job_kill(job_id, reason?)` — `registry.kill`; renders
    `requested cancellation of job bash-1` or the already-settled status.
    RiskTier::Write (matches today's `kill_shell`).
  All three resolve through the registry with the `ToolContext::session_id`
  fence. The orchestrator already fills `session_id` (and `workspace_id`)
  at `ToolContext` construction — the gap this design closes is that
  nothing *checks* the field today; the registry is its first consumer.
- `dispatch_agent.rs` — schema gains
  `background: boolean` ("Set true for long-running delegated work: the call
  returns the job id immediately; the child streams into the Agents panel and
  its completion is delivered to you"). Description text updated for the
  polling-to-notification change; the tool catalogue doc
  (`build_skill_catalog_md` consumers) picks it up automatically.
- Prompts (`crates/tools/src/prompts.rs`) — new fragment in
  `tool_guidance()`, DSH's guidance with tide's names:

  > Track every background job id you start (bash background:true,
  > dispatch_agent background:true). You are notified in-session when a job
  > finishes — do not poll or sleep on one; keep working on independent
  > steps and do not duplicate a running job's work. Before giving a final
  > answer, collect every still-relevant job with job_output (set wait:true
  > only when you are genuinely blocked on it), and job_kill jobs that
  > stopped mattering.

  The existing bash description's "poll output via bash_output, stop via
  kill_shell" sentence (in the bash ToolSpec and its `background` param
  description, not in `tool_guidance()`) is rewritten to the
  notify-and-collect contract in the same change as the wake itself —
  until the wake exists, the old poll text stays true through the
  deprecation aliases, and it must never over-promise before the wake
  delivers. Stale prompt text next to a wake system is the failure mode
  DSH's note calls out ("the prompt told the model not to poll, and then
  nothing arrived" — inverted: tide must not promise what it does not
  deliver, and after this design it delivers).

### Protocol and UI (minimal deltas, listed for completeness)

- The registry emits existing variants; `BackgroundWorkItem` fields are
  sufficient (`SessionJob` does not exist and is not added). `report`ed,
  cursors, and the budget never reach the wire (matching DSH's deliberate
  omissions of `reported`/watermarks). The CLI-only members were already
  deleted with the provider removal — `Monitor`, `Monitoring`,
  `ReconcileProcesses` are gone from protocol and reducer; the one
  residue to scrub is the dead locale keys still in `ja.yml`/`zh-CN.yml`.
- The right panel's stop button now terminates native work; `StopFailed`
  reverts live status exactly as the reducer already does.
- New surface — the composer indicator: beside the send/stop control, a
  count-only badge (the selected session's running jobs, no spinner)
  whose hover popup lists the jobs with per-row stop and the
  Agents-panel link. It reads the client-side registry only and adds no
  control outside the popover; mockup at
  `docs/mockups/composer-background-jobs-indicator.html`.
- The summary card picks up native Process items with no code change; the
  foreground-noise filter (`upsert`'s `background && !already_background`
  early-keep) does exactly the right thing: ack'd background jobs persist,
  settled foreground dispatches vanish from the summary while the Agents
  panel keeps them.
- `trim_settled` keeps capping the settled tail; `MAX_SETTLED_BACKGROUND_ITEMS`
  needs no tuning for native volumes yet.
- The CLI UI (provider pickers, the settings CLI page, plan-usage panels,
  session list provider filters) is deleted with the providers; the
  Providers screen and wizard — which manage tide's own configured
  endpoints — stay and become the only provider surface.

## Consequences

- The model's contract changes from "poll until it looks done" to
  "start, continue, get told." The promise — prompt text and bash
  description — flips in the same change as the wake; the job tools may
  land earlier because the deprecation aliases keep the old poll
  contract true in the window. What must never happen is the prompt
  promising notification before the wake delivers it.
- Detaching jobs from turn abort changes user-visible behavior: stopping a
  turn no longer kills background shells. The transcript ack already says
  the job keeps running, so the honest fix is the detach, not the copy.
- The 256 KB shell buffer bound now serves two readers; `OutputDelta` push
  throttling follows the existing UI refresh cadence
  (`output_refresh_delay`), not the buffer's write rate.
- Killing `kill_shell`/`bash_output` breaks any stored prompt or skill that
  names them; the deprecation window (tools still registered under the old
  names, descriptions saying "renamed to job_kill") bounds the blast radius
  to one release.
- The wake budget is refilled only by user input. An unattended session
  whose budget exhausts collects notices on the next turn something else
  opens — accepted, matching DSH, because the alternative (time-based
  refill) re-arms a self-exciting loop nobody is watching.

## Explicitly deferred

- Durable job history across daemon restarts for Process kind (subagent runs
  already persist). Nothing native outlives the daemon yet; when one does,
  the registry's start/read contract needs the identity work DSH also
  deferred.
- Human-initiated output streaming into the right panel for *dispatch*
  children (blocks already stream; plain text output streaming is a
  presentation follow-up).
- Unowned jobs (daemon-level work with no session). Tide has no caller that
  is not a session; the fence stays total.
- Promotion of foreground calls to background and cross-session job
  visibility — both rejected by DSH for want of a current consumer, and tide
  has none either.
