# Tide

Tide is a fast, native desktop app for working with local coding agents. It is
built in Rust with [GPUI](https://github.com/zed-industries/zed/tree/main/crates/gpui)
and keeps projects, sessions, transcripts on your machine.

## Install

On macOS, [download the signed `.dmg`](https://tide.codes). It updates itself.

On Linux:

```sh
curl -fsSL https://tide.codes/install.sh | sh
```

The script installs into `~/.local` without root. See
[docs/linux.md](docs/linux.md) for requirements, manual installation, and
uninstalling.

On Windows, run `Tide-<version>-<arch>-Setup.exe` from the
[latest release](https://github.com/code-with-current/page/releases/latest). It installs
per-user and updates itself. A portable `.zip` is published alongside it. See
[docs/windows.md](docs/windows.md) for requirements and what is not available
there yet.

## Supported agents

Tide runs its own embedded agent. Configure endpoints (OpenAI-compatible or
Anthropic-style APIs) on the Providers screen in Settings; no external agent
CLI is required.

## Highlights

- Keep projects and independent agent sessions in one native app.
- Switch models, reasoning effort, and access modes from a shared interface.
- Queue or steer follow-up messages while an agent is working.
- Rewind Git-backed tasks with conversation-aware checkpoints.
- Store app state locally, with no Tide account or remote service required.

## Architecture

The native desktop is an RPC client of the standalone `tide-daemon` process.
Provider sessions run in [`backend`](crates/backend), behind the
authenticated, versioned WebSocket contract in
[`protocol`](crates/protocol). Tide Desktop depends on
[`client`](crates/client), not on the daemon implementation. The
daemon owns task SQLite data, uploaded attachments, session
forks, and all workspace filesystem and Git operations; paths returned by it
always refer to the daemon host. The desktop retains only presentation state
and a disposable preview cache.

The Remote Control browser client lives in the separate `tide-remote` repo
(`tide-web` + `tide-relay`, deployed to `remote.tide.codes`). Its protocol
bindings are owned and generated in that repo.

Projectless task workspaces live on the daemon host under
`~/.tide/projects/<date>/<slug>`. The daemon moves workspaces created by the
older `~/.tide/<date>/<slug>` layout on first load.

Configuration ownership is separate too: the Release desktop writes
`~/.tide/app.json`, while Debug stays isolated at `temp/app.json`. Daemon
provider and Computer Use settings live in `~/.tide/settings.json`. The
desktop's Settings → Daemon page can explicitly
expose the child daemon on a fixed port, configure exact browser origins, and
copy its stable authentication token. It remains loopback-only by default.

When connected to a daemon managed outside the desktop process, Tide never
interprets daemon paths on the client machine. The local folder picker and PTY
are therefore unavailable until the protocol gains daemon-host picker and
terminal-stream endpoints; files, diffs, Git, skills, usage, task state, and
attachments already use daemon RPC.

Release apps bundle and sign `tide-daemon`. Development keeps the daemon at
`target/debug/tide-debug-daemon`, allowing provider-only edits to rebuild and
replace the daemon without relaunching Tide Debug.

## Development

Development is supported on macOS, Linux, and Windows and requires
[Rust 1.96 or newer](https://www.rust-lang.org/tools/install) and
[Bun](https://bun.sh/). Linux supports both Wayland and X11, and Windows needs
the MSVC toolchain; install the native build prerequisites listed in
[CONTRIBUTING.md](CONTRIBUTING.md) first.

```sh
bun install
bun run dev
```

The embedded browser and experimental computer-use integration currently
remain macOS-only. Agent sessions, projects, transcripts, skills, usage,
diffs, file editing, and the terminal run natively on Linux and Windows.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and checks.
Release maintainers should also read [RELEASING.md](RELEASING.md).

## About this fork

Tide is an independent fork of [Waku](https://github.com/egoist/waku) by
[EGOIST](https://github.com/egoist) and contributors, rebranded with
attribution preserved. It is not affiliated with the Waku project; upstream
credit and the GPL-3.0-only license carry forward — see [NOTICE](NOTICE).

## License

Tide is licensed under the [GNU General Public License v3.0 only](LICENSE).
