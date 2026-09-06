# Settings Card Pattern — Unified Group Layout

**Goal:** Every settings page draws content groups with one card pattern: the
card title and its action buttons live OUTSIDE the raised body, above it, on
one baseline. Body surfaces become pure control groups. This kills the three
competing card idioms currently in the app and the hand-built button copies
scattered across six renderers.

**Visual spec:** `docs/mockups/settings-cards.html` (validated mockup, dark +
light). The pattern:

```
Card Title  · sub            [pill] [Action]     ← header, outside the card
╭──────────────────────────────────────────────╮
│ Label                              [control] │ ← raised body, r13, px-20
│ Label                              [control] │   hairline between rows
╰──────────────────────────────────────────────╯
```

## Current state (audited 2026-09-04)

Three idioms coexist today:

| Pages | Idiom | Where |
|---|---|---|
| General, Daemon, Appearance, Computer Use, Providers | raised r13 box, no header — rows (sometimes a title-row) inside | `settings.rs` `render_general_settings` :455, `render_daemon_settings` :836, `render_appearance_settings` :1491, `render_computer_use_settings` :2264, `render_providers_settings` :1794 |
| Knowledge | raised r13 box, title inside the top, 13sp/11sp scale (smaller than every other page) | `rag_settings.rs` `settings_card` :352, `render_memory_rag_card` :581, `render_sources_card` :724 |
| Git | raised r13 + `overflow_hidden`, header row INSIDE with divider, then body | `settings.rs` `render_git_github_card` :2858, `render_git_identities_card`, `render_git_attribution_card`, `render_git_projects_card` |
| Tide | already header-outside (caption + Add Provider above the list), but hand-built | `settings.rs` `render_tide_settings` :4152 |

Known defects this fixes along the way:

- `rag_settings.rs:665-666` — the model/index status strings render twice
  (once as the row value, again as the row-control hint).
- The same bordered button (~20 lines: border, radius, focus, hover,
  Enter/Space key handling) is hand-built at ≥6 sites with drifting metrics
  (heights 26–29px, radii 6–7px): `refresh-providers` (~:1804),
  `apply-daemon-settings` (:881), `reveal/copy/regenerate-daemon-token`
  (:946–1062), `rag-build-*` (`rag_settings.rs` :686), `tide-add-provider`
  (:4168).
- `rag_settings.rs` row scale (13/11) disagrees with the rest of settings
  (13.5/12.5).

## Architecture

New primitive module **`src/ui/card.rs`** (registered in `src/ui/mod.rs`,
re-exported). Pure constructors; no state, no I/O, no listeners baked in
except where noted:

```rust
/// Header row rendered ABOVE the card body (outside it).
pub fn card_head(
    title: impl Into<SharedString>,
    subtitle: Option<SharedString>,
    actions: Vec<AnyElement>,
) -> Div
// flex justify_between items_center, min-h 28px, padding 0 2px 10px
// title: 13sp weight 600; subtitle: 12sp text_tertiary, gap 8
// actions: flex gap 8, items_center (pills sit beside buttons)

/// Raised body container. Rows carry their own vertical padding.
pub fn card_body() -> Div            // raised, r13, padding 4px 20px
pub fn card_body_flush() -> Div      // padding 0 + overflow_hidden (full-bleed lists)

/// One row: label (+ description or hint) left, control right.
pub struct CardRow {
    pub label: SharedString,
    pub description: Option<SharedString>,   // 12.5sp text_secondary
    pub hint: Option<SharedString>,          // 11sp text_tertiary (field hints)
    pub control: AnyElement,
}
pub fn card_rows(rows: Vec<CardRow>) -> Div
// each row: flex gap 24 py 12; index > 0 gets border_t_1 theme.border
// label 13.5sp weight 500; both optional-text slots degrade to nothing

/// The unified bordered action button. Replaces the six hand-built copies.
pub fn card_button(
    id: impl Into<ElementId>,
    label: SharedString,
    icon_path: Option<&'static str>,
    theme: &Theme,
    cx: &mut App,          // for focus_visible styling only; caller attaches listener
) -> Stateful<Div>
// h 27, px 11, r 7, border theme.border_strong, 12sp text_secondary,
// hover overlay, .tab_index(0) + .focus_visible(accent),
// built-in Enter/Space on_key_down slots via .on_click-like builder methods:
//   .card_on_click(cx.listener(...))  .card_busy(bool)  .card_disabled(bool)
// busy → 0.6 opacity + pointer none + spinner icon; disabled → 0.55 opacity
/// Ghost text variant for tertiary actions (Remove, Reset, Regenerate).
pub fn card_text_button(id, label, theme, cx) -> Stateful<Div>
```

Canonical type scale (matches the mockup, supersedes per-page drift):
card title 13/600 · row label 13.5/500 · description 12.5 secondary ·
hint 11 tertiary · value 12.5 secondary.

**Layout constants (unchanged):** page column max-width 760
(`SETTINGS_CONTENT_MAX_WIDTH`), gap between cards 26px. No page heading —
the sidebar names the selected page and every card titles itself
(supersedes the 18sp page title this draft assumed).

## Conventions

- Same discipline as the timeline_v2/inspector plans: one task = one commit,
  `cargo test -p tide` green + `cargo fmt` before every commit, pure fns for
  all decisions, render stays `&self`-pure (loading is requested from
  page-switch actions — already true for Git/Tide pages).
- Nothing a render frame reaches may do I/O. This plan is a render
  restructure only: no state shapes, no protocol, no daemon changes.
- A11y: `card_button` bakes in `tab_index(0)` + `focus_visible(accent)` +
  Enter/Space handling; header actions precede body rows in DOM, so tab order
  reads title → actions → rows. Hover-only affordances: none added.
- i18n: every user-visible string through `tr!`; new keys in
  `locales/app.yml` (en) only where a title didn't exist before.
- Tests live in-module (`#[cfg(test)] mod tests` at file bottom) or in
  `src/app/tests.rs`, same as existing settings tests.

## Precondition

The working tree carries the uncommitted Memory & RAG feature (43 modified +
6 untracked files). Land or commit that work FIRST — Tasks 2–3 edit
`rag_settings.rs` and `settings.rs`, and interleaving the pattern refactor
with the feature would entangle both histories. Suggested slicing for the
existing diff already discussed: fmt/GPUI fall-out, vendored `crates/rag` +
protocol, tool + app wiring.

---

## Task 1 — Card primitives (`src/ui/card.rs`)

**Files:** create `src/ui/card.rs`; add `mod card;` + re-exports in
`src/ui/mod.rs`. No call-site changes.

**Step 1 — failing tests** (in `src/ui/card.rs`):
```rust
#[test] fn row_divider_follows_index() {
    assert!(!row_divider(0));
    assert!(row_divider(1));
    assert!(row_divider(7));
}
#[test] fn button_opacity_is_busy_aware() {
    assert_eq!(button_opacity(false, false), 1.0);
    assert_eq!(button_opacity(true, false), 0.6);   // busy
    assert_eq!(button_opacity(false, true), 0.55);  // disabled
    assert_eq!(button_opacity(true, true), 0.55);   // disabled wins
}
#[test] fn empty_actions_and_subtitles_render_nothing() {
    // card_head with no actions/subtitle emits no empty flex slots
}
```

**Step 2 — implement** the API above. `card_rows` maps `Vec<CardRow>` with
`row_divider(index)`; `card_button` centralizes busy/disabled opacity via
`button_opacity`. Spinner icon = `motion::spin(icon("icons/loader-circle.svg", 11, tertiary))`
(honors reduce-motion already).

**Step 3 —** `cargo test -p tide`, fmt, commit:
`refactor(ui): settings card primitives — header-outside groups`

## Task 2 — Knowledge page (pilot, smallest + fixes the double-text bug)

**Files:** `src/app/rag_settings.rs`.

**Step 1 — failing tests** — extract the pure decision fns currently inline
in `render_memory_rag_card` (:592–631, :679–685):
```rust
fn rag_model_line(status: Option<&client::RagStatusWire>, project_id: &str) -> String
fn rag_index_line(status: Option<&client::RagStatusWire>, project_id: &str) -> String
fn rag_build_label(status: Option<&client::RagStatusWire>, busy: bool) -> String // build | rebuild | indexing
```
Tests: ready/downloading/failed(+error)/missing each render once, with the
error text appearing exactly once; never-indexed default when the status is
for another project; label selection per init_state.

**Step 2 — implement:**
- `render_memory_rag_card`: `card_head("Memory & RAG", Some(project name), vec![model pill, build button])`
  — the build/`rag_init` button moves to the head via `card_button`;
  "Model ready/downloading…" becomes a pill in the head, so the body's model
  row keeps its value text only. Body = `card_rows` (enable toggle, embedding
  model, code index). Delete the second (control-slot) copy of the status
  strings — the Step 1 fns guarantee single render. Keep the
  `render_init_progress` sub-block as-is (it is already a bordered inset).
  Fix the stale doc comment ("on General" → the Knowledge page).
- `render_sources_card`: `card_head("Knowledge Sources", None, vec![+ Add Source card_button])`;
  body = `card_body_flush` with `.source` rows unchanged.
- Delete the local `settings_card`/`row`/`card_title`/`hint_text` helpers
  (:352–404) — the 13/11 scale goes with them.

**Step 3 —** tests green, verify in the debug app: Knowledge page in both
themes, no duplicated status text, Re-Index still works from inspector +
settings. Commit:
`refactor(settings): knowledge page on the unified card pattern`

## Task 3 — General page

**Files:** `src/app/settings.rs` (`render_general_settings` :455,
`render_background_tasks_card` :593).

- One visible consolidation, per the mockup: the analytics card and the
  automatic-updates card merge into **one "Usage & Privacy" card**
  (new locale key `settings.usage_privacy`) — two toggle rows, head without
  actions. The `updater_available` conditional keeps working at row level
  (row hidden without an updater).
- "Local by default" stays a headerless `.note` banner — the one exception,
  documented in the mockup.
- Background Tasks card: head title-only, body rows with the two model
  pickers (picker chips unchanged). No new actions (reset lives inside the
  picker menu already).

Commit: `refactor(settings): general page on the unified card pattern`

## Task 4 — Daemon page

**Files:** `src/app/settings.rs` `render_daemon_settings` :836.

- **Exposure card:** head = `card_head(title, None, vec![status pill, Apply])`;
  Apply moves to the head via `card_button` with `.card_disabled(pending ||
  !fields_dirty)`; the status pill (Exposed/Local/Restarting) moves up beside
  it. Body = `card_rows`: expose toggle, port field, origins field (the two
  `TextField`s and `apply_daemon_exposure_fields` logic untouched).
- **Connection card** (port/origins, shown when enabled) merges into the
  exposure body per the mockup — the mockup shows one card; the current
  split into exposure + connection cards exists only because the title was
  trapped inside. Decision: merge; the head carries the status.
- **Authentication card:** head action `card_text_button("Regenerate
  token")`; body row: token description + Copy/Reveal controls (Copy via
  `card_button`, reveal keeps its icon-button). The remote-daemon
  external-note stays a headerless note.
- All three daemon key-handling buttons (`apply`, `copy-token`,
  `regenerate`) drop their hand-rolled Enter/Space blocks —
  `card_button` owns that now.

Commit: `refactor(settings): daemon page on the unified card pattern`

## Task 5 — Git page (idiom 3 → header-outside)

**Files:** `src/app/settings.rs` `render_git_github_card` :2858,
`render_git_identities_card`, `render_git_attribution_card`,
`render_git_projects_card` (and `render_git_settings` :2818 glue).

- Each card's inner header row (px-20 py-12 justify-between + divider)
  becomes `card_head(...)` rendered before `card_body(...)`; captions move to
  the head `subtitle` slot; header-embedded actions (disconnect, edit, etc.)
  move into `card_actions` using `card_button`/`card_text_button`.
- The loading state and error text above the cards are unchanged.
- `overflow_hidden` on the old cards is replaced by `card_body_flush` where
  the body is a full-bleed account/app list; ordinary rows use `card_rows`.

Commit: `refactor(settings): git page on the unified card pattern`

## Task 6 — Tide + CLI/Providers pages

**Files:** `src/app/settings.rs` `render_tide_settings` :4152,
`render_providers_settings` :1794.

- **Tide page:** the caption+Add-Provider strip becomes
  `card_head(tr!("settings.tide"), caption-as-subtitle, vec![Add Provider card_button])`
  above a `card_body_flush` provider list. Provider cards keep their
  per-card Edit/Enable/Delete (they are list items, not settings groups) but
  adopt `card_button` for those three actions, ending the 26/28px drift.
- **CLI page:** the hand-built `refresh-providers` button (:1804) becomes a
  head action on a titled card ("CLI", subtitle = detection-checked label);
  detection rows move into the body. Provider override rows keep their
  structure; enable toggles land in `CardRow` controls.

Commit: `refactor(settings): tide and cli pages on the unified card pattern`

## Task 7 — Appearance + Computer Use pages, sweep

**Files:** `src/app/settings.rs` `render_appearance_settings` :1491,
`render_computer_use_settings` :2264.

- Appearance: wrap the theme/font-size/language dropdown rows in
  `card_rows` under a titled head (reuse existing `tr!` labels; dropdown
  menu logic untouched).
- Computer Use: main toggle card gets a head; the always-allowed-apps list
  moves to `card_body_flush` (it already draws per-row `border_b_1` — switch
  to the shared divider idiom); permission rows → `card_rows`.
- **Sweep:** `grep -n "rounded(px(13.0))" src/app/settings.rs src/app/rag_settings.rs`
  should return zero group containers (inner insets like
  `render_init_progress` and modal dialogs keep their shapes). Confirm
  `git grep "h(px(2[6-9]).0)"` finds no leftover hand-built bordered buttons
  outside `card.rs`.
- Full keyboard pass: tab through every settings page, Enter/Space on every
  head action; search-field filtering (`visible_settings_pages`) untouched.

Commit: `refactor(settings): appearance and computer use on the card pattern`

---

## Non-goals

- **Usage page** (`usage_page.rs`): a 1024px dashboard mirroring T3 Code's
  wide layout — not a settings form; its three chart cards keep their shapes.
- **Skills page** (`skills_page.rs`): mail-style split that owns the content
  column; no cards.
- **Inspector** (`src/app/inspector/`): has its own section primitive and
  viewport; its Memory & RAG section keeps its Re-Index control.
- No behavior, protocol, or state changes; no new user actions.

## Risks / decisions to revisit

1. **General-page merge** (analytics + updates → "Usage & Privacy") is the
   one visible grouping change. If unpreferred, keep two cards — the pattern
   doesn't depend on it.
2. **Daemon exposure + connection merge** follows the same reasoning; both
   were split only because titles lived inside cards.
3. `card_button` intentionally swallows the Enter/Space idiom; any future
   button needing modifier-guarded keys should extend the helper, not fork it.
4. The plan edits files carrying uncommitted feature work — see
   Precondition.

## Validation (after Task 7)

Watcher-rebuilt Tide Debug, both themes, reduced motion on/off (busy
spinners), all ten sidebar pages visited, settings search narrowing each
page keyword, `cargo test -p tide` + `bun run protocol:check` clean (the
latter's `packages/client` path break is tracked separately).
