# Projects Settings Screen — Design

A new **Projects** page in the Settings window: a master–detail screen (in the
style of the Skills page) that becomes the single home for per-project
configuration. Per-project controls currently scattered across the Git and
Knowledge screens move here; those screens keep their global scope.

## Decisions

- **Placement.** `SettingsPage::Projects`, sidebar entry between **Git** and
  **Tide**. Full-viewport layout like Skills and Usage.
- **Scope.** The screen manages project identity (name, path, icon), default
  model for new chats, custom actions, git identity, and memory & RAG.
  Provider/model agent defaults beyond the new-chat default are out of scope.
- **Canonicality.** Per-project configuration moves to this screen. Git
  settings keeps accounts, profiles, and attribution (global); Knowledge keeps
  global knowledge sources.
- **Git identity storage.** Unchanged — overrides still write repo-locally
  (the project's `.git/config`) via the existing backend commands. Only the
  editing UI moves.
- **No "Add project" button.** The rail lists existing projects; adding stays
  in its existing flow.
- **Removal.** Confirm dialog with an "Also delete sessions and history"
  checkbox (default off). Unchecked removes only the project row; checked
  cascades through the backend.
- **Actions execution.** Triggered manually from a dropdown at the session
  topbar and in the inspector panel. Tide executes the command itself as a
  local shell process in the project directory — not through the agent; output
  never touches the transcript.

## Screen structure

New `src/app/projects_page.rs`, modeled on `src/app/skills_page.rs`:

- `SettingsPage::Projects` variant in `src/app/settings.rs` with a sidebar
  entry and a match arm in `render_settings_content`, opting into the
  `fills_viewport` full-viewport layout.
- **Left rail.** Virtualized `list()` of projects (name + path caption) with a
  search field filtering by name/path. Keyboard arrangement mirrors Skills:
  `up`/`down` walk selection, focus claims from under the detail panel,
  `tab_group`/`tab_stop` keep both halves reachable.
- **Right panel.** The selected project's configuration (below).
- App state gains `projects_selected: Option<Uuid>` plus list state and search
  query, mirroring `skills_selected` / `skills_list_state`.

## Detail panel

**General**

- **Name** — inline edit via `ProjectNameSelector`. **Path** as caption,
  replaced by a warning row (icon + text) when the directory is missing.
- **Icon** — pick from a preset set shipped in `assets/`, upload a file (small
  PNGs stored under the `~/.tide` assets dir keyed by project id), or leave on
  **Auto**. Auto checks well-known files at the project root (`icon.png`,
  `favicon.png`, `logo.*`); if none, derives initials plus a deterministic
  background color from a hash of the name. A background color swatch applies
  in all three modes.
- **Default model for new chat** — provider/model picker persisted per
  project. When set, `create_session_for` uses it instead of the global
  `last_provider`; the composer's model picker still overrides per session.
- **Actions** — list of `{name, command}` rows with add/edit/remove.

**Git identity** — the per-project identity picker moves here from
`render_git_settings`; writes go through `git_set_project_identity` /
`git_clear_project_identity`. The Git screen's per-project section is removed.

**Memory & RAG** — the per-project RAG toggle moves here from the Knowledge
screen; writes use the existing backend path (project ids in
`config.rag_enabled_workspaces`). Knowledge keeps global knowledge sources.

**Remove** — destructive action at the panel bottom with the confirm dialog
described above; after removal the selection moves to the next project.

## Storage

New fields on `Project` in `crates/protocol/src/model.rs`: `icon` (preset id /
uploaded asset path / auto + color), `default_model`, and `actions`.
Persisted through backend persistence in `app.db`; the project snapshot
carries them. No separate table.

## Error handling

- Icon upload rejects oversized files or non-image formats inline, keeping the
  previous icon.
- Non-zero action exits surface in the output surface only.
- A project with a missing directory stays fully editable; git identity and
  RAG sections show a "directory unavailable" note.
- Failed backend round-trips keep the panel's old values and show a toast; no
  optimistic writes.

## Accessibility

Arrows walk the rail, `tab` moves rail → panel, all controls are tab stops
with `focus_visible` rings, `escape` closes dialogs and menus. Icon-only
affordances carry text alternatives. Warnings pair icon + text, never color
alone.

## Performance

Virtualized list with a per-frame row cache. Detail edits read the cached
project snapshot — no fresh fetch per frame. Icon upload, hashing, and
auto-discovery probing run on `cx.background_executor()` with results landed
via `cx.notify()`. The session-topbar action dropdown reads only the
in-memory project record.

## Localization

All new strings in `locales/{app,ja,zh-CN}.yml`.

## Testing

- Pure-logic unit tests: auto-icon derivation (hash → color/initials,
  well-known file precedence), action-list add/edit/remove, default-model
  fallback order.
- UI validated in the dev-watcher app per AGENTS.md.
- Checks: `cargo fmt --package tide --package protocol --package backend --
  --check`, then `cargo check` and `cargo test`.
