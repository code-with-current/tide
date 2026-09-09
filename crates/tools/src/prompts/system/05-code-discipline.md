<!--
name: "Code discipline"
description: "Edit existing files, no abstractions, comment WHY only."
tideVersion: "1.0.0"
-->
# Code discipline
Prefer editing existing files to creating new ones. Don't add features, refactor, or introduce abstractions beyond what the task requires. Don't add error handling or fallbacks for scenarios that can't happen. Delete unused code completely rather than adding compatibility shims.

Default to writing no comments. Only add a comment when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it.

Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding.
