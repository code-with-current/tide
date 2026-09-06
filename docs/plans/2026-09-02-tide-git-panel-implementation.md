# Tide Git Panel — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Waku's right-panel Diff (review) tab with a full port of Tide's Git panel — Changes, History, commit bar, identity bar, stash, conflicts, branch ops — per Task list below.

**Architecture:** Service module `crates/waku-core/src/git_panel.rs` (port of tide's `src-tauri/src/commands/git.rs`) behind new `WorkspaceOperation` variants; UI as `RightPanelSurface::Git` in `src/app/git_panel.rs` replacing the Diff surface, reusing `review_diff` rendering, `branches.rs` idioms, `dropdown_menu`, and the identity plumbing from the settings port.

**Upstream sources (read, don't recall):** `tide/src-tauri/src/commands/git.rs` (backend, ~2200 lines), `tide/src/components/right-panel/git/*` + `tide/src/components/git/branch-menu.tsx` (UI), `tide/src/lib/git/lanes.ts` (pure), `tide/shared/rpc.ts` git section ~L618-745 (wires).

**Design doc:** [2026-09-02-tide-git-panel-design.md](2026-09-02-tide-git-panel-design.md)

**Conventions:** dev watcher owns the app (no manual rebuild/relaunch); TDD per task; `cargo test -p <crate> <name>`; commits per task; test-only mode (no reviewer loops) per the session's standing instruction. **Staging discipline:** `src/app.rs`, `src/app/runtime.rs`, `src/app/right_panel.rs` may carry unrelated WIP — stage only task hunks (hash-object / filtered `git apply --cached` technique used throughout the settings port).

---

## Phase A — Wire types + protocol

### Task 1: Wire types (`waku-protocol/src/git_panel.rs`)

Create the module (registered next to `pub mod git;`), mirroring tide's rpc shapes (camelCase serde, TS derives, match the existing `git.rs`/`git_settings.rs` conventions):

- `PanelFileChange { path, status: String ("modified"|"added"|"deleted"|"untracked"|"renamed"), staged: bool, additions: u64, deletions: u64 }`
- `PanelCommit { sha, author, date (ISO string), subject, parents: Vec<String>, is_head: bool, branch_heads: Vec<String>, tags: Vec<String> }`
- `PanelStash { ref_: "stash@{n}" → field `stash_ref`, message }`
- `PanelConflict { path, state: String (seven `both-*`/`added-by-*`/`deleted-by-*` values) }`
- `PanelBranchInfo { branch: Option<String>, head_commit: Option<String> }`
- `PanelAheadBehind { ahead: u64, behind: u64 }`
- `PanelDiffHunk { header, lines: Vec<PanelDiffLine> }`, `PanelDiffLine { kind: String ("context"|"add"|"del"), old_no: Option<u32>, new_no: Option<u32>, text }` — note upstream prepends the origin char to `text`; keep that byte shape so the UI parses like tide's
- Op results: `PanelOpResult { ok, error }`, `PanelCommitResult { ok, sha: Option<String>, error }`, `PanelRevertResult { ok, new_sha: Option<String>, error }`, `PanelMergeResult { ok, conflicts: Vec<String>, error }`

Test: JSON round-trip asserting camelCase keys + a decorated commit parses. Commit: `feat(git): wire types for the git panel port`.

### Task 2: WorkspaceOperation variants

In `crates/waku-protocol/src/workspace.rs`, add to `WorkspaceOperation` (cwd-keyed like `Commit`/`InspectBranches`):

```
InspectGitStatus { cwd }                    → WorkspaceResult::GitStatus(Vec<PanelFileChange>)
GitFileDiff { cwd, path, staged, context_lines } → GitDiff(Vec<PanelDiffHunk>)
GitLog { cwd, limit }                       → GitLog(Vec<PanelCommit>)
GitCommitFiles { cwd, sha }                 → GitStatus (reuse)
GitCommitFileDiff { cwd, sha, path }        → GitDiff
GitCommitMessage { cwd, sha }               → GitText(String)
GitBulk { cwd, op: String, message: Option<String> }  → GitOp(PanelOpResult)   // stage-all|unstage-all|restore-all|stash|stash-pop
GitStashList { cwd }                        → GitStashes(Vec<PanelStash>)
GitStageFile { cwd, path, stage }           → GitOp
GitDiscardFile { cwd, path }                → GitOp
GitRestoreFileFrom { cwd, path, sha }       → GitOp
GitAmend { cwd, message: Option<String> }   → GitCommitDone(PanelCommitResult)
GitRevert { cwd, sha }                      → GitRevertDone(PanelRevertResult)
GitAheadBehind { cwd }                      → GitAheadBehind(Option<PanelAheadBehind>)
GitBranchInfo { cwd }                       → GitBranchInfoDone(PanelBranchInfo)
GitRecentBranches { cwd }                   → GitBranches(Vec<String>)
GitMerge { cwd, name }                      → GitMergeDone(PanelMergeResult)
GitConflictFiles { cwd }                    → GitConflicts(Vec<PanelConflict>)
GitResolveFile { cwd, path, side: String }  → GitOp   // ours|theirs
GitFetch { cwd } / GitPull { cwd }          → GitOp   (Push exists)
```

Plus the `WorkspaceResult` variants. Temporary todo-arms in the daemon dispatcher (replaced in Phase B); no `_` catch-alls. `cargo test -p waku-protocol`. Commit: `feat(git): workspace operations for the git panel`.

## Phase B — Service module (port of `commands/git.rs`)

All tasks: create/extend `crates/waku-core/src/git_panel.rs` (+ register in lib.rs). Port upstream functions verbatim with upstream tests where they exist; every fn takes `cwd: &Path`. Reuse from the settings port where signatures match (`identity_pair`-style resolution lives upstream in git.rs; attribution via `tide_store::config::current_attribution()`).

### Task 3: status + diffs
`status(cwd) -> Vec<PanelFileChange>` (upstream `git_status` L1715 + its numstat/status mapping), `file_diff(cwd, path, staged, context)` (L1726; staged = tree-to-index, unborn → empty tree), `staged_diff_text(cwd)` (L1741 — needed later for the AI message context; waku's `generate_message` already builds its own context, so this is optional — decide by comparing prompts and drop if redundant). Tests on a seeded repo: staged/unstaged/untracked/renamed; context clamping; binary 0/0.

### Task 4: log + decorations + commit inspection
`log(cwd, limit) -> Vec<PanelCommit>` (upstream L1758 + decoration walk L601-638: branch heads + tags keyed by 7-char sha, no peeling), `commit_files`, `commit_file_diff`, `commit_message`. Tests: decorations land on the right sha, parents/tags round-trip.

### Task 5: staging + bulk + stash
`stage_file`, `bulk(cwd, op)` dispatch (stage-all/unstage-all/restore-all/stash/stash-pop; upstream L1836-1843 impls), `stash_list`, `discard_file`, `restore_file_from`. Tests port: bulk round-trips on seeded repos, stash push/pop restores work, discard touches worktree only.

### Task 6: commit/amend/revert + attribution
`panel_commit(cwd, message)` — like `git_commit.rs::commit` but index-only (no include_unstaged staging side-effect; the UI stage-all-then-commits), attribution via the shared `current_attribution()`; `amend(cwd, message: Option)`; `revert(cwd, sha)`. Tests: attribution per mode (reuse the git_commit test pattern), amend null-message keeps original, revert creates attributed inverse commit.

### Task 7: branch info + remote ops
`branch_info`, `ahead_behind`, `recent_branches` (reflog, max 5), `merge` (conflicts surfaced, not failed), `conflict_files`, `resolve_file` (ours/theirs), `fetch`/`pull` (port upstream's ssh-agent env + `git credential fill` subprocess with the module's hygiene; push reuses existing `git_commit::push`). Tests: conflict states from a seeded merge; resolve both sides; recent branches from reflog; fetch/pull tested only at the plumbing layer (no network tests).

### Task 8: daemon arms
Wire every Task-2 operation in `workspace.rs::execute` to the service (replacing todo arms). One-shot cadence; existing thread model. `cargo test -p waku-core`. Commit per task: `feat(git): panel service — <area>`.

## Phase C — UI

### Task 9: surface + state + plumbing
New `RightPanelSurface::Git` (single-instance; replaces `Diff` in the enum — remove the Diff variant, its label/icon entry, and reuse index; migrate `RightPanelSessionState` persistence so restored sessions open Git instead of Diff). New `src/app/git_panel.rs` `GitPanelState`: status/conflicts/stashes/branch_info/ahead_behind queries with `Query::Pending/Ready/Missing` cache + generation counters, changes/history sub-tab, list/tree mode persisted, per-workspace commit draft, selected-file diff sub-view, stash dialog open, busy flags. Refresh triggers: panel-becomes-visible, every op completion, 5s `cx.spawn` timer loop gated on visibility (background executor timer; skip while hidden). All loads via `WorkspaceClient::request` in spawned background threads — mirror `refresh_right_panel_diff` (right_panel.rs:4559-4694) exactly. `cargo check` clean; commit `feat(git): right-panel git surface skeleton`.

### Task 10: Changes tab
Port git-panel.tsx Changes: branch toolbar (existing branch menu idioms + ahead/behind pill + worktree label), summary line +/−, SplitButton bulk menu (armed confirms for discard-all), conflict band (destructive tint, per-file Use ours/theirs → `GitResolveFile`), staged/unstaged `CollapsibleSection`-style sections with per-section bulk icons, list mode rows (`ChangedFileRow` port: status badge colors, middle-truncated dir, numstat chips, hover+focus stage/unstage/discard actions via `ActivationExt`), tree mode (`buildFileTree`/`countFiles` port to Rust + closed-dir state), empty/skeleton states. Keyboard: section headers toggle, rows act on Enter. Clicking a file → Task 11 diff sub-view. Locales for every string (en/ja/zh).

### Task 11: file diff sub-view + retire Diff surface
Clicking a changed file loads `GitFileDiff { staged, context_lines: 3 }` and renders inline: header (path, +/−, staged badge, back button) + hunks through the existing `review_diff` conversion and `render_diff_code_row` (gap expansion with wider-context refetch like tide's diffSource). Delete the old `render_right_panel_diff` toolbar/source-picker surface EXCEPT the LastTurn source: expose a "Last turn" review entry in the Git panel header (same `CollectReviewDiff { source: LastTurn }` call, rendered in the same sub-view). Files tree from the old surface is dropped (subsumed by tree mode). `cargo check`; commit.

### Task 12: commit bar + identity bar
Port commit-bar.tsx + commit-identity-bar.tsx: summary input + description, per-workspace draft persistence (persistence.rs or panel state — match how composer drafts persist), AI ✨ via existing `spawn_commit_message_generation` pattern (adapt to panel context; stream-into-summary if the existing pattern streams, else replace-once), ⌥ Amend toggle (prefill from `GitCommitMessage HEAD`, primary action → `GitAmend`), attribution trailer preview line (`current_attribution` read at render from cached snapshot state — never I/O per frame; refresh with status), Enter submits / nothing-staged → bulk stage-all then commit / blocked while conflicts, new-sha flash (1.5s timer). Identity bar: "Committing as" + profile dot from a new `current_identity(cwd)` service fn (port upstream `current_identity`, resolve + profile match) added to `git_identities.rs` with `GitSetIdentity` apply on session cwd + "Manage identities…" → open Settings → Git. Tests: `current_identity` unit test port.

### Task 13: History tab
Port lanes.ts → pure Rust `assign_lanes` (unit tests ported from upstream if present, else hand-written: linear, branch+merge, octopus within MAX_LANE=5). Virtualized 24px rows via `list()` (fixed-height rows; total from laid commits), graph column as one custom gpui Element painting precomputed lane segments (straight/bezier) with `window.paint_path` (check the pinned gpui revision's Path API in Zed's crates for the idiom; map LANE_COLORS to theme tokens) — segments computed once per log refresh, element only projects them. Commit rows: 64px graph gutter, branch/tag chips, subject, relative date, initials avatar (hue = hash of sha). Row actions: ⋯ popover (revert confirm stage, branch-from input + create&switch via existing `create_and_checkout`, detached checkout) + context menu (view details, copy sha/reference). Commit details sub-view: message, clickable parents, changed files, per-file diff (reuse Task 11 machinery). Limit 500; manual refresh button.

### Task 14: stash dialog + branch toolbar finish
Stash viewer popover (list + Pop via `GitBulk stash-pop`); fetch/pull/push menu actions on the branch toolbar with toasts (components.rs toast pattern); ahead/behind refresh after remote ops.

### Task 15: final validation
`cargo test -p waku-protocol -p waku-core` (known server flakes pass in isolation); `cargo clippy` on touched crates; locale completeness (3 files); keyboard-only pass over the panel (tab cycle, arrows in lists/menu, enter/escape everywhere, focus_visible on all hover actions); both themes. Debug-app smoke per AGENTS.md only if requested.

## Risk notes

- `RightPanelSurface::Diff` removal touches persisted session state (restore path) — handle the migration in Task 9 and grep every `Diff` match site (app.rs:520 enum, right_panel.rs label/reuse/body dispatch, runtime open actions, ReviewDiffSource consumers).
- gpui path-painting API must be verified against the pinned revision before Task 13's element; fallback is gpui `svg()` from generated in-memory SVG bytes if the app's svg pipeline accepts data sources (check `src/assets.rs`).
- The 5s poll must not run while the panel is hidden or the window is inactive — gate on surface visibility like the pulse cadences in docs/performance.md.
