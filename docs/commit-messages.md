# Commit-message generation

When the commit dialog's message box is left empty, Tide generates the subject
line itself: a one-shot completion through the tide engine — no session, no
tools, low thinking — summarizing the diff. The daemon owns this in
[`git_commit.rs`](../crates/backend/src/git_commit.rs) (`generate_message_tide`
via `tide_one_shot`); the same one-shot shape powers session-title generation
([titles.md](titles.md)).

## Which model

A commit subject is a fixed classification over a diff that is already in the
prompt, so it does not need the model the task runs on. General Settings'
**commit-message model** override (`commitMessageModel`, resolved through
`background_model_override("commit-message")`) picks a cheap tide-provider
model; a stale override falls through to the session's own selection instead of
failing generation. The override machinery is shared with the title model.

## The prompt

[`commit_prompt`] builds it from Git alone — no transcript, no session history:

| Include unstaged | Status | Diff |
| --- | --- | --- |
| off | `git diff --cached --name-status` | `git diff --cached` |
| on (default) | `git status --short --untracked-files=all` | `git diff --cached`, then `git diff` under its own heading |

Diffs run `--no-ext-diff --no-color`. The context is capped at 96 KiB, cut on a
UTF-8 boundary and marked `[diff truncated]`, which also adds a sentence telling
the model to summarize only what it can still see. Then:

```
Generate a concise Git commit subject for the changes below.
Return exactly one line and nothing else: no quotes, Markdown, prefix, explanation, or trailing period.
Use imperative mood and at most 72 characters. Do not call tools; all context is included here.
```

## Normalizing the output

Models disagree about what "one line and nothing else" means — preamble lines,
code fences, ANSI. [`normalize_message`](../crates/backend/src/git_commit.rs)
strips ANSI, drops empty lines, bare ``` fences and `[tool]` / `[thinking]`
lines, takes the **last** surviving line, then strips backticks, a
`Commit message:` / `Commit subject:` prefix, wrapping quotes and a trailing
period, and caps at 200 characters. Empty means failure, reported as
"returned no commit message".

Taking the last line makes the result a subject only: a model that returns a
subject, blank line, and body has the body discarded.

[commit_prompt]: ../crates/backend/src/git_commit.rs
