# MCP Servers Integration — Implementation Plan

> Research record: `docs/plans/2026-09-04-mcp-integration-research.md` (read
> first — every behavioral constant and parity gotcha cited below is sourced
> there). Spec source: upstream `/Volumes/512gb/TestAi/tide`
> (`src-tauri/crates/tide-mcp/` + `src/components/screens/settings/mcp/`).

**Goal:** Port upstream's MCP integration 1:1 into this fork: the vendored
client pool (rmcp 3), OAuth, secrets, import scanner, the 18-command surface,
and the Settings → MCP page (add/edit form, import dialog, rows) in GPUI.

**Decisions (validated 2026-09-04 with Yogi):**
- Project-scoped OAuth lives in a **sidecar**
  `<data_dir>/mcp-oauth/<project_id>.json` with upstream's exact
  `{tokens, clients, verifiers}` sections (fork projects are app.db rows;
  config.json `workspaces` is vestigial here). User-scoped OAuth stays in
  `config.json` top-level `mcpOAuth`, byte-compatible with upstream.
- Upstream's (stale) `~/.tide/mcp.json` hint copy is kept **verbatim** for
  string parity.
- The composer's MCP tab stays **absent** (upstream removed it deliberately).
- Protocol commands ride the **current uncommitted v7** bump (not yet
  released); if the RAG work ships separately first, bump to v8 instead.

**Prerequisite:** land the current working tree (RAG feature + fmt pass) as
commits before Task 1 — this plan builds on the project-scoped driver
(`project_id` in `driver/tide.rs`) and protocol v7 that tree introduces.

**Tech Stack:** Rust, rmcp 3.1 (`client`, `transport-async-rw`,
`transport-streamable-http-client-reqwest`, `auth`), tokio, existing
`tools`/`store`/`protocol`/`backend` crates, GPUI for the page + dialogs,
`locales/app.yml` via `tr!`.

**Conventions** (same discipline as the inspector/timeline plans): tests in the
same file or `tests.rs` sibling, `cargo test -p <crate>` green before every
commit, one task = one commit (`feat(mcp): …` / `fix(protocol): …`), pure fns
for all decisions, TS bindings regenerated (`bun run protocol:generate`) in the
same commit as any wire change. Perf rules (AGENTS.md): the page renders only
stored state; scans/polls ride `cx.background_executor()`; the daemon owns all
I/O. A11y: every row action keyboard-reachable (`track_focus` + `tab_index` +
Enter/Space, visible focus); status color always paired with icon/text.

---

## Task 1 — fix `export_types` output path (standalone fix)

**Files:** `crates/protocol/src/bin/export_types.rs` (line 26:
`packages/client/src/generated` → `packages/tide-client/src/generated`).

**Steps:** change the path; run `bun run protocol:check` (must pass against the
current tree); commit `fix(protocol): point the TS exporter at the renamed
tide-client package`.

## Task 2 — vendor `crates/mcp` from upstream `tide-mcp`

**Files:** create `crates/mcp/` (copy of upstream `src-tauri/crates/tide-mcp/`;
package name `mcp`, edition 2021, same dep feature set as upstream's Cargo.toml
plus `dev-dependencies: tempfile`); add to `[workspace.members]` +
`default-members` in the root `Cargo.toml`.

**Seam adaptations (the only edits; everything else ports verbatim, tests
included):**
1. `tools.rs`: `tide_tools::…` → `tools::…`. The `Tool` trait, `ToolSpec`,
   `ToolOutcome`, `ToolError`, `RiskTier` are identical (verified) — import
   swap only. The `mcp__` ReadOnly tier already exists in
   `crates/tools/src/permission/mod.rs:147`.
2. `config.rs`: `tide_store::config::Config` → `store::config::Config`
   (`mcp_servers` field name matches). Verbatim otherwise.
3. `oauth.rs`: keep user-scope storage verbatim (config.json top-level
   `mcpOAuth`); replace the **project-scope** branch of `OAuthStore` with the
   sidecar `<data_dir>/mcp-oauth/<project_id>.json` — identical section/value
   formats (`{tokens, clients, verifiers}`, plain base64(JSON),
   undecodable = absent). `resolve_workspace_id` is deleted — callers pass
   `project_id` explicitly.
4. `pool.rs`: verbatim except threading `project_id: Option<String>` through
   `ResolvedServer`-adjacent plumbing where upstream used
   `(workspace_id, workspace_root)` pairs.

**Tests:** upstream's suite runs unmodified (config inference/validation/merge,
pool connect/retry/backoff via the echo fixture, scanner, secrets); add:
sidecar OAuth round-trip + undecodable-legacy-reads-absent, project-id keying
isolation (two projects don't share tokens).

**Step 1 — failing tests** for the sidecar store; **Step 2** — vendor + adapt.
Commit `feat(mcp): vendor the upstream mcp pool crate (rmcp 3)`.

## Task 3 — protocol v7 additions + bindings

**Files:** `crates/protocol/src/protocol.rs`, then `bun run protocol:generate`.

**Commands** (parity with upstream's 18; naming follows the existing enum
style): `McpList { project_id: Option<String> }`, `McpAdd { name, config,
scope }`, `McpUpdate`, `McpRemove`, `McpApprove { name }` (benign no-op,
wire parity), `McpRetry`, `McpAuthenticate`, `McpReauthorize`,
`McpReinitialize`, `McpSetEnabled { name, enabled, scope }`,
`McpSetSecret`/`McpHasSecret`/`McpClearSecret`, `McpScan`, `McpImport {
servers, scope }`, `McpReadRaw`/`McpWriteRaw`, `McpWorkspaceActivated {
project_id, project_root }`.

**Wire types** (`#[serde(rename_all = "camelCase")]` + `TS` derive, mirroring
upstream `shared/rpc.ts` shapes): `McpServerConfigWire` (the 7-field config),
`McpServerStatusWire` (= `ServerStatusRow` + `enabled`),
`McpDetectedServerWire`, `McpScanResultWire`, `McpOpResultWire`,
`McpImportResultWire`, `McpRawConfigResultWire`, `McpAuthenticateWire {
ok, url }`, `McpHasSecretWire { has }`. Status strings are the 6-value backend
set (`connecting|connected|disconnected|needs_oauth|needs_credentials|error`).

**Event:** `SequencedEvent::McpStatusChanged` (empty payload — the app
re-fetches on receipt, exactly upstream's ping). Plumbing follows the
`UsageUpdated` pattern from the inspector work (protocol model, backend emit,
wire conversions, runtime drain hook).

Commit `feat(mcp): protocol commands, wire types, status event`.

## Task 4 — backend service: pool ownership + command handlers

**Files:** create `crates/backend/src/mcp.rs`; wire handlers in
`crates/backend/src/daemon.rs` (Command match + `handle_driver_command`
catch-all arms); `mod` line in `crates/backend/src/lib.rs`.

**Content:** port `McpPoolCell` (upstream `src/agent/mcp.rs`, pure tokio)
adapted to the daemon: `PoolKey { project_root: String, generation: u64 }`;
spawn-and-return `ensure_started(config, project_root)`; superseded builds
discarded; status notifier → emit `SequencedEvent::McpStatusChanged` (coalesce
— the ping carries nothing). Boot: install in `TideBackend::new` right where
`crate::rag::install_memory_index()` sits (user-scope boot connect in the
background). Scope resolution: user from `store::config::load(config_path())`;
project from `<project_root>/.mcp.json` with `project_id` from app.db (same
project lookups the RAG service uses).

**Handlers** implement upstream semantics exactly (research §2): validate
before write, nothing-on-error; add/update fire-and-forget connect when a pool
exists; remove → `pool.unload`; set_enabled writes `extensions.disabled.mcp`
(the field already exists in `store::config::Config`) then
disconnect/reconnect; retry re-reads fresh config from disk; reinitialize bumps
the generation; raw write replaces the map unvalidated; scan takes `$HOME`
(`HOME` else `USERPROFILE`), import writes without validation then background
connects; secrets via `mcp-secrets.json`, `has_secret` only ever returns a
bool. `McpWorkspaceActivated` records the active project and rebuilds the pool
on change.

**Tests** (in `crates/backend/src/mcp.rs` + daemon tests): add/update/remove
round-trips against a temp `TIDE_DATA_DIR`; disabled-allowlist toggling
preserves sibling domains; import writes-then-connects; event fires on status
transition; `McpApprove` is a no-op `Ok`. Commit `feat(mcp): daemon pool
ownership and the 18 command handlers`.

## Task 5 — turn assembly + driver wiring

**Files:** `crates/backend/src/driver/tide.rs` (tool build site ~:1088-1100
and the gated-call context).

**Content:** mirror upstream `assemble_engine_and_tools` (chat.rs:270-300):
before each turn, `ensure_started(config, project_root)` (spawn-and-return — a
slow stdio server must not block turn acceptance); tools = `core_tools()` +
`pool.mcp_tools()`; then filter out tools of disabled servers by
`split_namespaced_tool_name`. The pool Arc comes from backend state (one per
daemon, keyed by project root), never per-driver. MCP tool executes route
through the existing gated-call path (read-only tier, never
permission-wrapped — already true at `permission/mod.rs:147`).

**Tests:** disabled-server filtering (pure fn over namespaced names); tools
absent while pool builds; present after connect (echo fixture).
Commit `feat(mcp): bridge pool tools into every turn`.

## Task 6 — app-side state + event drain + page registration

**Files:** create `src/app/mcp_settings.rs` (state + data plumbing only —
rendering lands in Tasks 7-9); `src/app.rs` (`mod mcp_settings;` in the
declaration block, `McpSettingsPanel` field on `Tide`, `SettingsPage::Mcp`
variant **after Skills**, sidebar icon `icons/plug.svg` + search keywords);
`src/app/settings.rs` (page row + render arm);
`src/app/runtime.rs` (drain `McpStatusChanged` → `mcp_refresh()`);
`src/assets.rs` (icon).

**Content:** template is `rag_settings.rs` — `mcp_dispatch` request helper,
`mcp_refresh(project_id)` list fetch, `drain_mcp_events` returning
"did-change" for `cx.notify()`, poll-on-page-open hook in
`set_settings_page` (usage_page.rs pattern). State:
`servers: Vec<McpServerStatusWire>`, `dialog: DialogState`, `import:
ImportState`, `import_badge: usize`, `reinitializing: bool`, pagination
page per scope. Mount behavior: `McpScan` sets the badge (servers −
alreadyImported). Live updates: event → full `McpList` re-fetch; the
flash-guard (never replace a non-empty list with an empty one while
`reinitializing`) as a pure fn + test.

**Tests:** flash-guard; badge arithmetic; scope partitioning
(user/project/builtin ordering). Commit `feat(mcp): settings state, event
drain, page registration`.

## Task 7 — settings page: cards, rows, header

**Files:** `src/app/mcp_settings.rs` (render half).

**Content (research §6 verbatim):** header title `MCP`, description
`Connect external tools via MCP servers.`; header actions: Reload icon button
(title `Reload MCP servers`, spinner while reinitializing → `McpReinitialize`
→ toast `MCP servers reloaded` / `Reload failed`) and the split primary
`[＋ Add][▾]` with menu items Import (disabled at badge 0, numeric badge) and
`Re-initialize all`. Cards in fixed order **Global → Built-in → This
Workspace**, each rendered only when non-empty, with upstream's exact hint
copies (incl. the deliberately-kept `~/.tide/mcp.json · available in all
workspaces`). Rows: status LED (icon + tint per the research table), name,
transport chip (stdio neutral / sse blue / http accent), scope chip, status
line, tool chip → popover (mono list, `View available tools`); hover actions —
needs_oauth: Authenticate + Re-authorize; error/needs_credentials: Retry;
connected+oauth: Reauthenticate; non-builtin: Edit + Remove (confirm popover
`Remove {name}?` / `Disconnects the server and deletes its config entry.`);
right-aligned enabled switch. Disabled rows dim; Ban LED overrides all.
Pagination at >5 per card (`Showing a–b of n`, prev/next, page clamp).
Empty state `No MCP yet` + `View MCP spec` (`cx.open_url`,
modelcontextprotocol.io). A11y: row actions are buttons with `tab_index` +
`focus_visible`; the LED always pairs icon + text. GPUI idioms: `div().id()`
before interactivity, `Theme::current(cx)`, `crate::ui::{icon, icon_button,
toggle_switch}`, card treatment per the toast idiom.

**Tests:** row action visibility matrix (state × scope) as pure fns; LED
mapping table; pagination clamping. Commit `feat(mcp): settings page cards,
rows, header actions`.

## Task 8 — add/edit dialog

**Files:** `src/app/mcp_settings.rs` (dialog render + logic; modal precedent:
`tide_wizard.rs` overlay, `rag_settings.rs` source dialog).

**Content (research §2):** `Add MCP server` / `Edit {name}` modal with
Cancel + Check-icon `Add`/`Save` (disabled unless saveable). Create defaults
to **Form mode**, edit to **JSON mode**; segmented toggle with bidirectional
sync (Form→JSON always; JSON→Form refuses while invalid). Scope cards Global /
Workspace (orange active ring + check, `#d97757` hue; default `project` when a
project is selected else `user`). Form: Name (disabled in edit), transport
segmented `stdio`/`SSE`/`HTTP`, per-transport fields with upstream's exact
placeholders and helpers (args one-per-line; env `KEY=value`, `#` comments,
split at first `=`; URL placeholder `…/sse` vs `…/mcp`; Auth None/OAuth;
Headers JSON). JSON: mono editor, 250 ms debounced validation on the
background executor, live validity line (red message / green `Valid`),
wrapped-name unwrap + auto-fill, type inference with upstream's exact error
strings, collapsible Examples (the five snippets, incl. the
`{{secret:my_api_key}}` template). Save flow: rename = `McpRemove(old)` +
`McpUpdate(new)`; refresh + 500 ms late second refresh; toasts `Server
added`/`Server updated`/`Save failed`.

**Tests:** `try_parse_config` grammar (every error string asserted);
form↔config conversions; debounced state machine with a manual-clock executor;
saveability predicate. Commit `feat(mcp): add/edit dialog with form/json
modes`.

## Task 9 — import dialog

**Files:** `src/app/mcp_settings.rs`.

**Content (research §3):** `Import MCP` modal, description `Detected from
Claude Code, Codex, OpenCode, and other configs.`; scan state → empty state →
results grouped by source with group select-all checkboxes; **checkboxes
default to none**; already-imported rows dimmed with `(already in Tide)` and
disabled checkbox; type chip + mono summary (`command || url` + up to 2
non-flag args); scope cards below results only when importable; footer
`{n} selected` + `Import {n}` → `Importing {n}…`, dismissal blocked while
importing; confirm always closes; parent toasts `Imported N server(s)` /
`Import failed`, resets badge, refreshes.

**Tests:** grouping + default-none selection; already-imported matching by
name; summary-line arg filtering (pure fns). Commit `feat(mcp): import
dialog`.

## Task 10 — locales

**Files:** `locales/app.yml` (`mcp.*` + `settings.mcp*` keys, English exact
upstream strings; the ~80 literals are catalogued in the research doc §6).

Commit `feat(mcp): strings`.

## Task 11 — end-to-end validation

- `cargo test --workspace` green (the two sandbox-blocked PTY tests stay
  environment-fails).
- `bun run protocol:check` green.
- Watcher-rebuilt debug app: add a stdio server (`npx`-free echo fixture is
  unavailable in-app — use a real server, e.g. the filesystem server), verify
  connect, tools surfacing in a turn, `mcp__` transcript rendering, OAuth
  against a remote server (loopback tab opens, tokens land in
  `config.json`/sidecar), import from a staged `~/.claude.json`, disable/
  retry/reinitialize flows, keyboard-only pass over the page and dialogs
  (AGENTS.md a11y), reduce-motion respected for the spinner.
- Fidelity checklist (research §8) walked item by item.

---

## Deliberately out of scope (parity with upstream)

- Composer MCP mention tab (removed upstream), per-server log streaming
  (doesn't exist upstream), per-tool-call timeouts (upstream accepts the hang),
  built-in servers (no fixture ships upstream), Cursor/Claude-Desktop scanner
  sources (upstream doesn't scan them).
