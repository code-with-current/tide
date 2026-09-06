# Inspector Panel — Detailed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the upstream Inspector column — the floating 300px session-at-a-glance card beside the chat — into Tide as `src/app/inspector/`, following the timeline_v2 discipline (new folder, one seam, no timeline_v2 edits, derived visibility).

**Architecture:** A floating column rendered inside the chat pane's layout when three conditions hold: a session is selected, the right panel is closed, and the viewport is ≥1400px. Content is a vertical stack of collapsible sections (Session hero, Configuration, Git, Context Window), each a pure-data fn + renderer pair, reading existing app state read-only. New plumbing is limited to an additive `UsageUpdated` breakdown (protocol + backend emit + wire) and a per-session usage accumulator in the runtime drain.

**Tech Stack:** Rust, GPUI, Tide's Theme/tokens (theme.rs has `warning`/`success`/`danger`/`gauge`), existing git panel state + branch snapshot cache, `cargo test -p tide`.

**Design doc:** `docs/plans/2026-08-30-inspector-panel-plan.md` (read first — its §0 lists the premises that changed since the original 2026-08-30 draft and why this plan differs).

---

## Conventions

- Same discipline as timeline_v2: tests in `src/app/inspector/tests.rs`, pure fns for all decisions, `cargo test -p tide` green before each commit, one task = one commit (`feat(inspector): …`).
- Allowed edit points, nothing else: the ONE seam in `src/app/render.rs`, `mod inspector;` + additive state fields in `src/app.rs`, and the additive usage plumbing named in Task 4 (protocol model, backend driver emit, wire conversions, runtime drain hook). Never edit timeline_v2.
- GPUI idioms: `div().id()` before scroll/interactivity, `Theme::current(cx)`, `crate::ui::{icon, icon_button}`, card treatment per the toast idiom (render.rs:526-543), disclosure-set pattern.
- Perf (AGENTS.md): nothing a render frame reaches may do I/O — no git, no spawns, no probes from row builders; the inspector reads only in-memory state. A cold section hides; it never loads.
- A11y (AGENTS.md): section headers are keyboard-operable (`track_focus` + `tab_index` + Enter/Space + visible focus); status color is always paired with icon/text.

---

## Task 1: Section primitive + visibility rule + seam

**Files:** Create `src/app/inspector/mod.rs` (pane root + visibility + `render_inspector` on `impl Tide`), `src/app/inspector/section.rs` (collapsible), `src/app/inspector/tests.rs`. Declare `mod inspector;` in src/app.rs (declaration block at :1638-1674).

**Step 1 — failing tests:**
```rust
#[test] fn visibility_requires_all_three() {
    // (has_session, right_panel_closed, viewport_width) -> bool
    assert!(inspector_visible(true, true, 1400.0));
    assert!(!inspector_visible(false, true, 1600.0));   // no session
    assert!(!inspector_visible(true, false, 1600.0));   // right panel open
    assert!(!inspector_visible(true, true, 1399.0));    // too narrow
}
#[test] fn section_collapse_defaults_and_toggle() {
    // SectionId enum + collapsed(state, id) + toggle — pure
}
```

**Step 2 — implement:**
```rust
pub(crate) fn inspector_visible(
    has_session: bool, right_panel_closed: bool, viewport_width: f32,
) -> bool { has_session && right_panel_closed && viewport_width >= 1400.0 }
```
Constants: `INSPECTOR_WIDTH = 300.0`, `INSPECTOR_MIN_VIEWPORT = 1400.0`.

`SectionId::{Config, Git, Context}` (Ports is a deferred stub — see Task 8; do not add a variant yet). Collapse state lives in an additive `InspectorState { collapsed: HashSet<SectionId> }` field on `Tide` (in-memory, default: all expanded except Context).

`section.rs`: `render_section(id, title, badge, collapsed, body, theme) -> Div` — 24px header (`chevron-down`/`chevron-right` swap + title + optional badge), hover wash AND focus wash, body indented `pl(6) pt(4) pb(8)`. Header is focusable and toggles on Enter/Space.

**Step 3 — the seam:** in `src/app/render.rs`, the chat column (render.rs:352-389) is already `.relative()` at :379 with overlay children (toast, computer_use) at :380-381. After those, add:
```rust
.when(inspector_visible(
    self.selected_session_id().is_some(),
    panels.right_panel <= 0.0,          // matches the right-panel render gate at :390
    window.viewport_size().width,        // per-frame read, pattern at render.rs:164-168
), |el| el.child(self.render_inspector(window, cx)))
```
REVISED post-execution (user direction): the inspector is an in-flow sibling consuming layout width — the chat's working region (transcript through composer) becomes a flex row `[content column, inspector column]`; the card floats inside its column with 10px insets on every side and all four corners rounded, and `inspector_consumed_width(shown)` is published to `inspector_rendered_width` so `chat_viewport_width` (and timeline_v2's rail mirror of it, list.rs) subtract the whole footprint. The composer then aligns with the transcript automatically — both center within the same narrowed column. No stored window-width field — the old draft's observer risk is void.

**Step 4 — run tests, commit:** `feat(inspector): section primitive + visibility seam`

## Task 2: Session hero

**Files:** `src/app/inspector/sections.rs` (+ tests).

**Step 1 — failing tests** for the pure mapping:
```rust
#[test] fn hero_status_maps_session_status() {
    // SessionStatus (model.rs:699) -> HeroStatus
    // Connecting|Working -> Running, Waiting -> Waiting, Failed -> Error, Idle -> Idle
}
#[test] fn hero_stats_format() { // "6m" durations, turn/subagent counts
```

**Step 2 — implement** `hero_data(...) -> HeroData { status, model_display, turns, subagents, total_ms, last_active_ms }`:
- Status: `hero_status(session.status)` — the reducer already folds permission asks AND Tide user-input asks into `SessionStatus::Waiting` (streaming.rs:354, :369), so the pure fn needs only the status. Chip: Running=accent, Waiting=warning, Error=danger, Idle=text_tertiary — always with an icon + label (never color alone).
- Stats: total time (`created_at` → now), last active (`last_reply_at`), turns (`session.turns.len()`), subagents (`session.subagent_runs.len()`, model.rs:988 — new since the dispatch overhaul).
- `render_hero`: status chip + model display name (`model_display_name`, runtime.rs:1585-1593) + 2× stat grid. No section chrome (matches upstream).

**Step 3 — commit:** `feat(inspector): session hero`

## Task 3: Configuration section

**Files:** sections.rs (+ tests).

- `config_data(session, providers: &[TideProviderWire]) -> ConfigData { provider_name, brand: (logo, accent), model_display, mode: ModeBadge, subagents }`:
  - Provider resolution mirrors the composer chip (composer.rs:875-888): `model.split_once('/')` → `providers` lookup by id → `brand_for(&provider.base_url, &provider.api_style)` (src/app/tide_providers.rs:250; returns `(logo_asset_key, accent_hex)`); fallback brand `("provider-tide", "#ffffff")` as in composer.rs:860.
  - Mode badge, pure fn `mode_label(provider_kind, runtime_mode, interaction_mode)`: Tide sessions → `InteractionMode::label()` (Build/Plan, model.rs:349); other drivers → `RuntimeMode` label (their access dropdown still exists, composer.rs:1178-1263). Read-only — the composer chip is the control, the inspector never mutates mode.
  - The old draft's "steps 12/100" bar is dropped: `MAX_STEPS=100` (driver/tide.rs:88) is a backend loop bound never surfaced in-app and `DEFAULT_MAX_STEPS=10` (tools/src/agents.rs:22) is the subagent budget — they were conflated. Subagent count (from `subagent_runs`) carries the activity signal instead.
- Render: `brand_tile(logo, accent, 20.0, 12.0, theme)` (src/ui/brand.rs:49, pure/public/any-size) + provider name; model alias row; mode badge (Build=accent, Plan=warning, with icon+text).
- Tests: config_data prefix-split + fallback brand; mode_label mapping for both driver kinds.
- **Commit:** `feat(inspector): configuration section`

## Task 4: UsageUpdated wire extension + per-session accumulator (additive)

**Files:** `crates/protocol/src/model.rs` (+ wire conversions), `crates/backend/src/driver/tide.rs`, `src/app/runtime.rs`. streaming.rs is NOT edited — the accumulator sits in the drain before the reducer.

Context: `UsageUpdated { context_tokens, context_window }` (model.rs:1825-1828) is the whole wire payload today; `EngineUsage` (engine/src/events.rs:23-31: input/output/cache_read/cache_write/reasoning_tokens/calls/cost_usd) already accumulates per turn in the driver (driver/tide.rs:1425-1438) and is collapsed at :1439-1453. The old draft's five-segment accumulator had no data source; this task creates it.

**Step 1 — failing tests:**
```rust
#[test] fn usage_breakdown_serde_defaults() { // old payload (no breakdown) decodes with None
#[test] fn usage_totals_accumulate_deltas() { // apply() twice sums; new session starts zero
```

**Step 2 — implement:**
- Protocol: extend the variant with `breakdown: Option<UsageBreakdown>` (new struct mirroring the EngineUsage totals; `#[serde(default)]` + camelCase, matching the enum's conventions). Update every wire conversion both directions: `crates/protocol/src/driver_wire.rs:96-105` and :182-186, plus the daemon-side conversions (grep `usageUpdated` / `contextTokens` — daemon.rs ~:1918, :2004).
- Backend: in the emit at driver/tide.rs:1439-1453, additionally send the per-turn `outcome.usage` totals alongside the existing sums.
- App: in the drain loop immediately before the reducer dispatch (runtime.rs:3758), `if let DriverEvent::UsageUpdated { breakdown: Some(u), .. } = &event { self.inspector_usage.entry(session_id).or_default().apply(u); }` — additive field `inspector_usage: HashMap<Uuid, UsageTotals>` on `Tide`. In-memory only: after relaunch totals start at zero while `context_usage` rehydrates from persistence; the section must render that mix gracefully.

**Step 3 — commit:** `feat(inspector): carry per-turn usage breakdown on UsageUpdated`

## Task 5: Context Window section

**Files:** `src/app/inspector/sections.rs` (+ tests).

- `context_data(context_usage: Option<&ContextUsage>, totals: Option<&UsageTotals>) -> ContextData { fill, tokens, window, breakdown rows, calls, cost }`:
  - Fill from `session.context_usage` (persisted, model.rs:967 / ContextUsage model.rs:829-834) — available immediately, including resumed sessions.
  - Token grid rows (input / output / cache read / cache write / reasoning / calls) from the Task 4 totals; hidden when absent (pre-extension events, other drivers, or first seconds after relaunch). Cost row only when `cost_usd` is present.
  - `format_tokens` from `protocol::usage` (usage.rs:20-28) — the same formatter the footer meter uses (usage_meter.rs:398-408).
- Renderer: fill bar 10px — `theme.gauge` by convention, warning ≥ 0.85, danger ≥ 0.95 (usage_meter's own thresholds are the precedent; check `context_percent` usage_meter.rs:289-294 while implementing); "context tight" badge (text, never color alone) at ≥ 0.85. Compaction affordance deferred (badge only, v1).
- The existing footer ring meter (usage_meter.rs, mounted composer.rs:2715/2743) is untouched — inspector is the detail view, the ring stays the glance.
- Tests: fill fraction incl. `None` window → 0.0; totals formatting; degradation when breakdown absent.
- **Commit:** `feat(inspector): context window section`

## Task 6: Git section

**Files:** sections.rs (+ tests). Pure read — no new queries, no new caches, no git from render (AGENTS.md perf).

- Data sources, in freshness order:
  - Branch: `branch_snapshot_for_workspace` (branches.rs:42) over `branch_snapshots: QueryCache<PathBuf, ...>` (app.rs:1228); `BranchSnapshot` (protocol/git.rs:15) already carries `current`, `default_branch`, and aggregate `additions`/`deletions`. Usually warm — the composer branch picker (composer.rs:2530) feeds the same cache.
  - Working tree: `git_panel.status: GitQuery<Vec<PanelFileChange>>` (git_panel.rs:340); `PanelFileChange` (protocol/git_panel.rs:10) has `staged: bool` + per-file `additions`/`deletions`.
  - Ahead/behind: `git_panel.ahead_behind: Option<PanelAheadBehind>` (git_panel.rs:343). NOTE: ours is vs the branch's upstream (`GitAheadBehind` op), not upstream-tide's configurable base — render it as ↑n ↓m without a "vs base" label.
  - Staleness contract: the git panel refresh timer runs only while the panel is visible (git_panel.rs:519, activation right_panel.rs:7186). The inspector renders whatever is cached and never spawns refreshes; when both branch snapshot and panel state are cold, the section hides.
- `git_section_data(snapshot, status, ahead_behind) -> Option<GitSectionData { branch, ahead, behind, changed, staged, additions, deletions }>` — pure aggregation (changed = unstaged count, staged count, sums of adds/dels) + the hide-when-cold gate.
- Render: `git-branch` icon + branch name; ↑n ↓m when known; diffstat bar (additions `success` / deletions `danger`, proportional); "N files" caption; header action button "Changes →" → `open_right_panel_surface(RightPanelSurface::Git, cx)` (right_panel.rs:1870) — a one-shot click, synchronous is fine.
- Tests: aggregation from a PanelFileChange vec; ahead/behind formatting; hide-when-cold.
- **Commit:** `feat(inspector): git section`

## Task 7: Assembly + a11y + polish

**Files:** mod.rs, sections.rs (+ tests).

- `render_inspector` composes: hero (no section chrome) + static order [Configuration, Git, Context]. The old draft's permission-pending reorder rule is dropped: the fix for a pending ask is the inline transcript card / composer Plan/Build chip, not the inspector, and the hero's Waiting chip already carries the signal.
- Empty-section hiding: Git hidden when cold (Task 6); Context shown whenever fill is known. No skeleton — data is synchronous (the old draft's skeleton task is void; there is nothing to wait for).
- A11y sweep per AGENTS.md: every section header focusable + Enter/Space toggle + visible `focus_visible` ring; hover washes mirrored on focus; hit area ≥ the 24px header row; tab order = visual order. Verify keyboard-only operation of the whole column once, in the rebuilt app.
- Polish: header badges (counts: "N files", "78%"), consistent hover washes.
- Full `cargo test -p tide` + `cargo build`; smoke via the dev watcher (`bun ./scripts/dev.ts` owns the app — no manual relaunch, no bundle.sh, no visual test unless requested).
- **Commit:** `feat(inspector): assembly, a11y, polish`

---

## Task graph

T1 → T2 → T3 → T4 → T5 → T6 → T7 (strictly sequential; each ships green). T8 optional after T7.

## Task 8 (optional, deferred): Exposed ports

Do not build without a concrete need. The original premise was false — `ChatPush::TerminalPorts/ScriptPorts`, `detect_ports`, and `src/app/commands/` do not exist in this codebase (those are the TS app's names). What building it actually takes:

- Detection: scan `BackgroundWorkEvent::OutputDelta` in the runtime drain (same hook point as Task 4) and periodic terminal-grid snapshots via `TERMINAL_LINK_REGEX` (terminal.rs:68, matches `http://host:port`) — on the background executor, never per-write and never on a frame.
- Storage: additive per-session `Vec<PortInfo { label, port }>` with dedupe.
- Opening: today every URL click goes external (`cx.open_url`, terminal.rs:847; transcript links app.rs:2754); the embedded browser surface (`RightPanelSurface::Browser`, right_panel.rs:2164) is only used for mermaid. Ports would be the first in-app route — a product decision, not just wiring.

## Risks

- The floating 300px card overlays the transcript's right margin at the low end of ≥1400px (matches upstream's tradeoff; content max-width keeps text clear). If it reads badly in practice, raise `INSPECTOR_MIN_VIEWPORT` — the constant is the only knob.
- The usage extension touches the daemon wire; old payloads must keep decoding (serde defaults, Task 4 test) and daemon/client versions can skew during rollout — `None` breakdown must render as "hidden rows", never an error.
- git_panel staleness while its panel is closed is a glance-panel tradeoff; do not add background refresh timers for the inspector without measuring first (docs/performance.md).
