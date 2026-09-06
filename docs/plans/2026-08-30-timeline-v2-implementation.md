# Timeline v2 — Detailed Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build tide's timeline anatomy as a fresh `src/app/timeline_v2/` pane beside the legacy transcript, swappable at one seam via a flag, deleting nothing until final cutover.

**Architecture:** Parallel pane reading the same `AgentSession` state (streaming.rs untouched). One seam in `render_transcript` picks legacy vs v2. v2 owns its ListState, follow machine, disclosures, and row model (`TimelineV2Row` + part-level fingerprint keyed like tide's block ids). Legacy code and its tests are never edited.

**Tech Stack:** Rust, GPUI (div/list/ListState), rust-i18n locales, waku's `md/` markdown engine, `cargo test -p waku`.

**Design doc:** `docs/plans/2026-08-30-timeline-refactor-plan.md` (read first).

---

## Conventions

- Build/test: `cargo check -p waku` while iterating; `cargo test -p waku` before each commit (batch cargo runs — they are slow).
- New tests live in `src/app/timeline_v2/tests.rs` (one module), registered `mod tests;` in `timeline_v2/mod.rs`. Unit-testable logic (row derivation, fingerprint, follow-state transitions, label tables) MUST be free functions taking data, not `&Waku`.
- Visual-only code (div chains) gets no unit test; its logic is extracted into tested free fns (e.g. `derive_rows`, `part_fingerprint`).
- Toggle: env `WAKU_TIMELINE_V2` — set `1` to force on, `0` to force off, unset = debug default ON, release default OFF.
- Commit messages: `feat(timeline-v2): …` / `test(timeline-v2): …`. One task = one commit.
- **Never** modify: `src/app/transcript_view.rs`, `src/app/transcript.rs`, `src/app/components.rs`, `src/app/streaming.rs`, `src/app/tests.rs`, `src/app/md/**`.
- GPUI idioms this codebase uses: `div().id(...)` before `overflow_y_scroll` (Stateful), overlays via `gpui::deferred(...).with_priority(N)` (menus are priority 1 — anything that must float above the pane uses ≥2), theme via `Theme::current(cx)`, icons via `crate::ui::{icon, file_icon}`.

---

## Phase 0 — Scaffolding + the seam

### Task 1: Toggle flag + TranscriptV2 state shell

**Files:**
- Create: `src/app/timeline_v2/mod.rs`
- Modify: `src/app.rs` (Waku struct + `Waku::new`)
- Test: `src/app/timeline_v2/tests.rs`

**Step 1 — write the failing test** (`src/app/timeline_v2/tests.rs`):

```rust
use super::*;

#[test]
fn toggle_defaults_from_env() {
    // unset → debug ON, release OFF; explicit values win
    assert_eq!(timeline_v2_enabled(None, true), true);
    assert_eq!(timeline_v2_enabled(None, false), false);
    assert_eq!(timeline_v2_enabled(Some("1"), false), true);
    assert_eq!(timeline_v2_enabled(Some("0"), true), false);
}
```

**Step 2 — run:** `cargo test -p waku timeline_v2` → FAIL (no module).

**Step 3 — implement.** `timeline_v2/mod.rs`:

```rust
//! The tide-anatomy transcript pane. Built in parallel with the legacy
//! transcript; the pane is chosen at one seam in `render_transcript`.

pub(crate) mod tests;

/// Resolve the pane flag: explicit env beats defaults (debug ON, release OFF).
pub(crate) fn timeline_v2_enabled(env: Option<&str>, debug: bool) -> bool {
    match env {
        Some(value) if value == "1" => true,
        Some(value) if value == "0" => false,
        _ => debug,
    }
}

/// All view state the v2 pane owns. Never shared with the legacy pane.
#[derive(Default)]
pub(crate) struct TranscriptV2 {
    /// Expanded part ids (tool cards, reasoning blocks).
    pub disclosures: std::collections::HashSet<String>,
    /// True while pinned to the bottom during streaming.
    pub following: bool,
}
```

`src/app.rs`: add field `pub(crate) timeline_v2: bool,` + `pub(crate) timeline_v2_state: TranscriptV2,` to `Waku`; in `Waku::new`:
```rust
let timeline_v2 = timeline_v2_enabled(
    std::env::var("WAKU_TIMELINE_V2").ok().as_deref(),
    cfg!(debug_assertions),
);
```
add `mod timeline_v2;` to the module list and `use timeline_v2::TranscriptV2;`.

**Step 4 — run:** `cargo test -p waku timeline_v2` → PASS (1).

**Step 5 — commit:** `feat(timeline-v2): pane flag + TranscriptV2 state shell`

### Task 2: The seam — render_transcript branch

**Files:**
- Modify: `src/app/transcript_view.rs` (render_transcript head ONLY — allowed exception, additive)
- Create: `src/app/timeline_v2/mod.rs` grows `render_timeline_v2`

**Step 1** — add to `timeline_v2/mod.rs`:

```rust
impl crate::app::Waku {
    pub(super) fn render_timeline_v2(
        &mut self,
        _window: &mut gpui::Window,
        _cx: &mut gpui::Context<Self>,
    ) -> gpui::AnyElement {
        // Placeholder body until Task 5: proves the seam compiles and mounts.
        gpui::div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child("timeline v2")
            .into_any_element()
    }
}
```

**Step 2** — in `render_transcript` (transcript_view.rs:168), immediately after `self.prefetch_checkpoint_refs(cx);`:

```rust
if self.timeline_v2 {
    return self.render_timeline_v2(window, cx);
}
```

**Step 3 — run:** `cargo check -p waku` → clean. `cargo test -p waku` → all pass (legacy untouched when flag off in tests: tests construct Waku without env → in `cargo test` (debug) the flag would default ON — so `Waku::new` in tests must seed with `timeline_v2_enabled(None, false)` OR tests that assert on the legacy pane set the field off. Simpler: add `#[cfg(test)]` default OFF in `Waku::new`:
```rust
let timeline_v2 = if cfg!(test) {
    false
} else {
    timeline_v2_enabled(std::env::var("WAKU_TIMELINE_V2").ok().as_deref(), cfg!(debug_assertions))
};
```

**Step 4 — run:** `cargo test -p waku` → all pass.

**Step 5 — commit:** `feat(timeline-v2): mount seam in render_transcript`

### Task 3: Actions struct + tokens

**Files:** Create `src/app/timeline_v2/actions.rs`, `src/app/timeline_v2/tokens.rs`; modify `timeline_v2/mod.rs` (declare mods).

**Step 1** — `actions.rs`:

```rust
/// Everything a row may ask the app to do — tide's panel-actions-context.
/// Built once per frame in `render_timeline_v2`; rows never touch `Waku`.
#[derive(Clone)]
pub(crate) struct TranscriptActions {
    pub view_file: std::sync::Arc<dyn Fn(&str, &mut gpui::Window, &mut gpui::App) + Send + Sync>,
    pub view_diff: std::sync::Arc<dyn Fn(&str, &mut gpui::Window, &mut gpui::App) + Send + Sync>,
    pub open_dispatch: std::sync::Arc<dyn Fn(&str, &mut gpui::Window, &mut gpui::App) + Send + Sync>,
}
```

**Step 2** — `tokens.rs`: status/tool palette as free fns over `Theme` (success = `theme.accent`, error = `theme.danger`, warning = existing `theme.warning`, info = `theme.text_tertiary`; `tools_dim` = `theme.text_tertiary`, `tools_rail` = `theme.border`). Tests: `status_color(theme, Status::Error) == theme.danger`.

**Step 3 — run:** `cargo test -p waku timeline_v2` → PASS. **Step 4 — commit:** `feat(timeline-v2): actions struct + status tokens`

---

## Phase 1 — Row model, list, follow machine

### Task 4: TimelineV2Row derivation (the new row model)

**Files:** Create `src/app/timeline_v2/rows.rs`; Test in `tests.rs`.

**Step 1 — failing tests** (free fns over `&AgentSession` — build sessions with the existing `tests.rs` helpers' style: `AgentSession::new(uuid, ProviderKind::Tide)` + `handle_driver_event` from `crate::app::streaming`):

```rust
#[test]
fn rows_mirror_turn_order() { /* user msg, activity block, assistant msg, footer */ }
#[test]
fn streaming_tail_appends_working_row() { /* WorkingRow present iff turn active */ }
#[test]
fn fingerprint_stable_when_session_unchanged() { /* derive twice, equal */ }
#[test]
fn fingerprint_moves_when_a_disclosure_flips() { /* expanded ids are part of the key */ }
```

**Step 2 — implement** `rows.rs`:

```rust
pub(crate) enum TimelineV2Row {
    Message { index: usize },
    ActivityGroup { block: usize },   // one per TranscriptBlock
    TurnFooter { turn: usize },
    ChangedFiles { turn: usize },
    Working,
}

/// Fold the session into v2 rows (flat, top-to-bottom). Free fn — testable.
pub(crate) fn derive_rows(session: &AgentSession, disclosures: &HashSet<String>) -> Vec<TimelineV2Row>;

/// Cheap identity: counts + ids + disclosure membership. Like tide's block
/// ids, a tool card's identity is its tool_call id.
pub(crate) fn rows_fingerprint(session: &AgentSession, disclosures: &HashSet<String>) -> u64;
```

**Step 3/4** — tests pass. **Step 5 — commit:** `feat(timeline-v2): row model + fingerprint`

### Task 5: The list — mount real rows (plain pass)

**Files:** modify `timeline_v2/mod.rs` (+ `list.rs`).

**Step 1** — `list.rs`: own `gpui::ListState` (created in `TranscriptV2::new`), render `derive_rows` through `gpui::list(state, cx.listener(...))`; plain rendering this task: messages via existing `crate::app::components::render_message`? **No — legacy import ban.** Render text-only placeholders (role + first 80 chars) to prove plumbing. Sync: on fingerprint change → `state.reset()` (simple + correct; splicing is Task 7).

**Step 2** — `render_timeline_v2` swaps placeholder for the list: `div().size_full().child(list)`, centered `max_w` + padding to match legacy (`CONTENT_MAX_WIDTH` — copy the constant locally).

**Step 3 — run:** manual `bun dev` check (list scrolls, placeholder rows render). `cargo test -p waku` green.

**Step 4 — commit:** `feat(timeline-v2): list mounts derived rows (plain pass)`

### Task 6: Follow machine — stick-to-bottom with release/re-pin

**Files:** `list.rs` + `tests.rs`.

**Step 1 — failing tests** for a pure state fn:

```rust
#[test]
fn follow_transitions() {
    // ScrolledUp while following → Released; AtBottom while released → Following;
    // new user message sent while released → stays Released (jump button shown)
}
```

```rust
pub(crate) enum FollowState { Following, Released }
pub(crate) fn next_follow(state: FollowState, scrolled: ScrollSignal) -> FollowState;
pub(crate) enum ScrollSignal { ScrolledUp, AtBottom, UserSent }
```

**Step 2/3/4** — implement + pass. Wire into list: wheel/scroll events emit signals (`div().on_scroll_wheel(...)` + a bottom sentinel via `list_state.scroll_to_end` when Following on fingerprint change; jump-to-bottom button bottom-right when Released — reuse legacy visual: `icons/arrow-down.svg` circular button).

**Step 5 — commit:** `feat(timeline-v2): follow machine + jump-to-bottom`

### Task 7: Streaming cadence — tail remeasure + splice

**Files:** `list.rs`, `mod.rs`.

**Step 1** — hook the existing wake loop: in `runtime.rs`'s `drain_driver_events` the `stream_remeasure_pending` flag exists; v2 adds `if self.timeline_v2 { self.timeline_v2_remeasure_tail(cx); }` — v2-only method, no legacy edits. Tail remeasure = `state.remeasure_items(last_rows_range)` on markdown growth, throttled by the same 120ms `STREAM_FRAME_INTERVAL` (already gating the pump).

**Step 2** — replace `reset()` with splice when only the tail changed: compare row counts; if equal + last fingerprint differs only in tail ids → `state.splice(range, replacement_len)`.

**Step 3 — test:** fingerprint-diff test — `tail_splice_decision(old, new) -> SplicePlan` pure fn with tests (append/replace/none).

**Step 4 — commit:** `feat(timeline-v2): tail remeasure + splice under stream cadence`

### Task 8: Disclosure-preserving scroll

**Step 1 — test:** `disclosure_keeps_viewport(row_index, expanded_height_delta)` returns the scroll adjustment (port the intent of `pin_transcript_for_disclosure`, fresh implementation).
**Step 2 — implement:** toggling a disclosure adjusts scroll by the delta so the clicked header stays put.
**Step 3 — run tests; commit:** `feat(timeline-v2): disclosure-preserving scroll`

---

## Phase 2 — ToolPartCard (the centerpiece)

### Task 9: labels.rs — data-driven tool vocabulary

**Files:** `labels.rs` + tests. Port tide's tool-helpers vocabulary as tables (fresh, no edits to components.rs):

```rust
pub(crate) struct ToolLabel {
    pub display_name: &'static str,     // "Edit File" not "edit_file"
    pub icon: &'static str,             // asset path
    pub family: ToolFamily,             // Bash/Edit/Read/Search/Task/Web/Skill/Other
    pub default_expanded: bool,
    pub language_hint: Option<&'static str>,
}
pub(crate) fn label_for(tool: &str) -> ToolLabel;           // covers tide-tools core_tools names
pub(crate) fn describe_path(base: &std::path::Path, arg: &str) -> (String /*dir*/, String /*file*/);
pub(crate) fn relative_to(workspace: &std::path::Path, target: &str) -> String; // tide's rtl-truncate dir
```

Tests: `label_for("edit_file").family == Edit`, `relative_to` truncation cases. **Commit:** `feat(timeline-v2): tool label tables`

### Task 10: ToolPartCard header

**Files:** `parts/tool_part.rs`.

Anatomy (tide parity): 28px header row → [status icon column: tool icon; spinner (`LoadingCircle`-equivalent: existing `icons/loading.svg` + `animate-spin`) while running; icon ⇄ chevron on hover/expanded] [display name from labels] [description column: relative path w/ `file_icon`, bash first line, task description] [diff-stat badge `+N/-M` success/error colors] [hover action buttons: view-file, view-diff (from `TranscriptActions`)] [failure X / pulse dot]. Click toggles disclosure (id = activity `source_id` — tide's tool-block-id rule).

Extract pure helpers + test: `header_status_icon(status) -> &'static str`, `diff_stat(adds, dels) -> (String, gpui::Hsla)`.

**Commit:** `feat(timeline-v2): tool card header anatomy`

### Task 11: ToolPartCard expanded bodies — families

Input section (bash `pre`, edit/write synthetic all-add diff, others italic args) + result renderers per family:
- edit/multi_edit/write → diff rows via the existing right-panel `render_diff_code_row` **read-only reuse is allowed** (it's a shared renderer, not the legacy pane) — check import path `crate::app::right_panel`; if it entangles Waku state, copy the fn into `timeline_v2/diff_rows.rs` instead.
- bash → streaming plain text in a 400px scroll viewport (bottom-follow while running) + copy.
- read/grep/glob/web → static summary line (Task 12 grouping shows them collapsed by default anyway).
- todo → checklist rendering from the activity's todo payload.
- dispatch/agent → agent badge + markdown report (`md/` engine, dimmed variant).
- question → options list with the picked answer marked.
- JSON detection: `looks_like_json(output) -> Option<serde_json::Value>` (tested) → summary/tree/raw switcher (v1: raw + copy; tree later).

Failure card: bordered `tokens::error` block for failed/rejected/timeout/aborted.

**Tests:** `looks_like_json` cases, `family_for_output` mapping. **Commit:** `feat(timeline-v2): tool card expanded families`

### Task 12: Static tool rows + grouping inside ActivityGroup placeholder

**Files:** `parts/static_tool_row.rs`. Per-family one-line descriptions (icon + label + value preview) for read/grep/glob/webfetch/skill; grouped when ≥3 of a kind (StaticGroupedToolRow: "4 reads ▾"). **Commit:** `feat(timeline-v2): static tool rows`

---

## Phase 3 — Activity group + turn rows

### Task 13: activity_group.rs — ProgressiveGroup parity

Cluster header (tide's): `+N more…` collapsed preview (last activity summary), live title while streaming ("Running N commands"), left 1px rail on expanded content, chevron toggle (disclosure id = block's turn id). Fold state: collapsed when turn settled (parity with legacy TurnFold behavior), expanded while streaming. Tests: `group_title(activities, streaming) -> String`. **Commit:** `feat(timeline-v2): progressive activity group`

### Task 14: turn_item.rs + working_footer.rs

Sticky user header (role pill), assistant block container, `TurnWorkingFooter` while active (elapsed ticker on the 120ms cadence — reuse `EventPumpSchedule::StreamFrame` wake; no new timer). **Commit:** `feat(timeline-v2): turn item + working footer`

### Task 15: changed_files.rs — file-changes card

From turn parts: created/edited counts, `+N/−M` totals, 5 visible + expander, per-file Review (→ `actions.view_diff`) / Undo affordance (v1: Review only; Undo needs undo tooling — stub with toast "not wired"). **Commit:** `feat(timeline-v2): changed files card`

### Task 16: error_block.rs + retry

Collapsible `--status-error` card for `DriverEvent::Error` payloads (session error fields), Retry button → re-sends the last user message (exists as legacy queue mechanism; call the same send path via actions-style closure). **Commit:** `feat(timeline-v2): turn error block + retry`

---

## Phase 4 — Message anatomy

### Task 17: User bubble parity (edit-and-resend)

Notched right bubble (visual parity: rounded + clipped corner), 160px clamp + expand chevron, hover row: clock timestamp + pencil + copy. Pencil → inline textarea (reuse `crate::input::TextInput` pattern from goal_dialog) + confirm dialog listing what's removed ("removes N replies / M tool runs") → on confirm: call the existing rewind/edit backend path via a closure from mod.rs (the only place allowed to touch Waku methods). **Commit:** `feat(timeline-v2): user bubble with edit-and-resend`

### Task 18: Assistant part loop + text part + JSON finalize

`parts/text_part.rs`: markdown via `md/` engine (assistant metrics), streaming-throttled by the existing cadence; on turn end, `finalize` runs `looks_like_json` — when it parses AND came from a tool-family output, render `GeneratedJsonResultCard` (mono card + copy + "pretty" toggle). **Commit:** `feat(timeline-v2): assistant text + generated-json card`

### Task 19: reasoning_part.rs

Brain icon + label ("Thinking" / cycling-dots while streaming), collapsed = 80-char stripped summary line, expanded = markdown (dimmed metrics) inside the bounded 400px viewport w/ bottom-follow while streaming (reuse the viewport pattern from Task 11's bash output). **Commit:** `feat(timeline-v2): reasoning part`

### Task 20: question_card.rs + skeleton

Inline pending follow-up card under the assistant message (options + custom answer + submit via actions closure → existing user-input answer path). Session-switch skeleton: user-bubble + reasoning + tool + answer gray blocks (one frame flash). **Commit:** `feat(timeline-v2): question card + switch skeleton`

---

## Phase 5 — Floating surfaces

### Task 21: Permission card parity

In-pane floating card (rendered by the v2 pane, not composer): warning rail, risk-tier badge, mono detail, countdown ring driven by the 120ms wake tick (`deadline - now` from `Permission.timeout_at`), SplitButton Allow (Allow / Always allow / Escalate to Full), Reject with optional reason field. Calls the existing permission_respond path via closure. **Commit:** `feat(timeline-v2): permission card parity`

### Task 22: tool-output dialog

Full-screen overlay (`gpui::deferred(...).with_priority(3)`): opened from tool header expand-all action; code output via `md/` code renderer w/ copy; images existing preview path; diff full view. **Commit:** `feat(timeline-v2): tool output dialog`

### Task 23: v2 search + nav rail

Port transcript_search to v2 ownership (input + match highlighting via `md/` search marks — the engine already supports search highlights); navigation rail ticks from derived rows (message boundaries). **Commit:** `feat(timeline-v2): search + navigation rail`

---

## Phase 6 — Cutover

### Task 24: Release default flip + A/B checklist

Flip `timeline_v2_enabled` release default after manual parity pass. A/B checklist (manual): stream a long turn (follow holds), tool families expand/collapse, edit-and-resend, permission card, search, session switch, rollback via `WAKU_TIMELINE_V2=0`. **Commit:** `feat(timeline-v2): release default on`

### Task 25: Delete the legacy pane

One isolated commit: remove `transcript_view.rs`, `transcript.rs`, legacy renderers from `components.rs` (render_message family), their tests from `tests.rs`, the seam branch, and the flag (v2 becomes the only path). `cargo test -p waku` green after. **Commit:** `refactor(timeline): remove legacy transcript pane`

---

## Task graph

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8
                              ↓
                    T9 → T10 → T11 → T12 → T13 → T14 → T15 → T16
                              ↓ (parts reusable from T11)
                    T17 → T18 → T19 → T20
                              ↓
                    T21 → T22 → T23 → T24 → T25
```

Critical path ≈ T1–T8 (pane plumbing), then parts/rows fan out.
