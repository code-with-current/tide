# Projects Settings Screen — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

Design: [2026-09-07-projects-settings-design.md](2026-09-07-projects-settings-design.md)

**Goal:** A "Projects" page in Settings — Skills-style master–detail — that becomes the single home for per-project configuration: identity (name, path, icon), default model for new chats, custom actions, git identity, memory & RAG, and project removal.

**Architecture:** New `src/app/projects_page.rs` cloned from the `skills_page.rs` pattern. Per-project data rides the existing `Project` wire type (new fields, serde defaults) and the backend `app.db` `projects` table (new columns via Drizzle migration). Actions execute by opening a right-panel terminal at the project path; git identity keeps repo-local storage; removal cascades sessions only when the confirm checkbox is set.

**Tech Stack:** Rust / GPUI (`gpui::ListState` virtualized lists), rusqlite + Drizzle build-time migrations, rust-i18n, in-house `ui::menu` dropdowns.

**Before starting:** create the isolated workspace per using-git-worktrees — `.worktrees/` does not exist yet, so add it to `.gitignore`, commit, then `git worktree add .worktrees/projects-settings -b feature/projects-settings`. Run `bun install` in the worktree. The dev watcher in the main checkout owns the running app; do not start a second one — validate UI changes by temporarily pointing a single watcher at the worktree, or by building `cargo check` there and validating in the main checkout after merging. Baseline: `cargo check -p tide` must pass before task 1.

Phases land independently buildable; gate each phase with the checks listed in its final task.

---

## Phase 1 — Data model

### Task 1: Extend `Project` in the protocol

**Files:**
- Modify: `crates/protocol/src/model.rs:382` (`Project`), same file for new types
- Test: `crates/protocol` unit tests (append in `model.rs` `#[cfg(test)]` or existing tests module)

**Step 1: Add the types** (follow the crate's serde conventions — `rename_all = "camelCase"`, `#[serde(default)]` on every new field so old snapshots deserialize):

```rust
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", default)]
pub struct ProjectAction {
    pub name: String,
    pub command: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ProjectIcon {
    /// Initials + deterministic color; well-known repo files win when present.
    #[default]
    Auto,
    /// Path inside the embedded asset set, e.g. "icons/projects/rocket.svg".
    Preset(String),
    /// File name under the Tide assets dir, keyed by project id.
    Uploaded(String),
}
```

Fields on `Project` (all `#[serde(default)]`):

```rust
pub icon: ProjectIcon,
pub icon_color: Option<String>,          // hex, applied in all icon modes
pub default_provider: Option<ProviderKind>,
pub default_model: Option<String>,
pub actions: Vec<ProjectAction>,
```

**Step 2: Pure decision helper** (used by task 5; put it next to `Project`):

```rust
impl Project {
    /// Session creation defaults: the project override wins over the
    /// remembered last-used pair.
    pub fn session_start_defaults(
        &self,
        last_provider: ProviderKind,
        last_model: Option<&str>,
    ) -> (ProviderKind, Option<String>) {
        match (self.default_provider, self.default_model.as_deref()) {
            (Some(provider), model) => (provider, model.map(str::to_owned)),
            (None, Some(model)) if last_provider != ProviderKind::default_fallback() => {
                (last_provider, Some(model.to_owned()))
            }
            (None, _) => (last_provider, last_model.map(str::to_owned)),
        }
    }
}
```

If `ProviderKind` has no `Default`, use the crate's existing "first/unknown" sentinel for the model-only case — check `ProviderKind` at `crates/protocol/src/model.rs:11` and mirror what `new_session` does; if a model id is only valid for its provider, prefer requiring `default_provider` whenever `default_model` is set and simplify the match to two arms.

**Step 3: Tests.** Round-trip: serialize a `Project` with the new fields, deserialize a JSON payload missing them (old snapshot), assert defaults. Assert `session_start_defaults` precedence: project pair > project model + last provider > last pair.

**Step 4:** `cargo check -p protocol && cargo test -p protocol`. **Step 5:** `git add -A crates/protocol && git commit -m "feat(protocol): per-project icon, default model, and actions"`.

### Task 2: DB columns + persistence

**Files:**
- Modify: `db/schema.ts` (projects table, after `createdAt`)
- Generate: `db/migrations/*.sql` via `bun run db:generate`
- Modify: `crates/backend/src/persistence.rs` — SELECT at `:1062-1085`, `INSERT_PROJECT` at `:1726-1732`, save path `:1295-1315`
- Test: persistence tests module (pattern at `persistence.rs:796`)

**Step 1:** schema.ts columns (all nullable — existing rows must keep loading):

```ts
/** Icon setting: "auto" | preset asset path | uploaded file name. */
icon: text("icon"),
iconColor: text("icon_color"),
defaultProvider: text("default_provider"),
defaultModel: text("default_model"),
/** JSON array of { name, command }. */
actions: text("actions"),
```

Run `bun run db:generate`; confirm the new migration SQL under `db/migrations/` is `ALTER TABLE projects ADD COLUMN ...` only.

**Step 2:** extend the SELECT column list and row mapping to populate the new `Project` fields (`icon`/`actions` parse via `serde_json`/enum tag; `NULL` → `Default::default()`). Extend `INSERT_PROJECT` params to six/eight bindings. The fingerprinted wipe-and-rewrite save needs no change beyond the new bindings.

**Step 3: Test.** In the persistence test harness (in-memory DB, pattern `persistence.rs:796`): save a project with icon/actions/default model, reload, assert round-trip; save a pre-migration-shaped row (all NULL columns), reload, assert defaults.

**Step 4:** `cargo test -p backend persistence` (then full `cargo check`). **Step 5:** `git add db crates/backend && git commit -m "feat(backend): persist per-project settings columns"`.

### Task 3: Remove-project backend command

**Files:**
- Modify: `crates/protocol/src/protocol.rs` (`Command` enum, near `GitSetIdentity` at `:196`)
- Modify: `crates/backend/src/daemon.rs` (handler arms near `:288` and the response list at `:1331`)
- Modify: `crates/backend/src/persistence.rs` (removal + cascade fn)
- Test: persistence tests + protocol serde test

**Step 1:** protocol variant + payload:

```rust
RemoveProject {
    project_id: Uuid,
    delete_history: bool,
},
```

**Step 2:** persistence fn: delete the `projects` row; when `delete_history`, inspect `db/schema.ts` for the session/message/usage tables that carry a project reference and delete their rows by `project_id` in the same transaction (`unchecked_transaction`, commit — same shape as the save path at `:1292-:1397`). Positions self-heal: the save path rewrites all rows with fresh `position` values.

**Step 3:** daemon arm delegates to that fn and replies with a fresh task-state snapshot (mirror how mutating Git arms re-snapshot — `daemon.rs:275`, `:417`).

**Step 4: Test.** Persistence: insert project + sessions (+ history rows), remove without flag → project gone, sessions intact; with flag → all gone. Protocol: serde round-trip of the variant.

**Step 5:** `cargo test -p backend -p protocol`. **Step 6:** commit `feat(backend): remove-project command with optional history cascade`.

---

## Phase 2 — Session default model

### Task 4: Honor per-project defaults in session creation

**Files:**
- Modify: `src/app/sessions.rs:283-309` (`create_session_for`)
- Test: `src/app/tests.rs`

**Step 1: Write the failing test first** for the pure helper (extract it so no GPUI harness is needed):

```rust
// sessions.rs, pure fn + test in tests.rs
fn effective_start_model(
    project: Option<&Project>,
    last_provider: ProviderKind,
    last_model: Option<String>,
) -> (ProviderKind, Option<String>) {
    project
        .map(|p| p.session_start_defaults(last_provider, last_model.as_deref()))
        .unwrap_or((last_provider, last_model))
}
```

Test: project with defaults wins; project without falls back; `None` project falls back.

**Step 2:** wire it in `create_session_for` right after `let mut session = self.state.new_session(...)` (`:304`):

```rust
let (provider, model) = effective_start_model(
    self.state.projects.iter().find(|p| p.id == project_id),
    provider,
    self.state.last_model.clone(),
);
session.provider = provider;
session.model = model;
```

Notes: the draft-reuse short-circuit at `:289-298` means overrides apply only when a new draft is minted — correct per design; the call at `runtime.rs:751` fires on every remote sync, so the override must only touch fresh drafts (it does — `create_session_for` reuses an existing draft first).

**Step 3:** run `cargo test -p tide effective_start` (or the test's name). **Step 4:** commit `feat(app): per-project default model for new chats`.

---

## Phase 3 — The Projects page

### Task 5: Register the page (sidebar, dispatch, locales)

**Files:**
- Modify: `src/app.rs:207` (enum variant), `src/app.rs:1659` (`mod projects_page;`)
- Modify: `src/app/settings.rs:27` (`SETTINGS_PAGES`, length `9]` → `10]`), `:335-348` (full-viewport branch), `:373-385` (dispatch arm)
- Modify: `locales/app.yml`, `locales/ja.yml`, `locales/zh-CN.yml`
- Create: `src/app/projects_page.rs` (skeleton)

**Step 1:** locales (format-version 2, flat key + nested `en:`; mirror `settings.skills:` at `app.yml:145`):

```yaml
settings.projects:
  en: Projects
settings.projects_keywords:
  en: projects workspace folder identity icon actions remove
```

Add `ja`/`zh-CN` values in their files.

**Step 2:** enum variant `Projects,` after `Git` in `app.rs` (`is_visible_in_navigation` at `:228` needs no change). `SETTINGS_PAGES` tuple between Git and Tide: `(SettingsPage::Projects, "settings.projects", "icons/folder.svg", "settings.projects_keywords")`. Extend the Skills full-viewport branch at `settings.rs:335` to `page == SettingsPage::Skills || page == SettingsPage::Projects`, rendering `self.render_projects_settings(cx)`. Add the dispatch arm (the compiler will demand it).

**Step 3:** skeleton module (compiles; detail comes in task 6):

```rust
//! Projects settings: mail-style master–detail — the project list on the
//! left, the selected project's configuration on the right.

use gpui::Context;
use crate::app::Tide;

impl Tide {
    pub(super) fn render_projects_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let _ = cx;
        div().into_any_element()
    }
}
```

**Step 4:** `cargo check -p tide` — command palette picks the page up automatically (`command_palette.rs:701-706`). **Step 5:** commit `feat(app): register projects settings page`.

### Task 6: Master–detail scaffold (list rail + empty detail)

**Files:**
- Modify: `src/app.rs` (state fields `:1427-1467` block, init in `Tide::new` `:2914-2931`, search entity `:2039-2042`)
- Modify: `src/app/projects_page.rs`
- Modify: `src/lib.rs:276-284` area (key init re-export)
- Test: row-model unit tests in `projects_page.rs`

**Step 1:** state on `Tide`, mirroring the skills block (`app.rs:1437-1462`):

```rust
projects_settings_search: Entity<TextInput>,   // placeholder tr!("projects.search")
projects_settings_list: ListState,             // ListState::new(0, ListAlignment::Top, px(512.0))
projects_settings_scrollbar: Rc<ScrollbarState>,
projects_settings_rows: RefCell<Vec<ProjectsRow>>,
projects_settings_selected: Option<Uuid>,
projects_detail_scroll: ScrollHandle,
```

**Step 2:** row model + sync, cloned from `skills_page.rs:55-69` and `:671-691`:

```rust
#[derive(Clone, Debug, PartialEq)]
pub(super) enum ProjectsRow {
    Project { id: Uuid, row_key: u64, selected: bool },
}
```

`sync_projects_rows(&self, rows: &[ProjectsRow])` with the same `take_while` prefix-splice; `projects_rows_from(&self, query: &str) -> Vec<ProjectsRow>` filters `self.state.projects` by name/path lowercase contains.

**Step 3:** render — `render_projects_settings` reads the query from `projects_settings_search.read(cx).content()` (`skills_page.rs:342` pattern), computes rows, syncs, returns list column + detail column. List column: `TextField::new("projects-search-field", ...)` + `list(self.projects_settings_list.clone(), ...)` + `scrollbar::vertical` + `.key_context("ProjectsPane")` + `on_action` listeners for `SelectNextEntry`/`SelectPreviousEntry` (`src/ui/menu.rs:41`) calling a `step_project_selection` cloned from `step_skill_selection` (`skills_page.rs:298-336`, using `next_picker_highlight` from `super::composer`). Row click: `.on_click` sets `projects_settings_selected`, resets detail scroll, `cx.notify()` (`select_skill` pattern `:286-292`).

**Step 4:** key bindings: `init(cx)` in `projects_page.rs` binding `"down"`/`"up"` → the entry actions scoped to `"ProjectsPane > TextInput"` (pattern `skills_page.rs:27, 49-54`; `TextInput` context exists because `src/input.rs:2482` declares it). Register via `lib.rs` next to `init_skills_keys` (`lib.rs:284`).

**Step 5: Tests.** `projects_rows_from` filtering (query hit on name, on path, no hit) and `step_project_selection` wrap-around on a fixed row vec.

**Step 6:** `cargo test -p tide projects_ && cargo check -p tide`. **Step 7:** commit `feat(app): projects settings master-detail scaffold`.

### Task 7: General section — identity, path, icon

**Files:**
- Modify: `src/app/projects_page.rs`
- Create: `assets/icons/projects/*.svg` (8–12 preset glyphs) + register in the `icons!` list in `src/assets.rs:19-263`
- Modify: `src/app.rs` (background icon-resolution state fields)
- Test: pure fns in `projects_page.rs`

**Step 1: pure auto-icon logic + tests:**

```rust
/// Deterministic fallback: initials + hue from the project name.
fn auto_fallback(name: &str) -> (String, f32) { /* first chars of up to 2 words; hue = hash % 360 */ }

/// Well-known repo-root icon files, in precedence order.
const WELL_KNOWN_ICONS: [&str; 4] = ["icon.png", "favicon.png", "logo.svg", "logo.png"];
```

Tests: initials ("foo bar" → "FB"), hue stability for the same name, precedence order constant non-empty.

**Step 2:** write path (`ProjectIconSetting` writes go through the snapshot — Phase 4 task 10 wires the round-trip; until then mutate local `Project` state + `cx.notify()`, matching how other pages stage edits). Rendering rules: `Auto` → resolved image or initials tile with hash hue (tinted by `icon_color` when set); `Preset(path)` → `img(path)` (polychrome precedent `src/ui/mod.rs:42-44`); `Uploaded(name)` → `gpui::Image::from_bytes` loaded from the assets dir (`~/.tide` path via `crates/store/src/paths.rs`).

**Step 3:** resolution is background-only (AGENTS.md perf rules): on selection change or `Auto` write, spawn on `cx.background_executor()` — probe `WELL_KNOWN_ICONS` under `project.path` — guard with a generation counter, land `(Uuid, Option<PathBuf>)` on `Tide`, `cx.notify()`. Render reads only stored results; a miss renders the initials tile.

**Step 4:** upload affordance: `cx.prompt_for_paths(PathPromptOptions { files: true, .. })` (precedent `src/app/sessions.rs:1534`) → validate extension via `image_preview::image_format_for_name` → copy bytes to the assets dir as `<project_id>.<ext>` (background spawn) → set `ProjectIcon::Uploaded(name)`. Inline error + keep previous icon on failure (oversize/non-image).

**Step 5:** preset swatch row (img thumbnails, `.selected` ring) + color swatches (fixed palette + `icon_color`), each an `icon_button`-style control with text alternative.

**Step 6:** name inline edit via `ProjectNameSelector` (`src/ui/mod.rs:401`) — verify its write path; if it is session-bound, wrap it with a small `TextField` + commit-on-enter that renames via the same project-update path. Path caption with warning row (`icon("icons/alert.svg")` + text) when `!project.path.exists()` — existence is known from the background probe, never `std::fs` in render.

**Step 7:** `cargo check -p tide`, validate in the dev-watcher app (list → select → edit name → pick preset → pick color → upload). **Step 8:** commit `feat(app): projects identity and icon editing`.

### Task 8: Default model + Memory & RAG + Git identity sections

**Files:**
- Modify: `src/app/projects_page.rs`
- Modify: `src/app/settings.rs:2440-2570` (git picker moves out), `:1519+` (git screen keeps global)
- Modify: `src/app/settings.rs:523` (`render_knowledge_settings` — per-project section moves out)
- Modify: `src/app/rag_settings.rs` (reuse `rag_set_enabled` at `:147` + `RagStatus` state)
- Test: none pure — dev-watcher validation

**Step 1 — default model picker:** `dropdown_menu` (in-house, `src/ui/menu.rs:693`) listing models from the same catalog the composer picker reads (`src/app/model_picker.rs`, catalog from `crates/protocol/src/model_catalog.rs`), items = `MenuItem::new(...).selected(current == candidate)` writing `project.default_provider`/`default_model`; a "Global default" first item clears both (selected when both are `None`).

**Step 2 — memory & RAG:** move the Knowledge screen's per-project memory & RAG section into the detail panel. Reuse `RagSettingsPanel` (`src/app/rag_settings.rs:22`) or its toggle row; enable/disable dispatch stays `RagEnableWorkspace`/`RagDisableWorkspace { project_id }` (`crates/protocol/src/protocol.rs:221-227`) through `rag_set_enabled`. Keep one source of truth for enabled-state — reuse whatever field `render_knowledge_settings` reads today; do not fork a second cache.

**Step 3 — git identity:** cut the per-project block from `render_git_settings` (`settings.rs:2440-2570` — trigger row + `dropdown_menu` over `snapshot.profiles` with the "Global" item) and re-mount it in the detail panel, dispatching through the unchanged `git_set_project_identity`/`git_clear_project_identity` (`src/app/runtime.rs:3986-3996`). The page reads the same git snapshot the Git page holds; when it is `None`, request it the way the Git page does on open (`git_dispatch` + drain). Delete the block from the Git screen; keep accounts/profiles/attribution.

**Step 4:** validate in the dev-watcher app: model override applies to a fresh chat in that project; RAG toggle flips; identity picker writes repo-local config (`git config user.name` in the project confirms). **Step 5:** commit `feat(app): projects default model, memory, and identity sections`.

### Task 9: Actions — editor + triggers

**Files:**
- Modify: `src/app/projects_page.rs` (actions list editor)
- Modify: `src/app/composer.rs` (toolbar menu anchor near the model picker, `composer.rs:879` area)
- Modify: `src/app/inspector/mod.rs:66-92,134-157`, `src/app/inspector/sections.rs` (new section)
- Modify: `src/app/right_panel.rs:2266-2280` (reuse the terminal-open path)
- Test: pure fns (name/command validation)

**Step 1 — editor:** rows of `name` + `command` text fields with remove `icon_button`, plus an add row. Validate non-empty command on commit; store into `project.actions` (local mutate + `cx.notify()` until the snapshot round-trip lands in task 10).

**Step 2 — trigger surfaces:** a `dropdown_menu` button in the composer toolbar (anchor precedent `composer.rs:879`, menu usage `sidebar.rs:532-562`): items = the selected project's actions, disabled when the project has none; plus `SectionId::Actions` in the inspector (`mod.rs` enum + `header_id` arm + `render_inspector_actions_section` in `sections.rs` mounted in the `render_inspector_card` chain `mod.rs:150-157`), rendering one run button per action.

**Step 3 — execution:** click → resolve the selected session's right-panel terminal per `right_panel.rs:2266-2280` (`TerminalView::new(project.path, cx)`), then write `command` + `\n` into the PTY (`src/terminal.rs:107` `write_pty` / `:255` `write`). Interactive commands like `bun run dev` keep running in that tab; output never touches the transcript. If no terminal surface is available (panel unavailable), fall back to a toast naming the command.

**Step 4 — tests:** pure validation fn (empty command rejected, name trimmed); a test that the actions-menu items builder maps `project.actions` 1:1. **Step 5:** validate in the dev-watcher app with a real `bun run dev`-style action. **Step 6:** commit `feat(app): project actions with editor, menus, and terminal execution`.

---

## Phase 4 — Snapshot round-trip + removal

### Task 10: Persist edits through the daemon

**Files:**
- Modify: `crates/protocol/src/protocol.rs` (new command), `crates/backend/src/daemon.rs` (arm)
- Modify: `src/app/runtime.rs` (dispatch + snapshot apply, near `git_dispatch` `:3986`)
- Modify: `src/app/projects_page.rs` (stage → dispatch)

**Step 1:** protocol command:

```rust
UpdateProjectSettings {
    project_id: Uuid,
    icon: ProjectIcon,
    icon_color: Option<String>,
    default_provider: Option<ProviderKind>,
    default_model: Option<String>,
    actions: Vec<ProjectAction>,
    name: String,
},
```

**Step 2:** daemon arm updates the persisted `Project` and replies with a fresh task-state snapshot (`apply_remote_task_state` at `runtime.rs:677` merges it via `restart_task_state_sync`'s normal path; `self.state.projects = snapshot.projects` at `runtime.rs:696`).

**Step 3:** the page switches its editors from local-mutate to dispatch-then-land: optimistic local update for snappy UI, snapshot arrival reconciles, failed round-trips revert to the prior values with a toast (per design's no-optimistic-write-loss rule).

**Step 4:** `cargo check -p tide -p backend`, dev-watcher validation (edit name/icon/actions, restart the app, confirm persistence). **Step 5:** commit `feat(app): persist project settings via UpdateProjectSettings`.

### Task 11: Remove project

**Files:**
- Modify: `src/app/projects_page.rs` (bottom destructive row + confirm dialog)
- Modify: `src/app/runtime.rs` (dispatch + post-removal selection)
- Test: selection-fallback pure fn

**Step 1:** confirm dialog modeled on the existing dialog precedents (`src/app/commit_dialog.rs` / `git_dialogs.rs`): title, project name, checkbox "Also delete sessions and history" (default off), destructive confirm button.

**Step 2:** dispatch `RemoveProject { project_id, delete_history }`; on the returned snapshot, if the removed id was selected move selection to the next row (`projects_rows_from` order), else to none. `remove_session` cleanup at `sessions.rs:414/:449` already handles sessions of vanished projects — verify no draft panics for the removed project and that `apply_remote_task_state`'s re-selection (`runtime.rs:741-751`) stays consistent.

**Step 3: test** the next-selection pure fn (removing first/last/only row). **Step 4:** `cargo test -p tide`, dev-watcher validation both checkbox states (sessions survive vs. gone). **Step 5:** commit `feat(app): remove project with optional history cascade`.

### Task 12: Final checks

1. `cargo fmt --package tide --package protocol --package backend -- --check`
2. `cargo check` and `cargo test` (full, per AGENTS.md)
3. Dev-watcher pass: sidebar entry + command palette hit, search filter, keyboard walk (arrows from the search field, tab into detail), rename/icon/model/actions/git/RAG/remove — both themes, both locales spot-checked (`ja`, `zh-CN` keys present), missing-directory warning with a moved-away project.
4. Update `locales/*` for any strings introduced late; re-run fmt.
5. Commit any residue: `chore: projects settings polish`.

## Risks / open questions

- `ProviderKind` default semantics for the model-only override (task 1 step 2) — resolve by reading `new_session` (`crates/client/src/persistence.rs:469-473`); simplest correct rule may be "default_model requires default_provider".
- `ProjectNameSelector` (`src/ui/mod.rs:401`) may be session-shaped — if so, wrap, don't refactor it.
- Session cascade scope in `app.db` depends on the real table graph in `db/schema.ts` — enumerate tables with a project reference before writing the cascade.
- The inspector's `MemoryRag` section and the Knowledge screen may already duplicate per-project RAG state — consolidate to one store of truth while moving (task 8 step 2).
