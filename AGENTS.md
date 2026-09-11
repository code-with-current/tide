# Tide development guidance

Tide is a fast, native desktop app for working with local coding agents, built
in Rust with GPUI. GPL-3.0-only.

## Workspace layout

- Root crate `tide` (`src/`) is the GPUI desktop app: `src/app/` holds the UI
  screens, `src/ui/` the in-house widget primitives, `src/md/` markdown
  parsing and rendering. The backend serves its WebSocket protocol from an
  in-process, app-owned listener — there is no separate daemon process to
  build or hot-swap anymore.
- `crates/protocol` — versioned, transport-neutral wire contract. Serde types
  only: no DB, provider, filesystem, Git, or socket code.
- `crates/client` — WebSocket client for the protocol: handshake, request
  correlation, subscriptions, supervision. Depends on `protocol`, never
  `backend`.
- `crates/transport` — authenticated WebSocket server: connection handling,
  request dispatch, subscriptions, event sequencing, and bounded replay.
  Depends on `protocol`; runtime implementations stay behind its `Backend`
  trait.
- `crates/backend` — daemon-side runtime: session drivers, provider discovery,
  orchestration, and computer use. Depends on `transport` to implement its
  request handler, but contains no socket, persistence implementation, or UI
  code.
- `crates/host` — process environment, Git and worktree operations,
  checkpoint refs, and projectless workspace services. No provider runtime,
  socket, or UI code.
- `crates/engine` — the ONLY crate permitted to depend on `rig` (churn
  firewall, pinned rig_core). Keep provider churn inside it.
- `crates/store` — all daemon and desktop persistence: task/session SQLite,
  settings and config, attachments and blobs, provider state, and the RAG
  index (in-place `~/.tide`).
- `crates/tools` — built-in agent tools plus the permission gate.
  Engine-agnostic: nothing here imports `rig` or `engine`.
- `crates/rag` — local-first RAG engine over a vendored ONNX model.

## Platform support

- Targets macOS, Linux (Wayland/X11), and Windows. CI runs `cargo test
  --locked` on all three with Rust 1.96.
- The embedded browser and the computer-use integration are macOS-only. On
  Linux/Windows they report unavailable — keep the code compiling and the UI
  degrading gracefully on all platforms.
- The dev watcher builds `target/debug/Tide Debug.app` on macOS and
  `target/debug/tide` elsewhere. Windows needs the MSVC toolchain; Linux needs
  the GPUI runtime packages listed in CONTRIBUTING.md.

## Development runtime

- Run `bun install` once, then assume `bun ./scripts/dev.ts` is already
  running and owns the current debug app process. Source changes are rebuilt,
  signed (macOS), and relaunched automatically; it watches `src/`, `crates/`,
  `assets/`, `resources/`, and `locales/`.
- During normal development and UI validation, do not run
  `scripts/bundle.sh debug`, start a second watcher, or manually quit/relaunch
  the debug app. Quitting the app also stops the watcher.
- After an edit, wait for the watcher to finish its successful rebuild and
  validate the freshly relaunched app. Only start or recover the watcher
  manually when it is confirmed unavailable.
- No visual test unless requested.
- For provider-native content such as citations, reasoning, and tool events,
  verify the real provider payload and preserve its ordering. Never expose
  private provider control markers in the transcript.
- Validate visible changes in the freshly rebuilt, signed app managed by the
  dev watcher against the exact provider interaction; a successful Rust build
  alone is insufficient.

## Checks

- `cargo fmt --package tide --package protocol --package client --package
  transport --package host --package backend -- --check`, then `cargo check`
  and `cargo test --locked` before opening a PR. Run the focused checks for
  your change first.
- `gpui`'s `test-support` feature is dev-dependency-only: it makes every
  `notify` pay a full frame, so it must never leak into a shipping build.

## Database

- Drizzle is a build-time tool only: `bun run db:generate` diffs
  `db/schema.ts` into plain SQL under `db/migrations`, which the Rust app
  applies at startup. `drizzle-orm` never ships in the binary — Rust owns
  every query.

## Localization

- UI strings live in `locales/{app,ja,zh-CN}.yml`, compiled in via
  `rust-i18n`; locale selection lives in `crates/protocol/src/i18n.rs`. The
  dev watcher rebuilds on `locales/` changes.

## Performance

- Treat performance as a product requirement, not a follow-up. Tide is a
  native app competing with web clients, and staying smooth under a long
  transcript on a high-refresh display is the point of being native. Prefer
  the faster design when it costs nothing in clarity, and measure before
  assuming a cost is fine.
- Never block the UI thread with heavy work. Rendering owns it, so anything a
  frame can reach must already be in memory: no subprocess spawns, no
  filesystem walks, no network, no blocking locks, no synchronous IPC.
- Row builders and measurement paths run for every visible item on every
  frame. Treat I/O reached from `render` as a defect even when it looks cheap,
  is cached after the first hit, or only triggers for some rows — one `git`
  invocation is already several frames of budget.
- Move the work to `cx.background_executor().spawn`, store the result on the
  entity, and `cx.notify()` when it lands. Render then reads only that store,
  and a miss means "not known yet" and must degrade gracefully.
- Resolve a whole session or collection in one background pass instead of
  probing per item, and guard it with a generation counter so a result from a
  superseded pass cannot overwrite newer state.
- One-shot user actions such as a click or menu command may work synchronously
  when freshness matters more than latency; frames may not.
- Keep per-frame work proportional to what is on screen. Long collections are
  virtualized with `list()`, and a row builder must not rebuild whole-session
  state; hoist that to a cache refreshed once per frame.
- Streaming CPU is governed by two cadences — stream commits at ≤ ~8.3 Hz and
  pulse-clock ticks at ≤ ~30 Hz — and by what one frame can see. Measure with
  counters before and after touching the event pump, the pulse clock
  (`src/ui/motion.rs`), veils, overlay scrollbars, pane caching, or anything
  else a streaming frame reaches.

## Accessibility

- Treat accessibility as a product requirement too. GPUI does not yet expose a
  screen-reader tree, so here it means keyboard operability, honored system
  settings, and legibility — none of which depend on that missing API, and all
  of which regress silently if left unchecked.
- Every control reachable by mouse must be reachable and operable by keyboard.
  Use `track_focus` with `tab_index`, `tab_group`, and `tab_stop`, give focus
  a visible treatment via `focus_visible`, and support the conventional keys
  for the widget (arrows, `home`/`end`, `enter`/`space`, `escape`).
- Honor the system's reduce-motion setting. `with_animation` already respects
  `App::reduce_motion`, but a direct `window.request_animation_frame` for
  decorative motion must check `cx.reduce_motion()` and skip the request.
- Never encode meaning in color, hover, or motion alone. Pair a status color
  with an icon or text, and make sure anything revealed on hover is also
  reachable by keyboard focus.
- Keep text and icons legible against their surface in both themes, and give
  interactive targets enough hit area — extend the hit region rather than
  shrinking to the glyph.

## GPUI reference

- Tide builds against the `egoist/zed` fork, branch `waku-webview` (upstream
  main plus PR #61945, layered scene rendering for compositing menus and
  tooltips above the browser's native web view). Read its crates at the
  revision pinned in `Cargo.toml`, not upstream `main` — APIs must match what
  Tide builds against. Read Zed's crates rather than `gpui-component`.
- Use Zed as the reference for GPUI implementation questions — layout and
  styling idioms, focus and key dispatch, virtualized lists, menus and
  popovers, window and platform behavior — or when an in-house `src/ui`
  primitive needs a proven native precedent.

## Repo etiquette

- Open an issue and discuss before starting anything larger than a bug fix.
- PR descriptions explain the problem and solution, list the checks run, and
  link the related issue.
- Releases are cut with `bun run release` (see RELEASING.md).
