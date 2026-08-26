<p align="center">
  <img src="./src/assets/tide-logo.png" alt="Tide" width="300" />
</p>

<p align="center">
  <a href="https://github.com/code-with-current/tide/releases/latest"><img src="https://img.shields.io/github/package-json/v/code-with-current/tide?style=flat-square&logo=github&label=Release&color=blue" alt="Release" /></a>
  <a href="https://github.com/code-with-current/tide/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/code-with-current/tide/ci.yml?style=flat-square&logo=githubactions&label=Build" alt="Build" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/code-with-current/tide/master/package.json&query=$.packageManager&style=flat-square&logo=bun&logoColor=white&label=Bun&color=blue" alt="Bun" /></a>
  <a href="https://framework.blackboard.sh/electrobun/"><img src="https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/code-with-current/tide/master/package.json&query=$.electrobun&style=flat-square&label=Electrobun&color=blue" alt="Electrobun" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/code-with-current/tide/master/package.json&query=$.devDependencies.react&style=flat-square&logo=react&logoColor=white&label=React&color=blue" alt="React" /></a>
</p>

<p>
  <strong>Code with the current.</strong> → <a href="https://tide.codes">tide.codes</a>
</p>

Tide is a local-first agentic coding companion. It indexes your codebase with local ONNX embeddings, gives the AI 20+ real tools (file edits, terminal, git, grep, web search, MCP), and puts you in control with a permission system — plan, ask, edit, or full-access modes. Your code never leaves your machine; API keys stay encrypted in the OS keychain.

Works with Anthropic & OpenAI compatible endpoint. Each session can branch into its own git worktree so your main branch stays untouched.

## Installation

**macOS** (Homebrew):

```sh
brew install --cask code-with-current/tap/tide
```

**Windows** (winget):

```powershell
winget install Tide.Tide
```

**Linux** (Snap):

```sh
snap install tide-codes
```

Or grab the latest installer directly from the [releases page](https://github.com/code-with-current/tide/releases) — `.dmg` (macOS arm64), `.exe` (Windows x64), or `.deb` / `.AppImage` (Linux x64 + arm64).

The app updates itself in place — you'll get a notice when a new version is available, and nothing downloads until you say so.

---

## Features

- **Local-first** — Your code never leaves your machine. Sessions, indexes, and models all run locally.
- **Code-aware RAG** — Local ONNX embeddings index your codebase at symbol boundaries. The agent searches semantically, not just grep.
- **20+ real tools** — File edits, terminal, git, grep, web search, MCP servers — the agent uses actual tools with permission gates you control.
- **Permission system** — Plan, ask, edit, or full-access modes. Every tool call can be approved, rejected, or remembered.
- **Any provider** — Anthropic, OpenAI, or any OpenAI-compatible endpoint (z.ai, Together, Groq, Ollama, etc.). Bring your own key.
- **Worktree isolation** — Each session can branch into its own git worktree. Experiment freely — your main branch stays untouched.
- **Project templates** — Scaffold new projects with Next.js, Vite, TanStack Start, T3 Stack, Nuxt, and more.
- **Keyboard-first** — Every action has a rebindable shortcut. Full keyboard navigation with persistent custom bindings.
- **Consent-driven updates** — Tide checks in the background but never downloads or installs without your say-so. Restart when you're ready.

## Links

- **Homepage:** [tide.codes](https://tide.codes)
- **GitHub:** [github.com/code-with-current/tide](https://github.com/code-with-current/tide)
- **Releases:** [latest download](https://github.com/code-with-current/tide/releases)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding conventions, and pull request guidelines.

## License

[MIT](LICENSE)
