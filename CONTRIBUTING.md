# Contributing to Tide

Thanks for your interest in contributing! Tide is a local-first agentic coding companion — your code, keys, and data stay on your machine. This guide covers getting set up and the conventions to follow.

## Prerequisites

| Requirement | Version |
|---|---|
| [Node.js](https://nodejs.org) | 22+ (CI runs on 22) |
| [pnpm](https://pnpm.io) | 10.27.0 (pinned via `packageManager` — corepack handles it) |
| [Git](https://git-scm.com) | 2.20+ |

Enable corepack once after installing Node:

```sh
corepack enable
```

pnpm will then resolve to the pinned version automatically — don't pass `--version` flags.

## Getting started

```sh
git clone https://github.com/code-with-current/tide.git
cd tide
pnpm install
```

### Run the dev build

The renderer (Vite) and the Electron main process run as separate processes:

```sh
pnpm electron:dev
```

This boots Vite on `http://localhost:5173`, waits for it, then launches Electron pointed at it. Hot reload works for both renderer and main-process changes.

For renderer-only iteration (no Electron shell):

```sh
pnpm dev
```

## Common commands

| Command | What it does |
|---|---|
| `pnpm electron:dev` | Full dev — Vite + Electron |
| `pnpm dev` | Renderer-only dev (no Electron) |
| `pnpm build` | Typecheck (`tsc -b`) + Vite production build |
| `pnpm lint` | Run oxlint |
| `pnpm test` | Run the vitest suite once |
| `pnpm test:watch` | Run vitest in watch mode |
| `pnpm electron:build` | Build desktop installers via electron-builder |

### Before opening a PR

1. **Typecheck** — `tsc -b` (incremental, fast). Always use this, never `tsc --noEmit`.
2. **Lint** — `pnpm lint` should pass clean.
3. **Tests** — `pnpm test` should pass. If you add a feature, add a test.

## Project structure

Tide is a dual-process Electron app. Read [`AGENTS.md`](./AGENTS.md) for the full architecture deep-dive — the short version:

```
electron/          Main process — orchestrator, tools, RAG, MCP, IPC handlers
src/               Renderer — React SPA (components, stores, queries)
  components/      UI (chat, sidebar, panels)
  lib/             Stores, API client, stream logic, prompts
build/             electron-builder config + build scripts
```

### File naming

| Location | Convention |
|---|---|
| `src/components/` and below | kebab-case (`chat-composer.tsx`) |
| `src/lib/`, `src/hooks/` | kebab-case (`use-chat-stream.ts`) |
| shadcn/ui primitives | single-word lowercase (`button.tsx`) |
| `electron/agent/tools/` | kebab-case, one file per tool |
| System prompt fragments | numbered prefix (`01-identity.md`) |

New files default to **kebab-case**. Match the directory you're in.

### Key conventions

- **Renderer never touches the filesystem, shell, or network directly** — all privileged ops go through `window.tide.*` IPC to the main process.
- **One Zustand store** (`src/lib/stores/ui.ts`) for UI state. Don't create parallel stores.
- **Path alias**: use `@/*` (maps to `./src/*`) for renderer imports.
- **No comments by default** — only document the *why* when non-obvious.
- **pnpm-lock.yaml must be committed** — CI installs with `--frozen-lockfile`.

## Branches & commits

### Branch naming

Use a descriptive prefix:

```
feat/session-fork-ui
fix/scroll-lock-on-tool-call
chore/upgrade-electron
```

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(chat): stream tool output incrementally
fix(orchestrator): handle aborted turns without orphaned state
docs: add contribution guide
chore(deps): bump electron to 33
```

Keep the subject line under 72 characters, imperative mood.

## Pull requests

1. Fork the repo and create a branch from `master`.
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

- Tide version (from Settings → About)
- OS and architecture (macOS arm64, Windows x64, etc.)
- Steps to reproduce
- Expected vs. actual behavior
- Relevant logs or screenshots

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
