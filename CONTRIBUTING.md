# Contributing to Tide

Thanks for your interest in contributing! Tide is a local-first agentic coding companion — your code, keys, and data stay on your machine. This guide covers getting set up and the conventions to follow.

## Prerequisites

| Requirement | Version |
|---|---|
| [Bun](https://bun.sh) | 1.4.0+ (pinned via `packageManager` in package.json) |
| [Hutch](https://framework.blackboard.sh/electrobun/guides/hutch/) | latest production channel |
| [Git](https://git-scm.com) | 2.20+ |

Install Hutch:

```sh
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | bash -s -- --channel production --no-modify-path
```

Node.js 22+ is also handy for editor tooling (TypeScript server), but Bun owns the actual build and test pipeline.

## Getting started

```sh
git clone https://github.com/code-with-current/tide.git
cd tide
bun install
```

### Run the dev build

```sh
bun run app:dev
```

This syncs the Electrobun devkit, then launches the app with `--watch` — main-process edits (`app/**`) rebuild and relaunch automatically. Renderer edits (`src/**`) need a rebuild + sync first:

```sh
bun run build && hutch electrobun sync
```

For renderer-only iteration in a plain browser (mock data, no bridge):

```sh
bun run dev
```

## Common commands

| Command | What it does |
|---|---|
| `bun run app:dev` | Full dev — sync + launch with `--watch` |
| `bun run dev` | Renderer-only dev (plain browser, mock data) |
| `bun run build` | Typecheck (`tsc -b`) + Vite production build |
| `bun run app:build` | Full release build (renderer + Electrobun bundle) |
| `bun run lint` | Run oxlint |
| `bun run test` | Run the vitest suite once |
| `bun run test:watch` | Run vitest in watch mode |
| `bun run test:updater` | Local end-to-end update-flow scenario |

### Before opening a PR

1. **Typecheck** — `tsc -b` (incremental, fast). Always use this, never `tsc --noEmit`.
2. **Lint** — `bun run lint` should pass clean.
3. **Tests** — `bun run test` should pass. If you add a feature, add a test.

## Project structure

Tide is an Electrobun app with a Bun main process and a React renderer. Read [`AGENTS.md`](./AGENTS.md) for the full architecture deep-dive — the short version:

```
app/               Main process (Bun runtime)
  core/            Agent runtime — orchestrator, tools, RAG, MCP, stores
  rpc/             Typed RPC handlers, one module per domain
  platform/        OS seams — sqlite, secrets, pty, paths, updater
shared/            RPC schema (types-only, imported by both processes)
src/               Renderer — React SPA (components, stores, queries)
  components/      UI (chat, sidebar, panels)
  lib/             Stores, API client, stream logic, prompts
build/             Build pipeline scripts + vendored native deps
test/              Centralized test suite (test/app/ + test/core/)
```

### File naming

| Location | Convention |
|---|---|
| `src/components/` and below | kebab-case (`chat-composer.tsx`) |
| `src/lib/`, `src/hooks/` | kebab-case (`use-chat-stream.ts`) |
| shadcn/ui primitives | single-word lowercase (`button.tsx`) |
| `app/core/agent/tools/` | kebab-case, one file per tool |
| System prompt fragments | numbered prefix (`01-identity.md`) |

New files default to **kebab-case**. Match the directory you're in.

### Key conventions

- **Renderer never touches the filesystem, shell, or network directly** — all privileged ops go through the typed RPC bridge to the main process.
- **One Zustand store** (`src/lib/stores/ui.ts`) for UI state. Don't create parallel stores.
- **Path aliases**: `@/*` for renderer imports, `@shared/*` for the RPC schema.
- **`shared/rpc.ts` stays types-only** — importing runtime modules from `app/core` into the schema drags the main-process graph into the renderer typecheck. Extract leaf types if you need them.
- **No comments by default** — only document the *why* when non-obvious.
- **`bun.lock` must be committed** — CI installs with it.

## Branches & commits

### Branch naming

Use a descriptive prefix:

```
feat/session-fork-ui
fix/scroll-lock-on-tool-call
chore/upgrade-bun
```

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(chat): stream tool output incrementally
fix(orchestrator): handle aborted turns without orphaned state
docs: add contribution guide
chore(deps): bump bun to 1.4.1
```

Keep the subject line under 72 characters, imperative mood.

## Pull requests

1. Fork the repo and create a branch from `dev`.
2. Make your changes. Keep PRs focused — one feature or fix per PR.
3. Ensure typecheck, lint, and tests pass (see above).
4. If your change touches the UI, include screenshots or screen recordings in the PR description.
5. Reference any related issues (`Closes #123`).

### What we look for

- **Local-first principle**: nothing you add should transmit user code or data off-device except outbound LLM API calls the user configures.
- **Permission system**: if you add a tool or privileged operation, it must go through the permission gate in the main process.
- **Scope**: don't refactor unrelated code in the same PR. Keep diffs reviewable.

## Reporting bugs

Open a [GitHub Issue](https://github.com/code-with-current/tide/issues) with:

- Tide version (from the splash screen or Settings → About)
- OS and architecture (macOS arm64, Windows x64, etc.)
- Steps to reproduce
- Expected vs. actual behavior
- Relevant logs or screenshots

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
