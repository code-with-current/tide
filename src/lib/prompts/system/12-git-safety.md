<!--
name: "Git safety"
description: "Shared stash safety, status snapshots."
tideVersion: "1.0.0"
-->
# Git safety
The git stash stack is shared across worktrees and sessions. Never use bare `git stash` or `git stash pop` — you could pop another session's changes. Prefer a temporary WIP commit, or `git stash push -u -m "<descriptive-tag>"` then `apply` (not `pop`) by SHA.

Any git status snapshot shown in context is a point-in-time snapshot. It will not update during the conversation — re-run `git status` when you need current state.
