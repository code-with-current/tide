# Changelog

All notable changes to Tide. This file is the **source of truth for the release
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

## [Unreleased]

## [0.1.1-beta]

### Fixed

- The loading indicator no longer freezes mid-animation. The pixel loader in
  the working footer (and the elapsed timer next to it) stopped animating
  whenever the app went quiet between tool runs; it now stays animated — and
  the timer keeps counting — for as long as the turn is running.

## [0.1.0-beta]

- Slash commands and skills resolve in one call: invoking `/name` through the
  slash_command tool now checks the workspace's enabled skill catalog when no
  command file matches — including multi-word skill names like
  `/AgentDB Advanced Features`, with trailing words kept as arguments — and
  returns the skill body directly in load_skill's shape. The model no longer
  has to discover a skill's path and re-invoke load_skill after an
  "Unknown command" miss; that error now appears only when the name matches
  neither a command nor an enabled skill.
- Memory recalls now cite their sources and resist injection: the memory tool's
  prompt contract tells the model that hit content is reference material, never
  instructions, and that citations use the hit's `docId` when present
  (knowledge library) or `path:startLine-endLine` otherwise. `/init` writes
  its guidance under a managed marker block, so re-running it replaces only
  its own section instead of clobbering hand edits around it.
- Memory hits carry exact provenance: every hit now includes `endLine` and,
  for indexed prose, the heading it sits under and `docId`, so citations point
  at precise line ranges instead of open-ended snippets. The prose splitter
  is heading-aware (respects fenced code blocks, CommonMark ATX heading edges,
  and produces non-overlapping chunks), and the memory tool gained an
  `aggregate` parameter (`content`, `doc`, or `source`) that groups hits —
  coverage-weighted — when a whole document or source matters more than
  five separate fragments.
- Knowledge Library: a new library source kind stores curated documents under
  `<data>/library` with stable per-document ids that survive renames (deletes
  leave a tombstone), and reindexing is registry-synced so a rename or removal
  no longer desyncs the index — this also fixes reindex purging the very
  chunks it had just written (a regression introduced with the
  generalized-embedder reindex path). The agent's file tools (read_file, write_file,
  edit_file) treat the library as a read+write annex — absolute paths into it
  are allowed, symlink-verified, and confined to the library root. Four slash
  commands ship with an idempotent installer: `/kb-context` (pull library docs
  into the turn), `/kb-search`, `/kb-capture` (save something to the library),
  and `/kb-iterate` — built in and always available, no install step; a file in the
  commands folder overrides a built-in, and the Settings card's copy button materializes
  editable versions. A Knowledge Library card on the Settings page exposes
  reveal, re-index, and that copy action.
