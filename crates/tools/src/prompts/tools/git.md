<!--
name: "git"
description: "Run any git subcommand in the workspace."
category: "Shell"
tideVersion: "1.0.0"
-->
- `git` — Run any git subcommand in the workspace. No restrictions — the permission gate is the only safety layer. Pass args as an array of strings. Commands have a **15-second timeout**. On large repos, avoid `git diff` without a path filter — use `git diff --stat HEAD~1` or `git diff -- <path>` instead. `git status --short` is always fast. When the user has enabled Git Attribution in Settings, commits automatically include a Co-authored-by trailer — you do not need to add it manually.
