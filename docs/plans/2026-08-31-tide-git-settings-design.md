# Tide Git Settings — Waku Port Design

Date: 2026-08-31
Source: `tide/src/components/screens/settings/git.tsx` + `tide/src-tauri/src/commands/git_identities.rs` (upstream checkout at `/Volumes/512gb/TestAi/tide`)

## Goal

Port Tide's Git settings screen to Waku: GitHub accounts (device-flow OAuth + gh
CLI), commit identity profiles applied per project as repo-local git config,
commit attribution settings, and per-project identity status. Extend the
attribution contract to Waku's own panel commits so one setting governs every
commit the app makes.

## Decisions

1. **Full port** — GitHub accounts, identities, attribution, workspaces.
2. **Apply lives in the settings rows** — each waku project row gets an
   identity picker (Global + profiles). Waku has no Git panel, so Tide's
   apply-from-panel surface is folded into the Workspaces section.
3. **Panel commits are attributed too** — `git_commit::commit` honors the same
   `GeneralSettings` the agent git tool reads (agent commits already do).
4. **Workspaces = waku projects** — rows come from `app.db` via persistence,
   not tide config.json workspaces.
5. **GitHub OAuth client ID** — Tide's `Ov23lionvm4H63OP4D` with the
   `TIDE_GITHUB_CLIENT_ID` env override (consistent with vendoring).

## What already exists in Waku

- `tide-store`: `git_identities.rs` (profile CRUD, validation, ssh quoting,
  GitHub account cards), `config.rs` (attribution settings +
  `CommitAttribution`/`append_trailer_once`), `secrets.rs` (kcv2 encryption).
- `tide-tools/src/tools/git.rs`: agent git tool already applies attribution.
- Precedent pattern: Tide providers screen (`src/app/tide_providers.rs`,
  `settings.rs::render_tide_settings`, `runtime.rs::tide_dispatch`,
  `daemon.rs` command arms, `waku-protocol` Command/ResponsePayload).
- waku-core has reqwest (blocking) and git2.

## Architecture

Three layers, mirroring the Tide providers flow:

1. **Service layer** — `crates/waku-core/src/git_identities.rs`, a port of
   Tide's `commands/git_identities.rs` (see below). Daemon-owned; every entry
   point does process/fs/network I/O and runs only on background threads.
2. **Protocol** — new `Command`/`ResponsePayload` variants in
   `waku-protocol/src/protocol.rs`; daemon arms in `daemon.rs` delegate to the
   service. A coarse `GitSnapshot` (profiles, accounts, gh status, project
   statuses, attribution, global identity) refreshes the screen after any
   mutation — one round-trip, no per-row probes.
3. **UI** — `SettingsPage::Git` sidebar entry; state in a new
   `src/app/git_settings.rs` `GitSettingsPanel`; loads via the
   `tide_dispatch`-style spawned thread → daemon request → event over the ops
   channel → event pump; render reads only stored state.

## Service layer details

- **Apply/clear** — git2 `ConfigLevel::Local` writes to the five owned keys
  (`user.name`, `user.email`, `core.sshCommand`, `commit.gpgsign`,
  `user.signingkey`); `profile_id == "global"` clears. Reuse
  `tide_store::git_identities::{validate_identity_fields, escape_ssh_key_path}`.
- **Project statuses** — local config → global fallback → profile match on
  `(user_name, user_email)`; the default config chain opens once. Row source is
  waku's projects (id, name, path) passed in by the daemon.
- **Token apply** — best-effort `git credential approve` spawn
  (`credential.interactive=false`, `GIT_TERMINAL_PROMPT=0`);
  github-sourced profiles read `github:<login>`, manual token profiles read
  `gitIdentityToken:<id>` from encrypted secrets.
- **Device flow** — pure parse halves (`parse_device_start`,
  `parse_token_reply`, `parse_github_user`) ported verbatim with tests; HTTP
  via waku-core's blocking reqwest client. Scope `repo read:user`.
- **gh CLI** — `parse_gh_auth_status` ported verbatim; one-click connect via
  `gh auth token --hostname github.com --user <login>`, validated against
  `api.github.com/user`, persisted like a device-flow success.
- **CRUD + secrets** — profiles via `tide_store::git_identities`; tokens via
  `secrets::encrypt_stored` into config.json's secrets map. Deleting a profile
  removes its secret but never purges OS-helper credentials.

## UI design

Card groups matching Tide's screen:

1. **GitHub** — connected accounts (avatar, login, accountId, Disconnect with
   confirm), gh-CLI-detected accounts with Connect, "Add via browser…"
   device-flow popover (steps, copyable user code, expiry countdown,
   denied/expired/error + Retry).
2. **Identities** — Global row (read-only), profile rows (color dot, name,
   signed/GitHub/token badges, `name <email>`), hover edit/delete, New +
   Import from `~/.git-credentials`, and the profile dialog: manual/github
   source segment, SSH/token auth segment, display name / user name / email,
   ssh key path or host+token, commit-signing disclosure, color/icon pickers,
   inline validation.
3. **Attribution** — "Attribute commits" switch; when on, Author/Co-Author
   segmented control with mode-dependent description; optimistic save + Saved
   indicator.
4. **Workspaces** — waku project rows: not-a-repo / override / global badge,
   resolved identity line, identity picker (Global + profiles), Clear override.

Keyboard operability for every hover affordance; `tr!()` with new locale keys
(en + existing locales).

## Commit attribution on the panel path

`git_commit::commit` reads the attribution decision before spawning
`git commit` (shared helper hoisted from the agent tool so the two can never
disagree), then: Co-author mode → repo identity authors, trailer appended via
`append_trailer_once`; Author mode → `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` env
overrides make Tide the author, the user's resolved identity trails. Applied
repo-local identity config is picked up automatically by the CLI commit.

## Error handling

- Identity ops return `{ok, error}` wires — never fail the daemon request.
- Config read failure → no attribution (same as Tide's panel read failure).
- Device flow surfaces phase-specific states; profile validation shows inline
  dialog errors; corrupt `git-identities.json` recovers empty (already in
  tide-store).

## Testing

- Port upstream unit tests: apply/clear local-only, signing on/off, status
  resolution + override detection, credentials parser (dedupe, drop tokens),
  gh parser (single/multi/logged-out/invalid), device-flow parse (every reply
  kind), encrypted persistence.
- New: panel-commit attribution round-trip per mode (author/committer/trailer);
  `GitSnapshot` round-trip; picker apply against a temp repo.
