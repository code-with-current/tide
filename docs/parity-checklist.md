# Tide Parity Checklist — release gate for the Tauri rewrite (v0.4.0-beta)

Every row below must be checked off by **dogfooding the behavior in the rewritten app**, not by code presence. A row counts only when the behavior was exercised end-to-end in the Tauri build. Reference material: the TS backend under `app/` (removed after export) and the frozen fixtures in `src-tauri/crates/tide-engine/fixtures/` (`schemas/tools.json`, `schemas/mcp-config.json`, `schemas/sse/`).


<!-- M3 code-complete 2026-08-27 (feat/tauri-rewrite through 1358f31): all 26 tools implemented +
MCP pool (rmcp) + subagents + auto-compact + followup/exit-plan. Rows below remain UNTICKED until
dogfooded per the gate rule; this note records implementation coverage only. -->

<!-- M5 code-complete 2026-08-28: updater dual-channel + consent flow live, autostart parity,
perf gates in CI (500-msg), winget/homebrew rewired + secrets-gated. Rows remain UNTICKED until
dogfooded; the v0.4.0-beta tag is the gate. -->
## Tools

All 26 registered tools (see `fixtures/schemas/tools.json` for name/description/JSON Schema, both legacy wire format and live zod-converted SDK schema):

- [ ] `read_file` — sandboxed read, 2000-line / 256KB caps, skill-root exception
- [ ] `list_dir` — workspace directory listing
- [ ] `directory_tree` — recursive tree
- [ ] `read_media_file` — image/media read for vision models
- [ ] `glob` — file pattern search
- [ ] `grep` — content search (ripgrep-style behavior)
- [ ] `edit_file` — targeted string-replacement edit
- [ ] `multi_edit` — batched edits in one call
- [ ] `write_file` — full file write
- [ ] `notebook_edit` — Jupyter notebook cell edits
- [ ] `bash` — shell in workspace root, pipes/chaining, 50KB/1000-line output cap, `background:true` spawn
- [ ] `bash_output` — poll background shell output by `shell_id`
- [ ] `kill_shell` — stop background shell
- [ ] `git` — git operations from chat
- [ ] `git_repo` — repo-level inspection
- [ ] `web_fetch` — URL fetch
- [ ] `web_search` — web search
- [ ] `dispatch_agent` — subagent dispatch (see Agent runtime)
- [ ] `todo_write` — session todo list mutation
- [ ] `ask_followup_question` — structured user question
- [ ] `exit_plan_mode` — plan approval gate
- [ ] `compact` — manual context compaction
- [ ] `slash_command` — slash-command execution
- [ ] `memory` — persistent memory read/write
- [ ] `init` — project init/bootstrap
- [ ] `load_skill` — skill loading via SKILL.md (`builtin:` ids, budgeted catalog in description; SDK-path-only tool)

Tool-system mechanics:

- [ ] Tool name aliases resolve (e.g. `local_shell_call`→`bash`, `mcp__tide-filesystem__*`→native tools; full map in `app/core/agent/tools/registry.ts` `TOOL_ALIASES`)
- [ ] Risk tiers + `autoApproveIn` per autonomy mode (plan/ask/edit/full) behave per tool
- [ ] Per-tool timeouts fire (`timeoutMs`)
- [ ] `requiresWorktree` tools refuse outside worktree sessions
- [ ] Permission gate: read_only auto-approves; edit-tier asks; escalation plan→edit mid-turn updates mode
- [ ] Parallel tool execution with isolated per-call contexts
- [ ] PreToolUse/PostToolUse hooks fire when configured (`.agent` settings)

## Agent runtime

- [ ] Streaming: text/thinking/tool events; z.ai thinking stripped; reasoning budget carved WITHIN max_tokens (never stacked); tool output floor clamp (16384)
- [ ] Retry UX: 10s abortable delay between attempts; error UI shows ONLY at exhaustion; isStreaming never flickers between retries
- [ ] Message queue: auto-drain + send-now override
- [ ] Subagent dispatch: parallel dispatch, permission inheritance, child events mirrored into parent stream, catalog of 5 tool-enabled agents
- [ ] Auto-compact / context summarization
- [ ] Orchestrator turn loop: LLM call → tools → repeat, with abort mid-turn
- [ ] Thinking levels (off/minimal/low/medium/high/extra/max) reach providers correctly per protocol
- [ ] Autonomy modes (ask/plan/edit/full) enforce their tool gates
- [ ] Usage accounting folds tool + subagent usage into the parent turn totals
- [ ] Agent prompt set loads from `src/lib/prompts/agents/` (9 definitions; catalog surfaces the tool-enabled subset)
- [ ] Skills: workspace + user scan, enable/disable, catalog budgeting (full lines → name+path → omission count)
- [ ] Slash commands resolve and run (project + user)
- [ ] Ask-followup question cards round-trip (ask → user answer → model continues)
- [ ] Exit-plan-mode approval flow (plan presented → approved → edit tier unlocked)

## Storage

- [ ] Sessions: v2 store, parts durable, event pruning at turn.end, perf at 500 messages
- [ ] Legacy session list/window queries meet the perf gate (`node scripts/perf-gate-v2.mjs` equivalents in Rust)
- [ ] `~/.tide/config.json` shape matches `fixtures/schemas/mcp-config.json`: providers (encrypted keys), workspaces (branch/headCommit/scripts/ragConfig/mcpOAuth/archivedAt), secrets, generalSettings, ragEnabledWorkspaces, mcpServers, extensions, agentSettings, lastSessionId/lastWorkspaceId
- [ ] API keys stored encrypted / via OS keychain — never plaintext at rest
- [ ] Session archive/unarchive, rename, AI title generation, fork, worktree create/remove
- [ ] Usage DB tracks per-window/per-provider usage reports
- [ ] Model catalog + prices (model-prices.json refresh flow, inline per-model price fields)
- [ ] `sessions.legacy/` rename-on-first-launch compatibility path

## MCP

- [ ] MCP server pool lifecycle: add/update/remove, enable/disable, statuses surfaced live (`mcpEvents`)
- [ ] MCP config import (scan + import from existing tool configs, `mcpScan`/`mcpImport`/`mcpReadRaw`/`mcpWriteRaw`)
- [ ] MCP OAuth loopback flow + reauthenticate button; workspace-scoped creds
- [ ] Per-server secrets: set/has/clear (`mcpSetSecret`/`mcpHasSecret`/`mcpClearSecret`), reauthorize (`mcpReauthorize`)
- [ ] Tool approvals for MCP tools (`mcpApprove`) and retry (`mcpRetry`)
- [ ] Workspace activation re-initializes servers (`mcpWorkspaceActivated`)
- [ ] `mcpOAuth` config subtree (clients/verifiers/tokens by server name) round-trips

## UI surfaces

- [ ] Composer: long-paste → virtual attachments; arrow-key prompt history
- [ ] Composer attachments picker, @mentions, project file picker, slash picker
- [ ] Model selector + thinking-level selector + permission-mode selector in composer
- [ ] Queued messages UI (queue list, send-now affordance)
- [ ] Per-file undo via git sha capture; side-by-side diff viewer full-file context
- [ ] Mermaid live preview (streaming, throttled)
- [ ] Reasoning view modes (flat/phased thinking; compact/stream turn view); total-time timers
- [ ] Write/edit tool rows show live progress from partial input streaming
- [ ] Git panel: Changes/History tabs, stage all split-button, bulk stage/unstage/restore/stash/stash-pop, gitLog
- [ ] Commit graph + details panel, AI commit message actions, branch menu (checkout/create/delete/merge, ahead/behind, conflicts + resolve)
- [ ] Terminal tabs + PTY; file explorer refresh; file viewer with line numbers/ScrollTabs
- [ ] Settings: providers + API keys via keychain, model catalog + prices, appearance (theme swatches, sidebar mode pills)
- [ ] Settings: shortcuts editor (get/set/reset overrides), permissions rules, sources, extensions (agents/skills), updates, about
- [ ] Sidebar: workspaces + sessions navigation, port pills on sessions
- [ ] Knowledge sources / RAG ingest + search; port pills on sessions; workspace scripts setup|run
- [ ] RAG index progress UI + model download flow (embeddings runtime)
- [ ] Inspector column (session inspector tabs), agents tab, browser tab
- [ ] Chat timeline virtualization at 500 messages; streaming text throttle; auto-follow scroll
- [ ] Markdown rendering: syntax highlighting (worker), image galleries, security hardening
- [ ] Permission cards (inline + floating auto-accept), question cards
- [ ] Onboarding, splash, consent screen, missing-workspace screen, add-workspace dialog
- [ ] Todo floating panel + todos-updated events
- [ ] Usage ring in composer; usage windows/report views

## Infra

- [ ] Borderless chrome (mac traffic lights pl-84, win/linux controls), compact mode <1200px, resizable panels
- [ ] Updater: consent-driven, channels; MCP OAuth loopback + reauthenticate button; workspace-scoped creds
- [ ] Full RPC surface parity: 183 methods in `shared/rpc.ts` `TideRPC` (sessions v1+v2, chat, events, terminal, process, mcp, rag, sources, workspaces, dialogs, shell/window, settings, providers, model catalog, usage, git, scripts, agent/project/todos/extensions, updater) — every domain round-trips
- [ ] Push event channels: orchestratorEvents, agentEvents, updateStatus, terminalOutput/Exit/Ports, mcpEvents, ragProgress, sourcesProgress, workspaceProgress, gitChanged, todosUpdated, scriptOutput/Exit/Ports
- [ ] Keyboard shortcut registry (defaults + user overrides) wired app-wide
- [ ] Open-in-app handling (detect/open external links in-app)
- [ ] Native dialogs (pick directory/files), clipboard file save, external file/image read
- [ ] Env/diagnostics introspection endpoints; mac permission status (accessibility/fullDiskAccess/folders)
- [ ] Structured logging + log rotation; diagnosticsGet
- [ ] Local-first guarantee: only outbound LLM API calls leave the machine (no telemetry)
- [ ] Window controls: fullscreen, minimize, maximize/close
- [ ] Packaging: installers per platform + updater feed, ad-hoc mac signing
