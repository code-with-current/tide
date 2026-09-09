# Inspector Panel — Port the upstream Inspector column into Tide

Status: REVISED 2026-09-04 (supersedes the 2026-08-30 draft; re-analyzed
against the post-rebrand, post-dsh-port codebase). Brings the upstream
Inspector column (session-at-a-glance, `code-with-current/tide`, checked out
at /Volumes/512gb/TestAi/tide, `src/components/chat/inspector/`) into this
app as a new `src/app/inspector/` module, following the timeline_v2
discipline: new folder, one seam, no timeline_v2 edits.

## 0. Premises invalidated since the 2026-08-30 draft

The draft predates the rebrand, the dsh orchestrator port, and the Git panel
port. Five of its premises are now false, and this revision is mostly the
consequence of those:

1. **Naming.** The app is Tide: crate `tide`, entity `Tide` (src/app.rs:1026),
   module root `src/app.rs` (no mod.rs), tests `cargo test -p tide`. All
   `waku`/`-p waku` references are dead.
2. **The gate is not RuntimeMode anymore.** Tide sessions gate on the
   Plan/Build `InteractionMode` (`session.interaction_mode`,
   protocol/src/model.rs:930; chip renderer composer.rs:1381-1453). The Tide
   driver no longer emits `Permission` at all — `respond` is a no-op,
   "the Plan/Build chip is the whole gate" (driver/tide.rs:336-339);
   interactive asks ride `UserInputRequested` → `runtime.pending_user_input`
   (app.rs:858). `RuntimeMode` (model.rs:293) survives only for non-Tide
   drivers, whose access dropdown remains (composer.rs:1178-1263).
3. **UsageUpdated is thin.** `DriverEvent::UsageUpdated` carries only
   `{context_tokens, context_window}` (model.rs:1825-1828) — no token
   breakdown. The rich `EngineUsage` (input/output/cache_read/cache_write/
   reasoning/calls/cost_usd, engine/src/events.rs:23-31) is already in the
   driver's hands per turn (driver/tide.rs:1425-1438) but is collapsed to a
   sum at :1439-1453. The token grid needs an additive wire extension, not
   just an accumulator. Also: a footer context meter already exists
   (usage_meter.rs, ring glyph, reads `session.context_usage`) — the
   inspector must add detail, not duplicate the ring.
4. **Ports events never existed here.** `ChatPush::TerminalPorts/ScriptPorts`
   are the TS app's event names; there is no `ChatPush`, no `detect_ports`,
   no `src/app/commands/` in this codebase. A Ports section is new detection
   plumbing (terminal-grid + background-work output scanning), not wiring —
   deferred to an optional task.
5. **A full Git panel now exists** (git_panel.rs, 5 s refresh while visible,
   activation hook right_panel.rs:7186) holding `git_panel.status`
   (per-file staged + diffstat), `git_panel.ahead_behind`, plus the shared
   `branch_snapshots` QueryCache (app.rs:1228). The inspector Git section is
   a pure read of that state plus one open-panel action.

Two draft risk items dissolved: no stored window-width field is needed (read
`window.viewport_size()` per frame, the pattern at render.rs:164-168), and
the permission-reorder rule is gone (a pending ask's fix is the inline
transcript card / composer chip, not the inspector — section order is
static). The skeleton is dropped too: all inspector data is synchronous
in-memory state; cold git data degrades to a hidden section, not a spinner.

## 1. Components checked (upstream → Tide mapping)

| upstream (src/components/chat/inspector/) | role | Tide plan |
|---|---|---|
| inspector-column.tsx | 300px floating card, hugs top | `inspector/mod.rs` pane root; in-flow sibling of the chat's working region (transcript→composer), consuming layout width (revised post-execution, see §2) |
| inspector-visibility.ts | show iff session ∧ ¬rightPanelOpen ∧ width ≥ 1400 | same rule: session selected ∧ right panel closed (`panels.right_panel <= 0.0`, the render gate at render.rs:390) ∧ viewport width ≥ 1400 |
| inspector-tab.tsx | accordion stack of sections | `inspector/sections.rs` — one data fn + renderer per section |
| panel-section.tsx | VSCode-style collapsible section | `Section` primitive (chevron + title + badge), keyboard-toggleable |
| session-hero.tsx | status chip + stat grid | hero from `SessionStatus` (model.rs:699) + turn/timestamp stats |
| — Configuration section | provider tile, model, autonomy, steps | `brand_tile` (src/ui/brand.rs:49) fed by `brand_for` (src/app/tide_providers.rs:250); mode badge = `InteractionMode` (Build/Plan) for Tide sessions, `RuntimeMode` label for other drivers; steps bar dropped (§2) |
| — Memory & RAG section | ragStatus, reindex | OMIT (no RAG in the driver); stub seam left |
| — Git section | branch, ahead/behind, diffstat, → git tab | pure read of `branch_snapshots` (branches.rs:42) + `git_panel` state (git_panel.rs:323-390); "Changes →" opens `RightPanelSurface::Git` |
| — Exposed ports section | clickable port URLs | DEFERRED — no port events exist in this app (§0.4) |
| — Context Window section | fill meter, token grid | fill from `session.context_usage` (model.rs:967) immediately; token grid after the additive UsageUpdated extension (§2) |
| inspector-skeleton.tsx | loading skeleton | OMIT — synchronous data; cold sections hide instead |

## 2. Design

- `src/app/inspector/` — `mod.rs` (pane root, visibility, assembly),
  `section.rs` (collapsible primitive), `sections.rs` (hero / configuration /
  git / context data fns + renderers), `tests.rs`. Pure decision fns with
  tests; renderers take prepared data structs. No timeline_v2 imports or
  edits; no new daemon/git queries.
- One seam (revised 2026-09-04 after first execution): the chat column's
  working region — transcript through composer — lays out as a flex row
  whose in-flow second child is the inspector column when
  `inspector_visible(...)`. The card consumes real layout width (card +
  10px floating insets each side, published as `inspector_rendered_width`
  and subtracted in `chat_viewport_width`), so the transcript, permission
  card, queued messages, and composer all narrow together and stay
  centered on one axis; header and workspace footer remain full-width
  chrome. The card floats — insets from the top/right/bottom edges, all
  four corners rounded, translucent raised bg + shadow per the toast
  idiom.
- Data: read-only over existing state (`AgentSession`, `SessionRuntime`
  pending fields, `self.tide.providers`, `git_panel`, `branch_snapshots`).
  The only new plumbing, all additive:
  1. `UsageUpdated` gains an optional per-turn breakdown mirroring
     `EngineUsage` (serde-defaulted `None` keeps old payloads decoding), so
     the token grid and cost row become possible — the engine already
     computes it and the driver already holds it.
  2. A per-session cumulative `UsageTotals` accumulated in the runtime drain
     (runtime.rs:3758, before the reducer dispatch) — in-memory only,
     "since launch" semantics on resume, degrades gracefully.
- Configuration mode display is read-only — the composer chip stays the
  control. The steps bar is dropped: `MAX_STEPS = 100` (driver/tide.rs:88)
  is a backend loop bound never surfaced in-app, and
  `DEFAULT_MAX_STEPS = 10` (tools/src/agents.rs:22) is the *subagent* budget
  — the draft conflated the two. Subagent activity surfaces instead as a
  count from `session.subagent_runs` (model.rs:988).
- Toggle: derived, like upstream — no stored preference; hidden when the
  right panel occupies width or the window is narrow. Section collapse state
  is per app run (additive `InspectorState` field on `Tide`).
- Accessibility (AGENTS.md is a product requirement here): every section
  header keyboard-operable (`track_focus` + `tab_index`, Enter/Space
  toggles, visible `focus_visible` treatment, hover wash mirrored on
  focus); status is never color alone (chip = color + icon + text).
- Icons: `chevron-down`, `chevron-right`, `git-branch`, `zap`, `globe`,
  `changes` are all already registered in src/assets.rs `ICONS` — no new
  SVGs, so the silent-blank-icon trap doesn't apply.

## 3. Implementation phases

- **P0** Section primitive + visibility rule + render seam (empty stack).
- **P1** Session hero + Configuration (all data already local).
- **P2** UsageUpdated wire extension + per-session accumulator + Context
  Window section.
- **P3** Git section (pure read of git panel state + branch snapshots).
- **P4** Assembly, empty-section hiding, a11y + polish pass.
- **P5** (optional, deferred) Ports — requires new detection over terminal
  grids (`TERMINAL_LINK_REGEX`, terminal.rs:68) and background-work output;
  only if ports matter in practice.

See the task plan: `docs/plans/2026-08-30-inspector-implementation.md`
(also revised 2026-09-04).
