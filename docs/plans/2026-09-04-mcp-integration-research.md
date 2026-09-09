# MCP Servers Integration — Upstream Research (how old tide does it)

Researched 2026-09-04 against `/Volumes/512gb/TestAi/tide` (upstream Tide,
branch `feat/git-settings`). Goal: a 1:1 port into this fork — add/edit form,
import, authentication, orchestration must match upstream behavior. This doc is
the research record; an implementation plan follows separately.

## Sources (all read completely)

- Crate under port: `src-tauri/crates/tide-mcp/` — `lib.rs`, `config.rs` (323),
  `pool.rs` (1,156), `oauth.rs` (676), `scanner.rs` (488), `secrets.rs` (176),
  `tools.rs`, `bin/mcp-echo-fixture.rs` (test-only fixture)
- Tauri layer: `src-tauri/src/commands/mcp.rs` (1,572; all 18 commands),
  `src-tauri/src/agent/mcp.rs` (`McpPoolCell`, pool owner), `src/lib.rs` (boot +
  opener wiring), `src/commands/chat.rs` (turn assembly + event forward),
  `src/agent/events.rs`
- UI: `src/components/screens/settings/mcp/{mcp.tsx 491, server-dialog.tsx 788,
  import-dialog.tsx 286, server-row.tsx 362}`, `reload-button.tsx`,
  `shared/rpc.ts` wire types, API bridges, composer pickers, timeline tool
  rendering
- Deps: `rmcp = "3.1"` (features `client`, `transport-async-rw`,
  `transport-streamable-http-client-reqwest`, `auth`), tokio, reqwest

**Key structural fact:** the entire `tide-mcp` crate is portable — Tauri appears
only in the command wrappers, the system-browser opener plugin, and the event
Channel forward. `McpPoolCell` is pure tokio and ports verbatim.

## 1. Config schema & storage

`McpServerConfig` (config.rs:48-67) — all fields optional, unknown fields
round-trip via `#[serde(flatten)] extra`:

| field | type | notes |
|---|---|---|
| `type` | `stdio \| sse \| http` | lowercase serde; **no dedicated streamable variant** — `sse` is served by the same streamable-HTTP client (rmcp 3 dropped standalone SSE) |
| `command` | string | stdio |
| `args` | string[] | |
| `env` | map<string,string> | |
| `url` | string | sse/http |
| `headers` | map<string,string> | |
| `auth` | string | only value: `"oauth"` |

- **Transport inference** (config.rs:72-78): explicit `type` wins; else
  `command` → stdio, `url` → http, else stdio.
- **Validation** (config.rs:81-97) is exactly two rules: stdio needs `command`
  (`"stdio servers require \"command\""`); remote needs `url`
  (`"remote servers require \"url\""`). Invalid entries surface as **error
  rows, never dropped** (resolve_servers returns `(resolved, invalid)`).
- **User scope**: `config.json` top-level `mcpServers` (flat name→config map;
  stored untyped in `Config.mcp_servers`, unparseable entries skipped).
- **Project scope**: `<workspace_root>/.mcp.json`; read accepts flat **or**
  `{"mcpServers": …}` wrapper — **wrapper wins when both present**; always
  written **flat**.
- **Merge**: project wins on name collision.
- **Enabled/disabled** is *not* per-server: it is an allowlist of OFF servers at
  `config.json` → `extensions.disabled.mcp` (names not listed = enabled).
  Disabled servers still connect (visibility) but their tools never join a turn;
  `mcp_set_enabled(false)` additionally disconnects.
- **Secrets**: `<data_dir>/mcp-secrets.json`, flat name→value, **plain
  unencrypted JSON**, atomic writes.
- **No config schema version anywhere.** Legacy `mcp.json`/`extensions.json`
  were consolidated into `config.json` upstream; no migration code exists.

> ⚠️ **Upstream self-inconsistency to decide on:** the settings UI's scope-card
> hints and rpc comment still say user scope is `~/.tide/mcp.json` ("the file IS
> the map") — a stale artifact of the consolidation. Behavior (backend truth) is
> `config.json → mcpServers`. Pixel-fidelity says keep the displayed hint
> string; correctness says update it. Flag for Yogi.

## 2. Add/Edit

**Backend lifecycle** (commands/mcp.rs:426-479): validate first (errors joined
with `"; "` abort, nothing written) → persist (user: insert into
`cfg.mcp_servers` replace-by-name; project: read `.mcp.json` map, insert,
atomic rewrite) → fire-and-forget `tokio::spawn(connect_entry)` if a pool
exists → reply immediately; UI learns outcome from the status ping. `{{secret:…}}
placeholders are stored verbatim and resolved only at connect time.

- `mcp_retry` re-reads **fresh config from disk** (external edits picked up) and
  reloads the server — a manual retry is the **only** thing that resets the
  3-strike crash budget.
- `mcp_reinitialize` bumps the pool generation and rebuilds everything.
- Raw editor: `mcp_read_raw` / `mcp_write_raw` — write **replaces the whole map
  with no validation** (TS cast-through parity).

**Dialog UX** (server-dialog.tsx):

- Modal `max-w-lg`; title `Add MCP server` / `Edit {name}`; footer
  `Cancel` + `Check`-icon button labeled `Add`/`Save`, disabled unless the
  current state is saveable.
- **Create defaults to Form mode; Edit defaults to JSON mode.**
- **Scope selector**: two cards side by side — Global (`~/.tide/mcp.json` hint)
  and Workspace (`{root}/.mcp.json` hint); active card gets an orange inset
  ring + check circle. Default scope on create: `project` if a workspace root
  exists else `user`.
- **Mode toggle** Form/JSON with **bidirectional sync**: Form→JSON always
  serializes; JSON→Form **refuses** (stays in JSON, shows error) if the JSON
  isn't a valid server config. JSON validates live with a **250 ms debounce**;
  if a wrapped `{name:{…}}` is typed and Name is empty, the name auto-fills.
- **Form fields by transport**:
  - Identity: `Name` (placeholder `e.g. filesystem`, **disabled in edit mode**)
  - Transport segmented control: `stdio` / `SSE` / `HTTP`
  - stdio: `Command` (mono, `e.g. npx`); `Args` textarea
    (`-y\n@modelcontextprotocol/server-filesystem\n/Users/me`, "One argument
    per line."); `Environment` textarea (`API_KEY=...`, "KEY=value per line.",
    `#` comments skipped, split at first `=`)
  - remote: `URL` (placeholder differs: `…/sse` vs `…/mcp`); `Auth` segmented
    `None`/`OAuth`; `Headers (JSON)` textarea (object of string→string; invalid
    → silently omitted)
  - `formToConfig`: stdio requires Command; remote requires URL; `auth:'oauth'`
    written only when OAuth selected. **No OAuth button in the dialog** —
    choosing OAuth writes the flag; sign-in happens from the row (§4).
- **JSON mode**: line-number gutter + mono textarea; live validation line (red
  `AlertCircle` + parser message / green `Valid`); helper "Paste a server
  config — the name is auto-detected from the key."; collapsible **Examples**
  with five snippets (stdio with `{{secret:my_api_key}}`, HTTP+headers,
  HTTP type-inferred, stdio+env, OAuth linear `https://mcp.linear.app/sse`).
- **JSON grammar** (`tryParseConfig`, :717-788 — port exactly): empty →
  `'Empty config.'`; parse error → `Invalid JSON: {msg}`; non-object →
  `'Config must be a JSON object.'`; if none of the 7 config keys appear at top
  level, unwrap the first object-valued key as the name; type inference
  command→stdio / url→http else the long `Missing "type". …` error; args kept
  only if all strings; env/headers filtered to string→string; `auth` kept only
  if exactly `'oauth'`.
- **Save flow** (mcp.tsx:141-166): rename in edit mode = `mcpRemove(old)` then
  `mcpUpdate(new)` (bridge keys by name); toasts `Server updated` /
  `Server added` / `Save failed`; after save: refresh, then **one delayed
  second refresh after 500 ms** (server isn't in the pool yet).

## 3. Import

**Scanner** (scanner.rs:39-81) — `scan_external_mcp_servers($HOME, &existing)`,
sources in priority order:

1. `~/.claude.json` → `mcpServers` key — "Claude Code"
2. `~/.claude/settings.json` → `mcpServers` — "Claude Code"
3. `~/.codex/config.toml` → `[mcp_servers.NAME]` sections — "Codex"
4. `~/.config/opencode/opencode.json` → `mcp` — "OpenCode"
5. `~/.agents/mcp.json` → wrapper or flat — "Generic"

- Dedup **by name, first source wins**; output
  `{ servers: DetectedServer[{name, config, source, sourceFile}],
  alreadyImported: string[] }` (names already in Tide's user map).
- Normalizer (:299-351): copies type (unknown → infer), infers from
  command/url, **skips entries with neither**; copies args (strings only) and
  env (string values only). **Codex `httpHeaders` deliberately NOT imported**
  (no Tide mapping — user re-adds headers manually). The Codex TOML parser is a
  hand-rolled exact-subset parser (`[mcp_servers.X]`, `.env`, `.http_headers`,
  inline tables, string arrays).
- **`mcp_import` writes without re-validation** (scan output is pre-shaped);
  one batched write per scope; then background-connects each imported server;
  reply `{ok, imported: count, error}`. Name collisions overwrite silently.

**Import dialog UX** (import-dialog.tsx): modal `max-w-md`, title
`Import MCP`, description `Detected from Claude Code, Codex, OpenCode, and
other configs.`; scanning state → empty state → results grouped **by source**
with per-group select-all checkbox; **checkboxes default to NONE checked**
(explicit opt-in); already-imported rows dim to 40% with `(already in Tide)`
and a disabled checkbox; each row shows a type chip (`STDIO`/`HTTP`) and a mono
summary `command || url` plus up to 2 non-flag args; scope cards below results;
footer `{n} selected` + `Import {n}` → `Importing {n}…` (dialog cannot be
dismissed while importing); no per-item conflict UI.

## 4. Authentication

**OAuth remote servers** (`auth: "oauth"`): OAuth 2.0 authorization-code +
PKCE, RFC 8252 loopback redirect, all inside rmcp 3's auth stack
(`AuthorizationManager/Session`, DCR included).

1. `mcp_authenticate` → pool binds `127.0.0.1:0` (**ephemeral port**), redirect
   `http://127.0.0.1:{port}/callback`; builds the authorize URL
   (`with_client_name("Tide")`); opens it via the pluggable **system-browser
   opener**; returns `{ok, url}`.
2. Loopback server serves **exactly one `/callback` hit** then stops; success
   page: `<h2>Tide</h2><p>Connected — you can close this tab.</p>`.
   **Timeout 5 minutes** (`LOOPBACK_TIMEOUT`); token exchange guarded at 30s.
3. On callback: code exchange, credentials persisted, then auto-retry connect.
4. **Token storage**: inside `config.json` — user scope at top-level
   `mcpOAuth`, project scope at `workspaces[i].mcpOAuth` (matched by workspace
   id) — sections `{ tokens, clients, verifiers }` with values **plain
   base64(JSON), unencrypted**. PKCE verifier persists per server (CSRF-checked)
   so an interrupted flow survives restart. Legacy TS-encrypted blobs fail to
   decode and read as absent → server simply re-authenticates.
5. **Refresh**: automatic — `AuthClient` rides stored credentials on every
   request; no app-side refresh timer. A 401 challenge classifies (message
   match "authorization required"/"401"+"unauthorized") → status `needs_oauth`.
6. **Reauthorize** (`mcp_reauthorize`): clears all stored tokens for the server
   then runs a fresh flow. **Reauthenticate** (row action on connected OAuth
   servers): refresh affordance for silently-expired tokens.

**Static auth**: remote `headers` passed as custom headers (invalid pair →
connect error); stdio child env = **full inherited process env** + resolved
`config.env`.

**Secrets** (secrets.rs): `{{secret:name}}` placeholders in stdio **env and
args only** (not headers/url). At connect: any missing name gates the spawn →
status `needs_credentials`, error `Missing secrets: A, B`; in args, missing
placeholders are **kept in place** so arg count stays stable. API
`set/get/clear/has_secret`; the backend **never returns secret values** to the
UI — only `mcpHasSecret → {has}`.

## 5. Orchestration

**Pool owner** (`McpPoolCell`, agent/mcp.rs — pure tokio, ports verbatim):
keyed `{workspace_root, generation}`; workspace change → shutdown old pool,
build new (project servers are workspace-lifetime, user servers app-lifetime);
generation bump (`reinitialize`) forces rebuild; superseded builds are
discarded, never clobber. Boot is **spawn-and-return** in the background — a
slow stdio server never blocks turn acceptance (first turn may run without MCP
tools). Status transitions broadcast a ping; boot-time pings before any
subscriber are dropped.

**Connection constants** (pool.rs:39-44): stdio connect timeout **30s** (login
shell + npx downloads), remote **10s**; `MAX_RESTARTS = 3`, backoff
2s → 4s → 8s (cap 8s). **No health checks, no idle shutdown, no concurrency
limits, no per-tool-call timeout** (a hung tool hangs the turn).

**stdio spawn**: via **login shell** `$SHELL -l -c '<quoted cmd>'` (POSIX
quoting; Windows `cmd /c` + `CREATE_NO_WINDOW`), `kill_on_drop`, stderr drained
to a **last-non-empty-line 500-char tail** kept only for crash error text —
**no log streaming exists anywhere**.

**Crash recovery**: natural child exit while `Connected` → restart with
backoff; after 3 strikes → `error` (`"Server crashed 3× — check its
configuration."` + stderr tail). Counter persists across reconnects; only a
manual retry resets it. Intentional disconnect sets `Disconnected` **before**
killing so the watcher skips recovery.

**Tool bridging**: `list_tools` once at connect; per-tool
`McpToolHandle` with `spec().name = mcp__<server>__<tool>`,
description `"<server>: <desc>"`, `sanitize_input_schema` (strips
`$schema`/`$defs`/`$comment`, forces root `type: "object"`), `risk_tier() =
ReadOnly` unconditionally (never permission-wrapped). Handles hold a
`Weak<McpPool>` so a pool swap yields a clean "pool is no longer available"
failure. Results are text blocks joined with `\n` + `is_error`.

**Turn assembly** (commands/chat.rs:270-300): `ensure_started(config,
workspace_root)` → `core_tools()` + `pool.mcp_tools()` → **filter out tools of
disabled servers** by splitting the namespace → engine dispatches by name.

**Status model**: `connecting | connected | disconnected | needs_oauth |
needs_credentials | error` (UI keeps a legacy `needs_approval` that renders as
"Connecting…"; `mcp_approve` is a benign no-op — the approval gate was removed).

**Events**: exactly one kind — coalesced `{ kind: "statusChanged" }` ping; the
panel always responds by re-fetching the full list. No payload, no tool-list or
log events.

## 6. Settings page & rows (UI parity spec)

- Sidebar group "Extensions", item **MCP** after Agents/Skills; header title
  `MCP`, description `Connect external tools via MCP servers.`
- Header actions: outline **Reload** icon button (`Reload MCP servers`,
  spinner while reinitializing) + split primary button `[＋ Add][▾]` whose menu
  holds **Import** (disabled at 0, numeric badge when scan finds servers) and
  **Re-initialize all**.
- Cards in fixed order **Global → Built-in → This Workspace** (scope rendered
  only when non-empty); card header: uppercase scope label + mono hint
  (`~/.tide/mcp.json · available in all workspaces` /
  `Ships with Tide · toggle to enable` / `{root}/.mcp.json · only active in
  this project`) + count; rows divide-y; **pagination at >5 rows**
  (`Showing a–b of n` + ‹ page/total ›).
- Empty state: `No MCP yet` + body + outline `View MCP spec` button
  (modelcontextprotocol.io). No page-level loading/error state.
- **Flash-guard**: during reinitialize an empty list result never replaces a
  non-empty one.
- **Row anatomy**: 32px status LED tile (see table) + name + transport chip
  (stdio neutral / sse blue / http accent) + scope chip
  (`global`/`workspace`/`built-in`); second line status text + tool chip
  (connected only) opening a tools popover (mono list, `View available tools`).
  Hover actions by state: `needs_oauth` → Authenticate + Re-authorize;
  `error|needs_credentials` → Retry; connected OAuth → Reauthenticate;
  non-builtin → Edit + Remove (confirm popover: `Remove {name}?` /
  `Disconnects the server and deletes its config entry.`); far right an enabled
  Switch. Disabled rows dim; `!enabled` shows a Ban LED overriding everything.
  Built-ins can only be toggled.

| state | LED | inline text |
|---|---|---|
| connected | PlugZap, emerald | Connected |
| connecting | spinner | Connecting… |
| needs_oauth | ScanFace, amber | Sign in required |
| needs_credentials | KeyRound, amber | Missing API key |
| error | Unplug, red | `Failed: {error}` / Connection failed |
| disconnected | Unplug, red | Off |

- **Chat surface**: the composer's MCP tab is **deliberately removed** upstream
  ("managed in Settings → Extensions → MCP until runtime ships") — parity =
  absent here too. Transcript: MCP calls use the **generic expandable ToolPart**
  renderer (icon falls back to wrench; unknown names humanized), no bespoke
  renderer.
- **i18n**: upstream has none (hardcoded English). This fork translates via
  `locales/app.yml` — port strings 1:1 under `mcp.*` keys.

## 7. Port mapping to this fork

| upstream | here |
|---|---|
| `tide-mcp` crate | vendor as `crates/mcp` (same pattern as engine/tools/store); adapt two seams: `tide_tools::Tool` → `crates/tools::Tool` (the `mcp__` ReadOnly permission tier already exists at `crates/tools/src/permission/mod.rs:147`), `tide_store::Config` → `store::config::Config` (`mcp_servers` already at `crates/store/src/config.rs:33`) |
| `McpPoolCell` (app process) | **backend crate (daemon)** — pool must live where sessions live; key by project/workspace root + generation, mirroring `crate::rag`'s install pattern |
| 18 Tauri commands | protocol `Command` variants (+ wire types via `export_types`; **fix the `packages/client` → `packages/tide-client` path first**) + push event for `statusChanged` (fork has sequenced events) |
| OAuth per-project storage in `config.json workspaces[i]` | **seam difference**: fork projects live in app.db, not config.json — decide equivalent keying (flag for design) |
| browser opener plugin | `cx.open_url` from the client, or a daemon-side opener; the pool's pluggable opener makes either fit |
| `mcp.tsx`/dialogs | `src/app/mcp_settings.rs` GPUI page following the fresh `rag_settings.rs` panel + poll pattern; hover actions need keyboard-reachable equivalents (AGENTS.md a11y) |
| turn assembly in `chat.rs` | `driver/tide.rs` tool build site (~:1088-1100), plus `ensure_started` at session start keyed by cwd/project |

## 8. 1:1 fidelity checklist (gotchas that must survive the port)

1. Project `.mcp.json`: wrapper-wins on read, always written flat.
2. Import skips validation and skips Codex `http_headers`; dedup first-source-wins.
3. Enabled is an allowlist (`extensions.disabled.mcp`); disabled servers still
   connect but their tools never join a turn.
4. OAuth tokens/secrets unencrypted (base64/plain JSON); undecodable legacy
   values read as absent.
5. Status flips to Disconnected **before** kill on intentional disconnect.
6. Manual retry is the only reset of the 3-strike crash budget.
7. No per-tool-call timeout (upstream accepts the hang).
8. `{{secret:…}}` resolves in stdio env/args only; missing → `needs_credentials`.
9. Rename = remove-then-update; save triggers refresh + 500 ms late second refresh.
10. Single coalesced status ping; panel re-fetches everything.
11. Statuses are the 6-value backend set; UI's legacy `needs_approval` renders
    as "Connecting…"; `approve` is a no-op kept for wire parity.
