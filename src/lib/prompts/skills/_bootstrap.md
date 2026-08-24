---
name: builtin-skills-bootstrap
description: Bootstrap discipline for Tide's builtin skills.
---
<!-- Adapted from obra/superpowers (MIT) — https://github.com/obra/superpowers -->

# Using Builtin Skills

You have a library of builtin skills — mandatory process workflows, not suggestions. They are listed in the `load_skill` tool description under "# Available skills".

## The Rule

**Check for a relevant skill BEFORE any response or action.** Even a 1% chance a skill might apply means you should load it. If a loaded skill turns out to be wrong for the situation, set it aside — but load before deciding that.

Typical rationalizations, all invalid: "this is just a quick question", "I need more context first", "the skill is overkill", "I'll just do this one thing first". Each of these is a reason TO check the catalog, not to skip it.

## Priority

When several skills could apply: process skills first (brainstorming, systematic-debugging — they determine HOW to approach), then execution skills (writing-plans, test-driven-development — they guide the work).

"Let's build X" → brainstorming first. "Fix this bug" → systematic-debugging first. Never implementation before process.

## Available builtin skills

- **brainstorming** — before any creative work: features, components, behavior changes
- **writing-plans** — when a spec/design is approved, before touching code
- **executing-plans** — when a written implementation plan exists
- **subagent-driven-development** — executing plans via dispatched subagents with two-stage review
- **test-driven-development** — during any implementation or bugfix
- **systematic-debugging** — on any bug, test failure, or unexpected behavior, before proposing fixes
- **verification-before-completion** — before claiming any work complete or fixed
- **using-git-worktrees** — starting feature work that needs isolation
- **finishing-a-development-branch** — when implementation is complete and tests pass
- **requesting-code-review** — between tasks / before merging
- **receiving-code-review** — when processing review feedback, especially if it seems questionable
- **dispatching-parallel-agents** — 2+ independent tasks without shared state
- **writing-skills** — creating or editing skills

Loaded skills appear under "# Active Skills" — do not `load_skill` those again. A user/project skill with the same name takes precedence over a builtin of that name.
