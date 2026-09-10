# Agentic Browser + Device Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the right-panel browser an agent-controllable surface — eight `browser_*` tools over an in-process `BrowserBackend` seam — and add a Chrome DevTools-style device mode with free viewport sizing, per the validated design.

**Architecture:** A `BrowserBackend` trait + process-wide slot in `crates/tools` (exact mirror of `ComputerBackend`), installed at app boot by the UI — not the backend crate — because the webviews are GPUI entities. The UI impl holds the `Deferred` trio (`ForegroundExecutor` + `AsyncApp` + `WeakEntity<Tide>`, browser.rs:1241) and hops every op to the main thread; the engine thread blocks on an mpsc reply with a timeout. DOM interaction rides one injected JS serializer (`__tideSnapshot` / `__tideAct` / `__tideSettle`) returning JSON strings; native code does only script eval, screenshots, and viewport pinning. Auto-open with no active surface reuses the pending-URL + `open_right_panel_surface` path (no `Window` needed, right_panel.rs:2150) — the surface renderer creates the view.

**Tech Stack:** Rust (GPUI, wry 0.56 + objc2-web-kit on macOS, webview2-com on Windows), TypeScript-flavored JS for the serializer tested with `bun test` + linkedom, `image` 0.25 (already a dep, Cargo.toml:69) for PNG encode, `cargo test -p tide` / `cargo test -p tools`.

**Design doc:** `docs/plans/2026-09-10-agentic-browser-design.md` — read first; its Decisions section is normative (v1 limits: no touch emulation, no DSF, top-frame DOM only, http/https only, single surface, Linux unavailable).

---

## Conventions

- `cargo test -p tools` and `cargo test -p tide` green before each commit; one task = one commit (`feat(browser-agent): …`).
- Allowed edit points: `src/browser.rs` (additive agent methods/fields), new files `src/browser_agent.rs` + `src/browser_agent.js` + `src/app/browser_bridge.rs`, the tools crate files named per task, and the additive registration lines (`core_tools`, `risk_tier_for`, `tools/mod.rs`, `lib.rs` re-exports). Never restructure the wry/WebView2 host blocks beyond the named insertions.
- Threading contract: `BrowserBackend::invoke` runs on the engine thread and MAY block on `std::sync::mpsc::Receiver::recv_timeout`; nothing on the main thread may block on the engine while a browser op is in flight. All replies cross threads as `String` (JSON) through an mpsc `Sender` — never pass GPUI handles back.
- GPUI idioms: main-thread work goes through the `Deferred` hop (browser.rs:1252-1260), never a raw entity update from a delegate callback. Toolbar controls mutate state only — no I/O in render paths (AGENTS.md).
- The serializer's only interface is JSON strings: every `__tide*` function returns what `JSON.stringify` produces. WKWebView's `evaluateJavaScript` and WebView2's `ExecuteScriptWithCallback` both hand back one JSON-encoded string; no NSObject conversion anywhere.
- New toolbar strings use `tr!` + entries in `locales/` (follow the existing browser keys).

---

## Task 1: The `BrowserBackend` seam

**Files:** Create `crates/tools/src/tools/browser.rs`. Edit `crates/tools/src/tools/mod.rs` (decl + re-export) and `crates/tools/src/lib.rs` (re-export beside computer at :43).

**Step 1 — failing tests** (in browser.rs, mirroring computer.rs:52-69):
```rust
#[test] fn shared_backend_round_trips()  // install → enabled()/invoke() echo → clear → None
#[test] fn invoke_error_propagates()     // Err(String) crosses the seam unchanged
```

**Step 2 — implement** by copying `computer.rs`'s shape exactly (`crates/tools/src/tools/computer.rs:16-44`): `pub trait BrowserBackend: Debug + Send + Sync { fn enabled(&self) -> bool; fn invoke(&self, request: &Value) -> Result<Value, String>; }`, `static SHARED_BACKEND: RwLock<Option<Arc<dyn BrowserBackend>>>`, `set_shared_browser_backend` / `shared_browser_backend`. No `enabled` gating source exists yet — the UI impl always reports `true`; the settings toggle is deliberately out of scope (design v1).

**Step 3 — commit:** `feat(browser-agent): browser backend seam`

## Task 2: The serializer — `__tideSnapshot`

**Files:** Create `src/browser_agent.js`, `src/browser_agent.test.ts`, fixtures under `src/browser_agent_fixtures/`. Edit `package.json` (add `"test:agent": "bun test src/"`; add `linkedom` devDependency).

**Step 1 — failing tests.** Golden-file tests over fixture DOMs parsed with linkedom: a login-form fixture → the design doc's exact tree shape (`ref`/`role`/`name`, `value` for textboxes, `level` for headings); a hostile fixture (aria-hidden, `display:none`, zero-size, deep nesting past 12, >300 nodes) → skipped/capped with `truncated: true`; name-resolution order (aria-label → alt/placeholder → innerText trimmed to 80 chars); ref format `s<n>e<m>` unique within a snapshot; `__tideSnapshot()` output parses as JSON with `{url, title, viewport, ready, tree, truncated}`.

**Step 2 — implement** `__tideSnapshot()` in `src/browser_agent.js`:
- Role derivation from tag + ARIA: `a[href]→link`, `button|role=button→button`, `input/textarea|[role=textbox]→textbox`, checkbox/radio/combobox/heading (h1-h6 or role)/img/list/listitem/navigation/text — the design's fixed set; unknown tags with semantic descendants are transparent containers.
- `window.__tideRefs = new Map()` (ref → Element), rebuilt per snapshot; snapshot counter `window.__tideSerial`.
- Caps as constants (`MAX_NODES=300`, `MAX_DEPTH=12`, `MAX_NAME=80`) exported for the Rust side to document.

**Step 3 — commit:** `feat(browser-agent): ref-tree snapshot serializer`

## Task 3: BrowserView agent primitives (macOS)

**Files:** `src/browser.rs` only. Declare `mod browser_agent;` where the sibling modules live (src/lib.rs).

**Step 1 — failing tests** for the pure pieces:
```rust
#[test] fn load_generation_advances_on_finish()  // page_load_changed(Started) twice then (Finished): generation == 1, queued ops drain once
#[test] fn queued_agent_ops_wait_for_load()      // op queued while loading runs on Finished, not before
```

**Step 2 — implement:**
- `BrowserView` fields (additive, after `snapshot_epoch` at browser.rs:1299): `load_generation: u64`, `agent_queue: Vec<AgentOp>` where `AgentOp { script: String, reply: std::sync::mpsc::Sender<Result<String, String>> }`. In `page_load_changed` (browser.rs:1653-1663), the `PageLoad::Finished` arm bumps `load_generation` and drains `agent_queue` via `run_agent_script`.
- `pub fn agent_eval(&mut self, script: String, reply: Sender<...>, cx)`: if `self.loading` → push to queue; else `run_agent_script`. `run_agent_script` evaluates via new `WebviewHost::evaluate_json` and sends the reply through the `Deferred` hop inside the completion — the pattern `request_snapshot` already uses (browser.rs:1845-1876).
- `WebviewHost::evaluate_json(&self, script: &str, done: Box<dyn FnOnce(String) + Send>)`: `host.wk().evaluateJavaScript_completionHandler(script, …)`; result is the serializer's JSON string. (objc2-web-kit 0.3.2, already a dep, Cargo.toml:115.)
- `pub fn agent_screenshot(&mut self, reply: …, cx)`: `takeSnapshotWithConfiguration_completionHandler` (browser.rs:1858) → `snapshot_render_image` → `image::RgbaImage` → PNG bytes → base64 via the `image` crate (Cargo.toml:69). Fails cleanly when `host` is `None`.
- Injection: add `.with_initialization_script(BROWSER_AGENT_JS)` to the wry builder chain (browser.rs:1461-1480); `BROWSER_AGENT_JS = include_str!("browser_agent.js")`. Chromeless twins get it too — harmless, they never call it.

**Step 3 — commit:** `feat(browser-agent): eval-with-result, screenshot, load waiters on macOS`

## Task 4: App-side backend + the read tools (vertical slice)

**Files:** Create `src/app/browser_bridge.rs`. Edit `src/app.rs` (install at `Tide` boot + `mod browser_bridge;`), `crates/tools/src/tools/browser_tools.rs` (new), plus registration in `crates/tools/src/lib.rs` and `crates/tools/src/permission/mod.rs`.

**Step 1 — failing tests:**
- tools crate: `browser_call` with no backend → `ToolOutcome::failed("Browser tools are not available…")`; with a stub backend → request JSON carries `{op, args}` and the response text passes through; registry test (lib.rs:404-470) updated with `browser_navigate`, `browser_get_state`, `browser_screenshot` after `scroll`, tiers asserted via `risk_tier_for`.
- bridge (pure parts): `is_agent_url(&str) -> bool` (http/https only); `viewport_of(&Value)` extraction.

**Step 2 — implement:**
- `AppBrowserBackend { executor: ForegroundExecutor, cx: AsyncApp, tide: WeakEntity<Tide> }` — the `Deferred` trio with `Tide` instead of `BrowserView`. `invoke` spawns on the executor: `tide.update(&mut cx, |tide, cx| route_browser_op(tide, cx, request, reply_tx))`, then the engine thread `recv_timeout`s (20 s navigate / 10 s otherwise).
- `route_browser_op` (in browser_bridge.rs, `impl Tide` block like right_panel.rs): find the active browser — the last `RightPanelSurface::Browser(id)` in `right_panel_surfaces` with an entity in `right_panel_browsers`; if none, `right_panel_pending_browser_urls.insert(agent_id, url)` + `open_right_panel_surface(Browser(agent_id), cx)` (right_panel.rs:2150 — no `Window` needed; the surface renderer creates the view, right_panel.rs:2655) and the op rides `agent_queue` until the view exists (re-enqueue on a `pending_agent_ops` map keyed by browser id, drained from `navigate_pending_browser_url`). Then `browser.update(cx, |view, cx| …)` dispatches: `navigate` → the existing `load_url` path (browser.rs:1722-1740) + queue the get-state follow-up; `get_state` → `agent_eval("__tideSnapshot()")`; `screenshot` → `agent_screenshot`.
- `browser_tools.rs`: `browser_call(op, args)` mirroring `computer_call` (computer_tools.rs:21-44) — backend lookup, `enabled()` check, invoke, `render_response` (text passthrough; screenshot wraps base64 in `ToolDisplay::Media` like render_kit_response at computer_tools.rs:46-105).
- Tiers in `permission/mod.rs:115` match: `browser_get_state | browser_screenshot => ReadOnly`; `browser_navigate => Write`. `concurrency_for` (lib.rs:~382): deliberately NOT added to the Parallel list — every browser op serializes on the one surface; default Exclusive is correct.
- Install in `Tide` construction (src/app.rs, where `cx.to_async()` is first available — same place the computer-use PiP state initializes): `tools::set_shared_browser_backend(Some(Arc::new(AppBrowserBackend { … })))`. Linux: skip install (calls fail cleanly per Task 4's no-backend test).

**Step 3 — commit:** `feat(browser-agent): navigate/get_state/screenshot end-to-end`

## Task 5: Actions — click, type, press_key, scroll + settle + staleness

**Files:** `src/browser_agent.js` (+tests), `crates/tools/src/tools/browser_tools.rs`, `src/app/browser_bridge.rs`.

**Step 1 — failing tests:**
- JS: click on a button fixture fires pointerdown→mousedown→pointerup→mouseup→click in order; typing into a `value`-input dispatches `input`+`change` with the full text (native-setter path when `insertText` unavailable on linkedom); typing into a `[contenteditable]`; Enter submission (`submit:true` dispatches keydown Enter + form submit); staleness — snapshot, then remove the element → `{ok:false, stale:true}`; rename the element (role matches, name differs) → stale; `__tideSettle(300)` resolves after a MutationObserver-quiet window even when mutations precede it.
- Rust: stale-shaped `render_response` → `ToolOutcome::failed("The page changed under you — call browser_get_state again…")` verbatim; tool specs for the four new tools.

**Step 2 — implement** `__tideAct(ref, action, payload)` in browser_agent.js:
- Resolve ref from `__tideRefs`; verify `isConnected` AND role+name match the snapshot record (store the pair in the map) → else the stale shape.
- click: `scrollIntoView({block:"center"})` then the full pointer/mouse sequence (never `.click()`).
- type: focus, select-all, per-char `document.execCommand("insertText")`, fallback to the prototype native setter + `input` event (React-safe); optional Enter.
- press_key: KeyboardEvent synthesis for the xdotool-style names the tool accepts (Enter/Tab/Up/…/modifiers).
- scroll: `window.scrollBy` (viewport) or element scroll for ref'd scrollables, page-fraction amounts.
- Rust: four tools in `browser_tools.rs` (all `Write`), `route_browser_op` arms calling `agent_eval("__tideAct(…)")` followed by `__tideSettle(400)` chained in the one eval (single round trip); unknown refs surface the stale message from Step 1 verbatim.

**Step 3 — commit:** `feat(browser-agent): click/type/press_key/scroll with settle and staleness`

## Task 6: WebView2 parity

**Files:** `src/browser.rs` (Windows host block, :440-800).

**Step 1 — failing tests:** pure response-shaping (`ExecuteScriptWithCallback` returns a JSON string of a JSON string — double-decode helper `unwrap_execute_script_result(&str) -> &str` with tests for both quoted and bare results).

**Step 2 — implement:**
- `Webview::evaluate_script_with_callback` beside the fire-and-forget `evaluate_script` (browser.rs:666) using `ExecuteScriptWithCallback` + the existing event hop (:513); route `agent_eval`/`run_agent_script` through it on Windows (cfg split like `request_snapshot` at :1845/:1883).
- Injection: `AddScriptToExecuteOnDocumentCreatedAsync(BROWSER_AGENT_JS)` at controller creation (~:1576); verify `page_load_changed` already fires `Finished` from `NavigationCompleted` (:1576-1590) — the waiter queue needs no Windows-specific code.
- `agent_screenshot`: `CapturePreview` → stream → PNG bytes (webview2-com `CALLBACK` pattern from the controller events). Replaces the `#[cfg(not(macos))]` stub at browser.rs:1883 for the agent path only — the occlusion freeze stays macOS-only.
- Manual QA on Windows (no CI): navigate/get_state/screenshot + one click/type pass over the Task 5 fixtures served from `python3 -m http.server`.

**Step 3 — commit:** `feat(browser-agent): webview2 parity for eval, injection, capture`

## Task 7: Device mode core + `browser_set_viewport`

**Files:** `src/browser.rs`, `src/app/browser_bridge.rs`, `crates/tools/src/tools/browser_tools.rs`.

**Step 1 — failing tests:**
```rust
#[test] fn pinned_bounds_center_in_panel() {
    // pinned_bounds(panel: Size, device: DeviceViewport) -> Bounds<Pixels>
    // 1280x800 device in a 1500x900 panel -> 110px side margins, 50px vertical, exact 1280x800
    // device larger than panel -> clamped to panel, never negative origin
}
#[test] fn device_mode_defaults_and_toggle() // pure state fns: off -> fills panel; set(390,844) -> Some; clear -> None
```

**Step 2 — implement:**
- `DeviceViewport { width: u32, height: u32 }` + `device_mode: Option<DeviceViewport>` on `BrowserView`. The per-frame bounds computation feeding `sync_bounds` (browser.rs:375) routes through `pinned_bounds`; the area outside the pinned frame renders the dimmed backdrop + `w × h` readout (state-only render — no I/O). The webview is sized in points/DIPs on both platforms so CSS px matches (scale factor already handled at :384/:777).
- Toolbar (non-chromeless only): device toggle button after reload; when on — preset dropdown, width/height number fields, edge drag handle (whole-pixel snap). `tr!` + locale entries for every label.
- `browser_set_viewport(w, h)` tool (Write): `route_browser_op` arm → `browser.update` sets `device_mode = Some(...)`; the toolbar toggle reflects it automatically (shared state, the design's one-source rule). Also add to the registry test list.

**Step 3 — commit:** `feat(browser): device-mode viewport pinning + set_viewport tool`

## Task 8: Presets, UA override, persistence

**Files:** `src/browser.rs`, `crates/backend/src/persistence.rs`, `src/app/browser_bridge.rs`.

**Step 1 — failing tests:** preset table (`preset("iphone") -> Some((390, 844, Some(MOBILE_UA)))` etc. for the five design presets; `preset("nope") -> None`); settings serde (`AppSettings` with `browser_viewport: None` round-trips; old files without the key decode via `#[serde(default)]`).

**Step 2 — implement:**
- Preset list + mobile UA strings in browser.rs; picking a mobile preset sets the UA — macOS `wk().setCustomUserAgent` (overrides the Safari-mirror default at browser.rs:47), Windows the profile-level UA override via webview2-com; clearing device mode or choosing a desktop preset restores the default UA.
- Persistence: `browser_viewport: Option<BrowserViewportPrefs { width, height }>` on `AppSettings` (persistence.rs:189, `#[serde(default)]`), plumbed through the same snapshot/save path `analytics_enabled` uses; applied to the first `BrowserView` at creation and saved when the user (not the agent) changes it.
- Registry/test polish: final `core_tools` order matches the design's tool table; every browser tool listed once.

**Step 3 — commit:** `feat(browser): device presets with UA override and persistence`

---

## Verification checklist (every task; full sweep at Task 8)

- `cargo test -p tools && cargo test -p tide` green; `bun run test:agent` green (Tasks 2+).
- Manual per milestone: 1–2 macOS end-to-end (agent navigates to a local fixture server, snapshots, screenshots); 5 actions incl. a React SPA and an `isTrusted`-filtering page (expect the documented limit); 6 Windows pass; 7–8 drag/preset/agent-set interplay.
- Deadlock smoke: a browser tool while a permission card is pending must not freeze the UI (engine thread blocks, main thread stays live).
- Linux build: `cargo check` — tools present, calls return the clean unavailable outcome.

## Out of scope (do not build)

Touch-event synthesis, device-scale-factor emulation, cross-origin iframe access, multi-tab sessions, find-in-page, history/bookmarks, a settings toggle for the tools — all v2 per the design doc.
