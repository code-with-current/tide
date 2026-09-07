<p align="center">
  <img src="./resources/master.png" alt="Tide" width="220" />
</p>

<p align="center">
  <a href="https://github.com/code-with-current/tide/releases/latest"><img src="https://img.shields.io/github/v/release/code-with-current/tide?style=flat-square&logo=github&label=Release&color=blue" alt="Release" /></a>
  <a href="https://github.com/code-with-current/tide/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/code-with-current/tide/test.yml?branch=master&style=flat-square&logo=githubactions&label=CI" alt="CI" /></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/built_with-Rust-orange?style=flat-square&logo=rust&logoColor=white" alt="Built with Rust" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-blue?style=flat-square" alt="License" /></a>
</p>

<p align="center">
  <strong>Code with the current.</strong> → <a href="https://tide.codes">tide.codes</a>
</p>

Tide is a local-first agentic coding companion. It indexes your codebase with
local ONNX embeddings, gives the agent 20+ real tools (file edits, terminal,
git, grep, web search, MCP), and keeps you in charge with a permission
system — plan, ask, edit, or full-access modes. Your code never leaves your
machine; API keys stay encrypted in the OS keychain.

It works with Anthropic and OpenAI-compatible endpoints, and each session can
branch into its own git worktree so your main branch stays untouched.

## Installation

Grab the latest installer from the
[releases page](https://github.com/code-with-current/tide/releases/latest):

- **macOS** (Apple Silicon) — with Homebrew:

  ```sh
  brew install --cask code-with-current/tap/tide
  ```

  Or grab `tide-v<version>-mac-arm64.dmg` from the releases page. The build
  is ad-hoc signed, so a direct download needs right-click → **Open** on
  first launch; a Homebrew install skips that prompt.
- **Windows** (x64 / arm64) — `tide-v<version>-windows-<arch>-setup.exe`
  installs per-user and updates itself. A portable `.zip` is published
  alongside it. See [docs/windows.md](docs/windows.md).
- **Linux** (x64 / arm64) — `.deb`, `.rpm`, or `.AppImage`. See
  [docs/linux.md](docs/linux.md).

The app checks for updates in the background and never downloads anything
without your go-ahead.

## Features

- **Local-first** — projects, sessions, transcripts, and indexes stay on your
  machine. No account, no remote service.
- **Code-aware RAG** — local ONNX embeddings index your codebase; the agent
  searches semantically, not just by grep.
- **20+ real tools** — file edits, terminal, git, grep, web search, MCP
  servers — every tool call passes permission gates you control.
- **Permission system** — plan, ask, edit, or full-access modes; approvals can
  be remembered per project.
- **Any provider** — Anthropic, OpenAI, or any OpenAI-compatible endpoint.
  Bring your own key.
- **Worktree isolation** — sessions can branch into their own git worktree.
  Experiment freely; your main branch stays untouched.
- **Steerable sessions** — queue or steer follow-up messages while the agent
  is working, and rewind to earlier conversation-aware checkpoints.
- **Sub-agents & skills** — dispatch specialized sub-agents, load project or
  user skills, and let the agent drive them mid-session.
- **Keyboard-first** — every action has a rebindable shortcut, with full
  keyboard navigation.

## Links

- **Homepage:** [tide.codes](https://tide.codes)
- **Releases:** [latest download](https://github.com/code-with-current/tide/releases/latest)
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)

## Development

Requires [Rust 1.96 or newer](https://www.rust-lang.org/tools/install) and
[Bun](https://bun.sh).

```sh
bun install
bun run dev
```

The embedded browser and experimental computer-use integration are macOS-only
for now; agent sessions, file editing, the terminal, skills, and updates run
natively on Linux and Windows. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development workflow and checks, and [RELEASING.md](RELEASING.md) for cutting
releases.

## About this fork

Tide is an independent fork of [Waku](https://github.com/egoist/waku) by
[EGOIST](https://github.com/egoist) and contributors, rebranded with
attribution preserved. It is not affiliated with the Waku project; upstream
credit and the GPL-3.0-only license carry forward — see [NOTICE](NOTICE).

## License

[GNU General Public License v3.0 only](LICENSE)
