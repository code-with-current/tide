# Tide Git Settings — Implementation Plan

Design: [2026-08-31-tide-git-settings-design.md](2026-08-31-tide-git-settings-design.md)

Phases land independently buildable; `cargo test -p waku-core -p waku-protocol`
plus the app build gate each phase. The dev watcher (`bun ./scripts/dev.ts`)
rebuilds and relaunches `Waku Debug.app` — validate visible changes there.

## Phase 1 — Service layer (`crates/waku-core/src/git_identities.rs`)

Port of `tide/src-tauri/src/commands/git_identities.rs`, minus Tauri.

1. Wire types (camelCase serde): `GitGlobalIdentity`, `GitProjectStatus`
   (`workspace_id` → `project_id`, plus `name`, `path`, `is_repo`,
   `has_override`, `identity_name/email`, `profile_id`),
   `GitDiscoveredCredential`, `GitOpResult`, `GithubDeviceStart`,
   `GithubConnectPoll`, `GhCliStatus`.
2. `LOCAL_IDENTITY_KEYS`, `apply_profile_config`, `clear_profile_config`,
   `local_config` — verbatim from Tide (git2 local-level set/unset).
3. `credential_approve` spawn (macOS path only matters; drop the Windows
   creation-flags block or keep behind cfg — Waku is macOS-first, see
   `docs/windows.md` before keeping).
4. Secret helpers against tide config.json: `stored_secret`,
   `store_secret`, `remove_secret` (read/load via `tide_store::config`,
   encrypt via `tide_store::secrets`).
5. Statuses: `project_statuses(projects: &[Project])` — same resolution as
   Tide's `workspace_statuses`, projects passed in; global config opened once.
   `global_identity()`, `current_identity` not needed (no Git panel) — skip.
6. `parse_git_credentials` + discovery of `~/.git-credentials`.
7. Device flow: `parse_device_start` / `parse_token_reply` /
   `parse_github_user` / `persist_github_account` (encrypt seam kept for
   tests) + HTTP halves on reqwest blocking. Client ID const +
   `TIDE_GITHUB_CLIENT_ID` override; scope `repo read:user`.
8. gh CLI: `parse_gh_auth_status`, `gh_cli_status()`,
   `connect_from_gh_cli()`.
9. Snapshot assembler: profiles + accounts + gh status + project statuses +
   attribution (`EffectiveGeneralSettings::commit_attribution`) + global
   identity.
10. Tests: port every upstream test (apply/clear, signing, statuses override
    detection, credentials parse, gh parse, device-flow parse, persist with
    injected encrypt).

## Phase 2 — Protocol + daemon arms

1. `waku-protocol/src/protocol.rs`: `Command` variants —
   `GitSnapshot { projects: Vec<Project> }` (client supplies its project list;
   the daemon owns app.db but the UI already holds projects — final call at
   implementation: prefer daemon-side read from persistence if cheaper),
   `GitIdentitySave { profile, token: Option<String> }`,
   `GitIdentityDelete { id }`, `GitSetIdentity { project_path, profile_id }`
   (path-keyed; project ids are UI-local),
   `GitClearLocalIdentity { project_path }`,
   `GitUpdateAttribution { key, value }`,
   `GithubConnectStart`, `GithubConnectPoll { device_code }`,
   `GithubConnectFromGhCli { login }`, `GithubDisconnect { login }`,
   `GitDiscoverCredentials`.
2. `ResponsePayload`: `GitSnapshot { snapshot: GitSnapshotWire }`,
   `GitOpResult { ok, error }`, `GithubDeviceStart { .. }`,
   `GithubConnectPoll { status, login, avatar_url, error }`,
   `GitCredentials { items }`.
3. Daemon arms in `crates/waku-core/src/daemon.rs` — each delegates to phase
   1; mutating arms return a fresh snapshot where the UI needs one.
   Attribution update = read-modify-write `general_settings` on tide
   config.json (matching the TS per-key merge).

## Phase 3 — Commit-path attribution

1. Hoist the attribution read (currently `tide_attribution` inside
   `tide-tools/src/tools/git.rs`) into a shared spot —
   `tide_store::config` helper or `waku-core` calling tide-store directly —
   so agent tool and panel path share one implementation.
2. `git_commit::commit`: before spawning, resolve attribution; Co-author →
   `append_trailer_once` on the message; Author → trailer carries the user's
   resolved identity (repo-local or global config read via git2) and the spawn
   gains `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` env overrides.
3. Tests: seed repo + config per mode; assert author/committer/message;
   attribution-off leaves the message untouched; config read failure → plain
   commit.

## Phase 4 — UI (`src/app/git_settings.rs` + settings wiring)

1. `GitSettingsPanel` state: `loaded`, `snapshot`, `saving_key`,
   device-flow state enum, profile-dialog draft (`ProfileDraft` ported from
   git.tsx), import list, gh-connecting login, error strings. Ops-event enum +
   channel following `TideProviderPanel`/`TideOpsEvent`.
2. Dispatch helpers in `runtime.rs` (`git_dispatch`, `git_load_snapshot`,
   dialog open/save/clear actions) using the spawned-thread pattern.
3. `SettingsPage::Git` variant + sidebar entry + titlebar title +
   `render_git_settings` in `src/app/settings.rs`; page-switch triggers the
   snapshot load.
4. Render the four card groups (GitHub / Identities / Attribution /
   Workspaces) per the design; identity picker as a popover menu on each
   project row; device-flow popover with countdown; profile dialog with
   validation; confirm popovers for disconnect/delete.
5. Styling per existing settings cards (theme tokens, row borders, badges);
   reduce-motion respected (no web animations ported — use the app's standard
   transitions only).
6. Keyboard: tab focus + focus_visible on every control; enter/escape in
   dialogs; picker arrows; hover-revealed actions also focus-reachable.
7. Locales: new keys under `git.*` in `locales/` (en first, then existing
   languages).

## Phase 5 — Validation

1. `cargo test -p waku-protocol -p waku-core`.
2. `cargo clippy` over touched crates.
3. In the freshly relaunched debug app: create a manual identity, apply it to
   a scratch repo project, verify `git config --local user.email`; clear
   override; toggle attribution modes and commit from the commit dialog —
   inspect author/committer/trailer; agent `git commit` parity; device flow
   against a real browser auth; gh CLI connect if available.
4. Both themes legibility pass; keyboard-only pass over the whole page.

## Risks / notes

- `resolve_git_cwd` (Tide resolves workspace → git root) is not needed: waku
  project paths are the workspace root; `Repository::open` + discover parity
  is enough. Apply targets the project root's discovered repo like the agent
  tool does (`Repository::discover`).
- The `git add`-style blanket refusals live in the agent tool; identity apply
  writes config only, no staging surface here.
- Waku's Windows/Linux builds (`docs/linux.md`, `docs/windows.md`): the gh/git
  spawns are POSIX-shaped; keep Tide's cfg pattern or defer.
