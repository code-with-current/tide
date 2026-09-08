# Changelog

All notable changes to Waku. This file is the **source of truth for the release
notes shown in the in-app updater**: [`scripts/release.ts`](scripts/release.ts)
extracts the section whose heading matches the version being released
(`MARKETING_VERSION`) and publishes it next to the update, so Sparkle shows it in
the update prompt.

Format follows [Keep a Changelog](https://keepachangelog.com). Add a new
`## [<version>]` section at the top for each release, matching the version you
set in the Xcode project.

Write release notes for the final product users receive, not the development
history. When a feature is still unreleased, fold its fixes and refinements into
the original feature bullet instead of adding separate entries for them.

## [0.2.1]

- Projects get their own settings page (Settings → Projects): a searchable
  rail with project avatars opens a detail panel per project, with the name
  and path (missing-directory warning included), an icon — automatic from
  the repo, one of ten presets, or an upload on a background color you
  pick — a default model for new chats, the Memory & RAG toggle, a
  repo-local git identity (moved off the Git page), and an actions editor.
  Removing a project can optionally delete its session history. Avatars
  render across the sidebar, session rows, and the empty-state project
  menu.
- Project actions now run as real background jobs instead of blocking the
  turn: each run gets its own process group, file-backed logs
  (`~/.tide/action-logs`), and a persisted run record. A run still in
  flight when the app quits is re-adopted on restart and keeps streaming;
  stop sends SIGINT with SIGKILL escalation; a detected `:port` becomes a
  clickable pill that opens the URL. The jobs pill and popover fill in
  before any message is sent, and Play is a no-op while a run is live.
  Runs start in the session's workspace, not just the project root.
- Links are clickable everywhere text renders — transcripts, tool output,
  and the quoted descriptions on tool cards.
- The accent color is now Material Blue, with inline-code tokens retuned
  to match.
- The Knowledge page gains a scope selector (Global vs Project) and a
  file browser for local doc sources; dialog placeholders are translated.
- The Git panel no longer shows the previous project's data after
  switching sessions or workspaces.
- Long user messages that clamp now end in an explicit ellipsis at the
  cut, and the expand chevron sits in the footer row — visible without
  hovering — so clamping no longer reads as text silently ending.
- Changed files in the Git panel now have a right-click menu: discard moved
  off the row's hover icon into it, alongside Stage/Unstage, Copy Path, Copy
  Relative Path, Add to .gitignore, Open Diff, and View File. The menu's
  Add to .gitignore appends the path to the workspace's .gitignore
  (creating it if absent) without leaving duplicates.
- The new-session screen is now a single centered composition: the greeting,
  the chat composer, and the git workspace chips — project, Local vs new
  worktree, and the base-branch picker — sit together in the middle of the
  screen instead of the composer being pinned to the window's bottom edge.
  The branch picker itself now carries a "Work in a new worktree" toggle
  with a checkmark state, keyboard-navigable like the branch rows, so a
  worktree and its base branch are chosen in one place.
- The Git panel's new Worktrees tab lists every working tree linked to the
  repository — main first — with each tree's branch, uncommitted-changes
  state, and the task using it, plus a two-step removal that also deletes
  the task's `tide/*` branch. Refuses the main working tree and non-Tide
  branches, and requires the deliberate confirm to override a dirty or
  locked tree, so finished tasks' workspaces can be reclaimed safely.
- Sub-agent runs survive an app restart. The agents panel rebuilds each
  session's run history from the store when the session is opened, including
  the timeline, task, and report the detail panel renders, and a run that was
  still in flight at quit shows as lost instead of running forever.
- `todo_write` updates no longer fail outright when the agent marks more than
  one item in progress. The list is accepted with the extra in-progress items
  demoted to pending (and a note telling the agent why), so a malformed update
  no longer discards every status change in the call.
- Tide can no longer end up with more than one window. The single-instance
  lock is now kernel-arbitrated instead of a pid-file check two launches could
  both win, a second launch activates the running app and quits, and clicking
  the Dock icon while the app runs without a window opens its window again
  instead of leaving it unreachable. The dev watcher also waits out a killed
  predecessor and no longer forces a second instance with `open -n`, which is
  what stacked windows during rebuild cycles.

## [0.2.0]

Renamed **Waku → Tide**. This is the same app under a new name and brand:
`tide.codes`, bundle id `codes.tide`, and workspace crates renamed to bare
functional names (`tide`, `protocol`, `client`, `backend`, plus the vendored
`engine`/`store`/`tools`). The license stays GPL-3.0-only; Tide is a fork of
[Waku](https://github.com/egoist/waku) by EGOIST and contributors.

- Existing data moves automatically on first launch: sessions, blobs, settings,
  and caches come over from the Waku directories, and `~/.waku` becomes
  `~/.tide`. Old transcripts, `waku-blob:` attachments, and git checkpoints
  (`refs/waku/*`, `Waku-Turn-Start` trailers) keep working through legacy reads.
- Environment variables are now `TIDE_*`; `WAKU_DAEMON_ADDRESS`,
  `WAKU_DAEMON_TOKEN`, `WAKU_NO_SINGLETON`, and `WAKU_DISABLE_ANALYTICS` are
  still honored for tooling written before the rename.
- Auto-update now tracks `releases.tide.codes` with a new signing key — a fresh
  update line. Existing Waku installs do not roll forward to Tide; install Tide
  alongside or instead.
- The Tide provider configuration previously stored under the standalone tide
  CLI's `~/.tide` is superseded when the migration moves in; re-add provider
  accounts and git identities in the app.
- One-time actions after upgrading: grant Accessibility and Screen Recording to
  the renamed "Tide Computer Use" helper (macOS treats the new name as a new
  app), and custom keymaps referencing the `Waku` key context need `Tide`.

## [0.1.15]

- Codex thread goals: type /goal to set a persistent objective the task keeps pursuing — before or after the first message — with its autonomous pursuit streaming into the transcript, a status chip showing live budget or elapsed time, and a dialog to edit, pause, resume, or clear the goal (also in Waku Web)
- Discover provider-native slash commands and skills from installed agent CLIs, including multiline YAML descriptions
- Add reasoning effort selection for Grok
- Reconnect remote daemon sessions automatically after connection interruptions
- Fix Command/Ctrl+Enter steering after a provider response starts streaming
- Fix transcript file links on Windows
- Fix OpenCode dropping the first streamed event and hanging during cancellation on Windows

## [0.1.14]

- Group sidebar tasks by project or update date, order them newest or oldest first, and collapse sections
- Find in page: Search the full transcript by keywords using cmd-f or ctrl-f
- Switch between recent tasks with Ctrl+Tab and Ctrl+Shift+Tab
- Carry the current access mode into new tasks and remember it between launches
- Fix OpenCode access-mode permissions and restore pending permission prompts when resuming sessions
- Show Codex file reads, listings, and searches as file activity instead of raw commands
- Keep long panel and background-work titles on one truncated line
- Increase the minimum UI text size for better legibility

## [0.1.13]

- Add Vercel Fx support
- Support DeepSeek Harness 0.1.1 without opening its web UI
- Collapse earlier activity groups when a running turn moves on to newer transcript output

## [0.1.12]

- Invoke Codex, Pi, and Oh My Pi skills with their native syntax
- Stream live output from Claude background tasks
- Steer the oldest queued follow-up with Command/Ctrl+Enter in an empty composer
- Fix model and reasoning option selection for Cursor
- Fix npm-installed provider detection on Windows
- Fix daemon terminal sessions hanging during shutdown
- Exclude copied history from forked Codex sessions from usage totals
- Keep separate Codex reasoning sections on separate lines

## [0.1.11]

- Highlight Markdown in the file editor, and toggle between source and a rendered preview
- Add UI and code font size settings
- macOS: Add "Open in.." button to open project folder in selected application

## [0.1.10]
- Add Kimi Code support
- Add Oh My Pi support
- Fix markdown table rendering

## [0.1.8]

- Fix `PATH` resolution on Windows

## [0.1.4]

- Fix text selection in diff view

## [0.1.3]

- Pin Codex and Claude commit message generation to cheap models: gpt-5.6-luna and claude-4.5-haiku
- Animate sidebars
- Render provider file edits as inline diffs in the transcript
- Fix claude task title generation

## [0.1.2]

- Fix regression: user bubble should fit its content width

## [0.1.1]

- Give nested Markdown the full message width
- Cap composer height and scroll overflow with an overlay scrollbar
- Keep drag-selecting text past the input bounds
- Fix char boundary panic when sliding the live reasoning window

## [0.1.0]

- Add standalone Waku daemon and browser client
- Add Linux support (X11 and Wayland, you need to build from source for now)
- Answer agent questions directly in the composer
- Redesign queued follow-ups as composer cards with per-message steering
- Add DeepSeek agent preset selection (Standard, Code, Minimal, and Creator)
- Add Claude context window and ultracode effort options
- Add /fast command to toggle fast mode for Codex
- Show the latest activity in live transcript headers
- Add soft wrapping and keyboard copy feedback
- Add terminal overlay scrollbar and measure cell width from the font
- Restore window position, size, and display across launches
- Contain wheel scrolling in activity and command output viewports
- Smooth streaming markdown and reduce CPU usage while streaming

## [0.0.13]

- Add DeepSeek Harness provider
- Render user message as Markdown and linkify bare URLs
- Share one resident OpenCode serve per workspace across sessions

## [0.0.12]

- Inherit the login-shell environment for provider commands
- Fix model traits across provider switches
- Keep branch change counts current and include untracked files
- Normalize SIGCHLD for provider children
- Fix Grok model discovery

## [0.0.11]

- Fix provider detection for CLIs installed through shell PATH managers such as
  nvm and fnm
- Show models registered by Pi extensions
- Fix the model picker closing when entering a space in search
- Fix duplicate transcript history and lost interaction mode when resuming ACP
  sessions

## [0.0.10]

- Fix crash in due to IME composition
- Fix typo

## [0.0.9]

- Add OpenCode Go support in usage popover
- Fix app icon
- Fix Cursor model detection

## [0.0.8]

- Initial release
