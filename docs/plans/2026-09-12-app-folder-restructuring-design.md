# Desktop App Folder Restructuring — Design

Date: 2026-09-12 · Branch: `feature/global-rag-settings` · Status: implemented (Stages 1–5 complete; Stage 6 started with the `ShellState` aggregate; Stage 7 docs updated)

Implemented in commits `f13104d` (component boundary), `a0bfed2`
(screens + layouts, `app.rs` → `app/mod.rs`), `61bd5bb` + `a6337a5`
(settings pages), `6e157a4` (core features), `126004e` (right_panel split),
`67de7f9` (`ShellState`). §15 resolutions: `features` naming; Git as Settings
page + Workspace feature; background work under `features/sessions`;
root-mounted overlays only; rename done in Stage 2.

Reorganizes the root GPUI crate around explicit application concepts:
full-window screens, pages within those screens, structural layouts, product
features, Tide-specific reusable components, and generic UI primitives. This
is a source-organization change, not a rewrite of Tide's UI architecture. The
existing `Tide` GPUI entity, cached pane strategy, background-executor rules,
wire behavior, and visible interaction design remain intact.

This document is the discussion artifact required before beginning a change
larger than a bug fix. Implementation starts only after the associated issue
has been opened and the taxonomy below has been accepted.

## 0. Current state

The workspace-level split is now intentional and healthy: `protocol`,
`client`, `transport`, `backend`, `runtime`, `host`, `engine`, `store`,
`tools`, and `rag` have distinct responsibilities. This design does not move
code between those crates.

The remaining structural debt is inside the desktop crate:

| Fact | Evidence |
|---|---|
| The `Tide` root entity owns about 285 fields spanning services, navigation, sessions, composer, transcript, workspace, settings, overlays, and frame caches | `src/app.rs:1031` |
| `src/app.rs` is 3,163 lines and declares more than 40 mostly flat child modules | `src/app.rs:1661` |
| `src/app/` contains about 83,000 lines; the largest files combine several responsibilities | `right_panel.rs` 8,029; `background_work.rs` 4,584; `runtime.rs` 4,270; `rag_settings.rs` 3,996 |
| Thirty-nine app modules use `use super::*`, making their real dependencies implicit and making directory nesting hazardous | `src/app/**/*.rs` |
| `src/ui` is mostly a reusable primitive library, but `ui/mod.rs` also knows about `ProviderKind`, `SessionStatus`, `ActivityKind`, and project identity | `src/ui/mod.rs:191` |
| `src/app/components.rs` sounds reusable but its renderers are consumed only by the transcript implementation | `src/app/components.rs:150`, `src/app/transcript_view.rs` |
| `settings.rs` owns the Settings screen shell, navigation, routing, and several page implementations | `src/app/settings.rs:119` |
| `sidebar.rs` owns sidebar behavior and two workspace screens: empty state and new task | `src/app/sidebar.rs:978`, `:2096`, `:2200` |
| `timeline_v2/` already demonstrates a useful cohesive subtree with `parts`, `rows`, search, permissions, tokens, and tests | `src/app/timeline_v2/` |

The problem is not merely large files. The flat namespace obscures ownership:
a new contributor cannot tell whether `components.rs` is a design-system
layer, whether `render.rs` is a screen or layout, or why a new-task screen
lives in the sidebar module. Broad parent imports also let unrelated features
reach the entire `Tide` implementation without declaring what they consume.

## 1. Goals

1. Make a file's directory communicate its role and ownership.
2. Give screens, pages, layouts, features, app components, and UI primitives
   distinct meanings.
3. Make shared code deliberately shared; keep one-feature components local.
4. Replace implicit parent-glob dependencies with explicit imports and narrow
   visibility.
5. Split the highest-churn files along existing state and behavior seams.
6. Prepare the `Tide` root state for gradual grouping without forcing a GPUI
   entity rewrite.
7. Preserve render-path performance, keyboard behavior, platform degradation,
   provider payload ordering, and all visible behavior.

## 2. Non-goals

- No new workspace crates. The desktop organization does not need another
  compilation boundary.
- No redesign, visual refresh, navigation change, or terminology change.
- No conversion of every feature into its own GPUI `Entity`.
- No service locator, dependency-injection framework, global app prelude, or
  generic component framework.
- No simultaneous backend/runtime restructuring.
- No removal of the legacy transcript or renaming of `timeline_v2` while both
  implementations coexist.
- No arbitrary line-count limit. Files split because responsibilities differ,
  not to satisfy a metric.

## 3. Vocabulary and ownership rules

The folder names are contracts, not visual labels.

### Screen

A **screen** is a full-window application mode selected by root app state.
Tide currently has two:

- **Workspace** — sidebar, conversation/new-task area, inspector, composer,
  and optional right panel.
- **Settings** — settings navigation and the selected settings page.

A screen composes layouts and features. It may translate app state into child
inputs and route child actions, but it does not implement an entire feature's
internals.

### Page

A **page** is navigable content inside a screen. The current pages all belong
to Settings: General, Providers, Git, Projects, Memory, Skills, Usage, Daemon,
Computer Use, and Appearance. Pages are nested under
`screens/settings/pages`; there is no global `pages` directory because a page
without its owning screen has ambiguous navigation and layout semantics.

### Layout

A **layout** owns geometry and placement: window frame, workspace columns,
settings split view, panel sizing, clipping, and resize handles. Layouts may
accept child elements and callbacks. They do not load data, invoke the daemon,
mutate session state, or know how a transcript/Git/settings page works.

### Feature

A **feature** owns a user-facing capability and may contain state, events,
controllers, queries, and feature-local rendering. Examples are composer,
sessions, transcript, sidebar, right panel, Git, and background work. A
feature can contain its own `components/` directory when those components are
not reused elsewhere.

### App component

An **app component** is a Tide-domain-aware rendered unit used by at least two
features or screens. Provider marks, status presentation, and project identity
belong here. App components may depend on protocol/model types, `theme`, and
`ui`, but must not depend on the `Tide` root entity or perform I/O.

### UI primitive

A **UI primitive** is domain-neutral: cards, chips, menus, modals, text fields,
scrollbars, tooltips, switches, icons, activation helpers, and motion. The
`src/ui` layer may depend on GPUI, assets, and theme tokens. It must not import
Tide model, protocol, client, backend, runtime, or app-feature types.

### Overlay

An **overlay** is a window-level layer mounted above either screen: command
palette, task switcher, commit dialog, goal dialog, image preview, and provider
wizard. A feature-specific popup that cannot exist outside its feature stays
inside that feature rather than moving to `overlays`.

## 4. Target structure

```text
src/app/
├── mod.rs                         # Tide root entity and module surface
├── state.rs                       # Root-owned state groups and common app types
│
├── layouts/
│   ├── mod.rs
│   ├── window.rs                  # Native/client chrome and outer frame
│   ├── workspace.rs               # Sidebar/main/inspector/right-panel geometry
│   ├── settings.rs                # Settings sidebar/content split geometry
│   └── panels.rs                  # Width animation, clipping, resize handles
│
├── screens/
│   ├── mod.rs
│   ├── workspace/
│   │   ├── mod.rs                 # Workspace screen composition
│   │   ├── empty.rs               # No-project state
│   │   └── new_task.rs            # Project-selected draft screen
│   └── settings/
│       ├── mod.rs                 # Settings screen composition and routing
│       ├── navigation.rs
│       └── pages/
│           ├── mod.rs
│           ├── general.rs
│           ├── appearance.rs
│           ├── daemon.rs
│           ├── computer_use.rs
│           ├── providers/
│           │   ├── mod.rs
│           │   ├── state.rs
│           │   └── page.rs
│           ├── git/
│           │   ├── mod.rs
│           │   ├── page.rs
│           │   └── components.rs
│           ├── projects/
│           │   ├── mod.rs
│           │   ├── state.rs
│           │   ├── list.rs
│           │   ├── detail.rs
│           │   └── actions.rs
│           ├── memory/
│           │   ├── mod.rs
│           │   ├── state.rs
│           │   ├── page.rs
│           │   ├── cards.rs
│           │   └── dialogs.rs
│           ├── skills/
│           │   ├── mod.rs
│           │   ├── state.rs
│           │   ├── list.rs
│           │   └── detail.rs
│           └── usage/
│               ├── mod.rs
│               ├── state.rs
│               ├── page.rs
│               ├── chart.rs
│               ├── projects.rs
│               ├── statement.rs
│               └── format.rs
│
├── features/
│   ├── mod.rs
│   ├── sessions/
│   │   ├── mod.rs
│   │   ├── lifecycle.rs
│   │   ├── runtime.rs
│   │   ├── streaming.rs
│   │   └── background_work.rs
│   ├── composer/
│   │   ├── mod.rs
│   │   ├── state.rs
│   │   ├── view.rs
│   │   ├── attachments.rs
│   │   ├── autocomplete.rs
│   │   ├── drafts.rs
│   │   └── model_picker.rs
│   ├── transcript/
│   │   ├── mod.rs
│   │   ├── state.rs
│   │   ├── legacy.rs
│   │   ├── search.rs
│   │   ├── navigation.rs
│   │   ├── activity_diff.rs
│   │   ├── components/
│   │   │   ├── mod.rs
│   │   │   ├── message.rs
│   │   │   └── activity.rs
│   │   ├── inspector/
│   │   └── timeline/               # Current timeline_v2 subtree
│   ├── sidebar/
│   │   ├── mod.rs
│   │   ├── state.rs
│   │   ├── rows.rs
│   │   └── updater.rs
│   ├── right_panel/
│   │   ├── mod.rs
│   │   ├── state.rs
│   │   ├── tabs.rs
│   │   ├── files.rs
│   │   ├── diff.rs
│   │   ├── browser.rs
│   │   ├── terminal.rs
│   │   └── project_actions.rs
│   ├── git/
│   │   ├── mod.rs
│   │   ├── panel.rs
│   │   ├── history.rs
│   │   ├── branches.rs
│   │   └── operations.rs
│   └── browser/
│       ├── mod.rs
│       ├── bridge.rs
│       └── mermaid.rs
│
├── components/
│   ├── mod.rs
│   ├── project_identity.rs
│   ├── provider.rs
│   └── status.rs
│
└── overlays/
    ├── mod.rs
    ├── command_palette.rs
    ├── task_switcher.rs
    ├── commit.rs
    ├── goal.rs
    ├── image_preview.rs
    ├── git_dialogs.rs
    └── provider_wizard.rs
```

Directories should be introduced only when they hold a real cohesive group.
The tree above is the intended end state, not a requirement to create empty
folders or one-line `mod.rs` files before their contents move.

## 5. Dependency direction

The allowed direction is:

```text
app root
  ├── screens ──> layouts
  │      └──────> features
  ├── overlays ─> features (only where an overlay controls that feature)
  ├── features ─> app components
  └── app components ─> ui primitives

ui primitives ─> GPUI + theme + assets
```

Rules:

1. `ui` never imports from `app`, `model`, protocol, client, backend, host,
   runtime, or store.
2. Layouts receive children/callbacks and never import feature internals.
3. Pages may use features and app components, but pages do not import sibling
   page internals.
4. Features do not import screens. Cross-feature calls go through a narrow
   `pub(super)` entry point or a root coordinator method.
5. `app/components` cannot implement methods on `Tide`; a component receives
   explicit data and callbacks/weak handles.
6. Feature-local components are promoted to `app/components` only after a
   second independent consumer appears.
7. No `prelude.rs` and no broad re-export of `app.rs` symbols. Moved modules
   use explicit imports. `use super::*` is allowed only in a tightly scoped
   test module whose parent already has explicit imports.
8. Public visibility is the exception. Prefer private, then `pub(super)`, then
   `pub(crate)` only when a documented cross-branch consumer requires it.

These rules make the directory structure enforceable during review even
without introducing new crates or a dependency-analysis tool.

## 6. Existing-file mapping

| Current source | Destination / split |
|---|---|
| `src/app.rs` | `app/mod.rs` plus `app/state.rs`; keep only root coordination, constants genuinely shared across the app, construction, and top-level types in `mod.rs` |
| `app/render.rs` | Root `Render` dispatch in `app/mod.rs`; panel mechanics in `layouts/panels.rs`; Workspace composition in `screens/workspace/mod.rs` and `layouts/workspace.rs` |
| `app/window_chrome.rs` | `layouts/window.rs` |
| `app/sidebar.rs` | Sidebar list/state/updater under `features/sidebar`; empty and new-task rendering under `screens/workspace` |
| `app/settings.rs` | Settings route/shell under `screens/settings`; geometry under `layouts/settings`; General, Appearance, Daemon, and Computer Use renderers under corresponding pages |
| `app/projects_page.rs` | `screens/settings/pages/projects/{state,list,detail,actions}.rs` |
| `app/skills_page.rs` | `screens/settings/pages/skills/{state,list,detail}.rs` |
| `app/usage_page.rs` | `screens/settings/pages/usage/{state,page,chart,projects,statement,format}.rs` |
| `app/rag_settings.rs` | `screens/settings/pages/memory/{state,page,cards,dialogs}.rs` |
| `app/tide_providers.rs` | Provider settings state/page under `screens/settings/pages/providers`; provider presentation shared elsewhere goes to `app/components/provider.rs` |
| `app/git_settings.rs` | `screens/settings/pages/git/` |
| `app/right_panel.rs` | `features/right_panel/{state,tabs,files,diff,browser,terminal,project_actions}.rs` |
| `app/composer.rs`, `chat_composer.rs`, `autocomplete.rs`, `drafts.rs`, `model_picker.rs` | `features/composer/` split by the names above; permission and user-input cards remain feature-local until another consumer exists |
| `app/sessions.rs`, `runtime.rs`, `streaming.rs`, `background_work.rs` | `features/sessions/`; background-work visual components may use a local `components.rs` if the split needs it |
| `app/transcript.rs`, `transcript_view.rs`, `transcript_search.rs`, `navigation_rail.rs`, `activity_diff.rs`, `inspector/`, `timeline_v2/` | `features/transcript/`; preserve the existing nested organization of inspector and timeline |
| `app/components.rs` | Message rendering to `features/transcript/components/message.rs`; activity labels/disclosures to `features/transcript/components/activity.rs` |
| `app/git_panel.rs`, `git_history.rs`, `branches.rs` | `features/git/`; shared diff rendering used by both transcript and right panel moves to a narrowly named app component only if neither feature can own it |
| `app/browser_bridge.rs`, `mermaid_images.rs` | `features/browser/` |
| Dialog/palette files mounted by root | `overlays/` |

The mapping is deliberately domain-first. A filename is not preserved when it
currently contains unrelated concepts.

## 7. Reusable-component boundary

### Keep in `src/ui`

- `Badge`, `Card`, `Chip`, `EmptyState`, `Modal`, `Text`, `TextField`,
  `Tooltip`, menus, scrollbar/fade, pixel loader, motion.
- `icon`, `file_icon`, `icon_button`, `ActivationExt`, `toggle_switch`,
  `contain_scroll`, and `next_selection_index`.
- `MenuChip`, because it is a domain-neutral interaction shape used across
  composer, projects, RAG, right panel, settings, skills, and usage.

### Move from `src/ui` to `src/app/components`

- `provider_color` and `provider_icon` → `components/provider.rs`.
- `status_color` → `components/status.rs`.
- `activity_icon` and `activity_noun` → transcript-local activity components
  initially; promote later only if non-transcript features need the complete
  activity vocabulary.
- `ProjectNameSelector` → `components/project_identity.rs`.

### Move from `src/app/components.rs` into the transcript feature

- Message time, footer, attachment, markdown-body, mention-link, and message
  rendering → `features/transcript/components/message.rs`.
- Activity summary, title, action, disclosure, preview, file statistics, and
  reasoning labels → `features/transcript/components/activity.rs`.

This keeps “reusable” honest: code does not become a global component merely
because it returns a GPUI element.

## 8. Root state organization

Folder movement alone does not solve the 285-field root, but state extraction
must follow the file reorganization rather than happen simultaneously. The
target is a small set of plain state aggregates owned by the existing `Tide`
entity:

```rust
pub struct Tide {
    services: AppServices,
    navigation: NavigationState,
    shell: ShellState,
    sessions: SessionsState,
    composer: ComposerState,
    transcript: TranscriptState,
    workspace: WorkspaceState,
    settings: SettingsState,
    overlays: OverlayState,
}
```

These are ordinary structs, not automatically separate GPUI entities. Pane
entities and render caches remain separate where they already avoid expensive
rebuilds. A feature becomes an entity only when independent notification,
focus ownership, or lifecycle is measurably useful; directory boundaries do
not justify entity boundaries by themselves.

Fields move one aggregate at a time. Methods should borrow the narrowest state
possible, but the root may continue coordinating operations that genuinely
span sessions, workspace, and UI. Avoid accessor boilerplate that merely hides
an unchanged global dependency.

## 9. Migration strategy

Every stage must compile and preserve behavior. Do not combine a file move,
state redesign, and feature change in one commit.

### Stage 0 — discussion and baseline

1. Open the structural issue and link this design.
2. Record the accepted taxonomy and any naming changes.
3. Confirm a clean worktree and a successful watcher build before moving
   files.

### Stage 1 — establish the component boundary

1. Create `app/components/` and move the Tide-domain helpers out of `ui`.
2. Split the current transcript-only `app/components.rs` into transcript-local
   message and activity components.
3. Add explicit imports to touched modules; do not introduce an app prelude.
4. Verify that `rg 'crate::(model|protocol|client|backend|runtime)' src/ui`
   finds no domain dependency.

This is the smallest slice and proves the naming/visibility rules before large
moves.

### Stage 2 — screens and layouts

1. Extract window, panel, Workspace, and Settings geometry into `layouts/`.
2. Move root Workspace composition into `screens/workspace`.
3. Move empty/new-task screens out of `sidebar.rs`.
4. Move Settings routing/navigation into `screens/settings`.

The root `Render` implementation remains a short mode switch plus overlay
mounting.

### Stage 3 — Settings pages

Move one page family at a time, starting with the already cohesive stateful
surfaces:

1. Projects and Skills.
2. Usage.
3. Memory/RAG.
4. Providers and Git.
5. General, Appearance, Daemon, and Computer Use.

Each move keeps its current tests with the owning module and replaces parent
glob imports with explicit dependencies.

### Stage 4 — core features

1. Composer and its inputs, attachments, drafts, autocomplete, and picker.
2. Sessions, runtime, streaming, and background work.
3. Transcript, inspector, and timeline.
4. Git and browser helpers.

Do not rename `timeline_v2` to `timeline` until the legacy implementation is
removed; while both exist, the explicit version name communicates the runtime
choice.

### Stage 5 — right panel

Split the largest file after the component and feature boundaries it consumes
exist. Start with pure helpers (`diff`, file paths/icons), then state/tabs,
then individual surfaces, then project actions. Preserve the existing
in-memory caches and session-isolated state during every split.

### Stage 6 — group `Tide` state

Move fields into the aggregates from §8 one group at a time. This stage may
expose operations that cross too many features; keep those operations on the
root coordinator rather than manufacturing circular feature dependencies.

### Stage 7 — tighten and document

1. Remove temporary re-exports created during staged moves.
2. Audit `pub(crate)` visibility and reduce it where possible.
3. Update `AGENTS.md` workspace guidance with the final app taxonomy.
4. Update developer documentation and stale source-path references.

## 10. Performance and accessibility invariants

The restructuring must preserve these constraints:

- No filesystem, process, network, synchronous IPC, or blocking lock reaches
  `Render`, a layout, a page renderer, or a virtualized row builder.
- Background results still land in root/feature state under a generation
  guard and call `cx.notify()`.
- Transcript, sidebar, Git, Skills, Projects, and Usage collections remain
  virtualized and keep their per-frame caches.
- The stream-commit and pulse-clock cadences do not change.
- Cached `TidePane` islands remain cached until measurement proves a different
  ownership model faster.
- Focus handles remain stable across virtualization and file movement.
- Mouse controls retain keyboard activation, focus-visible treatment, and
  conventional keys.
- Reduced-motion checks remain at every direct animation-frame request for
  decorative motion.
- macOS-only browser/computer-use code remains gated, with Linux and Windows
  compiling and degrading gracefully.

## 11. Verification

Run focused checks after each stage and the full suite at the end:

```sh
cargo fmt --package tide --package protocol --package client --package transport \
  --package host --package runtime --package backend --package store -- --check
cargo check
cargo test --locked
```

During normal development, let the existing `bun ./scripts/dev.ts` watcher
rebuild, sign, and relaunch the debug app. Do not start a second watcher or
manually relaunch it. Because this design promises no visible changes, smoke
validation covers navigation between Workspace and every Settings page,
opening/closing overlays, task switching, composer input, transcript
streaming, right-panel surfaces, and keyboard operation. No visual test is
part of this restructuring unless separately requested.

Useful structural checks:

```sh
# UI primitives must not know Tide domain types.
rg 'crate::(app|model|protocol|client|backend|runtime|host|store)' src/ui

# Parent globs should survive only in local test modules.
rg '^use super::\*;' src/app

# Catch stale references to old flat paths after each move.
rg 'app::(right_panel|settings|components|runtime|transcript_view)' src crates
```

## 12. Acceptance criteria

- Workspace and Settings are recognizable as the two top-level screens.
- Each Settings destination has one obvious page module.
- Layout modules contain geometry/composition, not data fetching or feature
  state transitions.
- `src/ui` contains no Tide-domain imports.
- `app/components` contains only cross-feature, domain-aware components and no
  `impl Tide` blocks.
- Transcript-specific message/activity components live with transcript.
- `right_panel.rs`, `settings.rs`, `usage_page.rs`, `rag_settings.rs`, and the
  other identified hotspots no longer combine unrelated responsibilities.
- Non-test app modules do not use `use super::*`.
- The root entity is grouped by domain without unnecessary GPUI entities or
  per-frame indirection.
- No wire, persistence, provider, UI behavior, performance cadence, keyboard
  behavior, or platform support changes.
- Formatting, `cargo check`, and `cargo test --locked` pass.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Nested moves expose many hidden dependencies from `use super::*` | Convert imports explicitly in the same small feature slice; never preserve the glob through broad re-exports |
| Large `git mv` commits conflict with active feature work | Move one cohesive area per commit and coordinate ownership of hotspot files before starting |
| Splitting `Tide` state creates Rust borrow conflicts | Move directories first; group plain data incrementally; keep cross-feature orchestration on the root |
| Component extraction introduces generic abstractions with cumbersome APIs | Require a real second consumer; prefer concrete Tide app components over configurable frameworks |
| Layout extraction accidentally moves work into the render path | Layouts accept already-available values/elements; retain existing background queries and caches |
| File moves lose behavioral test coverage or platform gates | Keep tests beside their owner, run focused tests after every slice, and run the locked cross-workspace suite before completion |
| Review becomes unreadable when moves include logic changes | Separate mechanical move/import commits from subsequent state or implementation changes |

## 14. Alternatives considered

### Keep the flat folder and split only large files

Rejected. It reduces file size but preserves ambiguous ownership and makes the
next feature choose among another set of flat names.

### Organize only by visual type (`screens/components/layouts`)

Rejected. Runtime, sessions, streaming, Git operations, and background work
are cohesive product features that contain more than rendering. Forcing them
into visual buckets separates state from the behavior that owns it.

### Organize only by feature

Rejected. Screens and structural layouts are shared composition concepts, and
Settings pages have a real parent/route relationship worth expressing.

### Create crates for screens or features

Rejected. The features share one GPUI app entity, theme, focus system, and
render caches. Crates would create public APIs and compile boundaries without
solving the root ownership problem.

### Convert every feature into a GPUI entity

Rejected as a default. Independent entities can improve targeted
notifications, but they also add handles, update closures, focus/lifecycle
coordination, and potential frame churn. Use them only when measurement or
ownership demands them.

## 15. Open questions

Resolved 2026-09-12: all five recommendations below were adopted as written
(taxonomy acceptance, Stage 0).

1. **Folder name `features` versus `domains`:** recommendation: `features`,
   because the contents include state, behavior, and visible capability rather
   than pure domain models.
2. **Git placement:** Git Settings is a Settings page, while the Git panel,
   history, branches, and operations form a Workspace feature. Recommendation:
   keep those two placements and share only concrete app components/types;
   do not create a cross-cutting `app/git` dumping ground.
3. **Background work placement:** it is session-owned at runtime but rendered
   in composer, transcript, inspector, and right panel. Recommendation: keep
   state/reduction under `features/sessions/background_work`, promote only its
   genuinely shared visual units to `app/components/background_work` if the
   move reveals more than one independent renderer.
4. **Overlay ownership:** recommendation: place only root-mounted overlays in
   `app/overlays`; keep model-picker menus, transcript permissions, and
   feature popups within their features.
5. **`app.rs` to `app/mod.rs`:** recommendation: make the move during Stage 2,
   when the root render composition moves too. Doing it in isolation creates a
   noisy path-only commit with little structural value.
