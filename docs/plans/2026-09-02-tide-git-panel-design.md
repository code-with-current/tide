# Tide Git Panel → Waku Port Design

Date: 2026-09-02
Source: `tide/src/components/right-panel/git/` (git-panel.tsx + 8 satellites) and
`tide/src-tauri/src/commands/git.rs` (upstream checkout at
`/Volumes/512gb/TestAi/tide`). Replaces Waku's right-panel **Diff (review) tab**
with a full Git panel carrying all Tide features.

## Goal

One right-panel Git tab per session: branch toolbar, commit identity bar,
Changes (staged/unstaged/conflicts, list + tree, per-file ops, bulk ops,
stash), a commit bar with AI message + amend + attribution preview, and a
History tab (500-commit virtualized log with lane graph, revert /
branch-from / checkout, commit details). The old Diff surface is retired;
its live review value is folded in (below).

## What replaces what

- The old Diff tab's **Uncommitted / Unstaged / Staged** sources are
  subsumed by the Changes tab (strictly richer: per-file ops, staging).
- Its **LastTurn** source (review the agent's last turn via checkpoint
  refs) is preserved as a review mode reachable from the Git panel header —
  the coding-agent review workflow must not regress.
- Per-file diffs render **inline in the Git tab** (sub-view with back
  navigation), reusing `review_diff`'s model and `render_diff_code_row` —
  the same machinery the Diff tab used.
- `Files`, `Browser`, `Terminal`, `Agents`, `File` surfaces are untouched.

## Architecture

Same three layers as the settings port, on the **WorkspaceOperation**
umbrella (the precedent the diff/branches/commit flows already use —
cwd-keyed, no session resolution needed server-side):

1. **Service** — `crates/waku-core/src/git_panel.rs`, a near-verbatim port
   of tide's `commands/git.rs` (all libgit2, in-process; the one upstream
   subprocess — `git credential fill` for HTTPS fetch/push — is ported with
   the module's subprocess hygiene). Waku already has branch
   inspect/checkout/create (`git_branch.rs`), commit/push/AI-message
   (`git_commit.rs`, attribution-aware), worktrees (`worktree.rs`) — the new
   module adds the missing ops and reuses those where they overlap.
2. **Protocol** — new `WorkspaceOperation` variants + wire types in
   `waku-protocol/src/git.rs` mirroring tide's `shared/rpc.ts` git section:
   `GitFileChange`, `GitCommit` (with branchHeads/tags decorations),
   `GitStash`, `GitConflictEntry`, `GitBranchInfo`, `GitAheadBehind`,
   `DiffHunk/DiffLine`, op-result shapes.
3. **UI** — new `RightPanelSurface::Git` (single-instance, like Diff) with
   state in `src/app/git_panel.rs`; changes/history sub-tabs; data loaded
   via `cx.spawn` + background executor with generation counters; refresh
   after every mutation plus a 5s timer while visible (deviation: tide uses
   an fs-watcher push channel; waku has none — invalidation + modest poll
   is the native idiom).

## Session/worktree scoping

Tide keys queries by session only when the session owns a worktree. Waku
gets this for free: the panel uses `workspace_path_for_session` as its cwd
(worktree path for worktree sessions, project root otherwise) — the same
resolution the diff/branches/commit flows use today.

## Feature inventory (all ported)

- **Branch toolbar** — branch menu (search, local with inline create,
  remotes, recent branches), ahead/behind badges, worktree label. Reuses
  waku's existing branch picker/menu idioms (`branches.rs`,
  `dropdown_menu`); adds fetch/pull/push actions.
- **Commit identity bar** — "Committing as" strip with profile dot,
  per-session apply via the existing `GitSetIdentity` command (cwd-keyed),
  "Manage identities…" → Settings → Git. Needs a new light
  `current_identity(cwd)` service fn (skipped in the settings port).
- **Changes tab** — total +/− summary; list/tree view toggle (persisted);
  staged & unstaged collapsible sections with per-section bulk actions;
  per-file stage/unstage/discard/restore-from-sha; SplitButton bulk menu
  (stage all / unstage all / discard all / stash / stash pop); conflict
  band with per-file "Use ours/theirs"; numstat chips and status badges.
- **Commit bar** — summary/description draft persisted per workspace;
  AI-message generation (waku's existing per-provider agent invocation, not
  tide's commit-writer agent); amend toggle (prefills HEAD message);
  attribution trailer preview from `current_attribution()`; Enter submits;
  nothing-staged → stage-all-then-commit; new-sha flash; blocked while
  conflicts present.
- **History tab** — 500-commit log, virtualized 24px rows, lane graph
  (lazygit-style `assignLanes` ported to pure Rust, drawn as one gpui
  canvas/path element behind the rows), branch-head/tag chips, relative
  dates, initials avatars, per-row actions (revert with confirm,
  branch-from with input, detached checkout), commit details sub-view
  (message, parents, changed files with per-file diff, AI
  explain/review optional follow-up).
- **Stash viewer dialog** — list + pop.
- **Ops** — fetch/pull/push with SSH-agent + HTTPS credential-fill
  plumbing; merge with conflicts surfaced into the resolve flow; revert
  with attribution.

## Key deviations from tide (deliberate)

- Refresh: invalidation + 5s visibility-gated timer instead of the fs
  watcher push.
- AI commit message: waku's existing per-provider generation
  (`generate_message`), not tide's `commit-writer` agent; streaming into
  the summary field if the existing spawn pattern supports it, else
  replace-once.
- The panel is native GPUI — no web animations; waku theme tokens; the
  graph uses gpui path painting, not SVG-in-DOM.
- History graph colors: map tide's 6 lane colors to waku theme tokens.

## Performance contract

All git ops run on the background executor via the daemon request path
(one-shot commands); the panel renders only cached state; history uses
`list()` virtualization with fixed-height rows; the lane layout runs once
per log refresh (not per frame); the graph element repaints from
precomputed segment data. Generation counters guard every async result.

## Testing

- Backend unit tests port with the code (status parse, diff hunks, log
  decorations, lanes assignment — pure fn, bulk ops on seeded repos,
  conflict resolve, stash push/pop round-trip, revert/amend attribution).
- UI: smoke via the debug app in final validation; no visual tests unless
  requested.
