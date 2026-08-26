import { useRef, useEffect, useMemo, memo, useState } from 'react';
import { Terminal as TerminalIcon, Plus, X } from 'lucide-react';
import type { Terminal as GhosttyTerminal, ILink } from 'ghostty-web';
import { useUi, terminalScopeKey } from '@/lib/stores/ui';
import {
  hasTerminalBackend,
  subscribeTerminalEvents,
  openExternal,
  showItemInFolder,
  terminalInput,
  terminalKill,
  terminalResize,
  terminalSnapshot,
  terminalStart,
  type TerminalSnapshot,
} from '@/lib/api/client';
import { getTerminalTheme } from '@/components/screens/settings/appearance';
import { measureTerminalContainer } from '@/lib/terminal-size';
import { Button } from '@/components/ui/button';
import { ScrollTabs, ScrollTabsList, ScrollTabsTrigger } from '@/components/ui/scroll-tabs';
import { Tip } from '@/components/ui/quick-tooltip';
import { cn, isMac } from '@/lib/utils';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';

// ── Lazy ghostty-web ────────────────────────────────────────────
// 638 KB of JS + the WASM VT would sit in the startup bundle for a panel the
// user may never open. Dynamic import keeps it in a lazy chunk; init() (WASM
// bootstrap) runs once, then the resolved module is cached module-level so
// terminal creation stays synchronous.
type GhosttyModule = typeof import('ghostty-web');
let ghosttyModule: GhosttyModule | null = null;
let ghosttyLoad: Promise<GhosttyModule> | null = null;
function loadGhostty(): Promise<GhosttyModule> {
  ghosttyLoad ??= import('ghostty-web').then(async (m) => {
    await m.init();
    ghosttyModule = m;
    return m;
  });
  return ghosttyLoad;
}

// ── Module-level terminal registry ──────────────────────────────
// xterm instances live OUTSIDE React's reconciliation. React provides a mount div; we imperatively create/destroy terminal canvases inside it. This guarantees terminals survive session switches — the DOM elements are never touched by React's diffing.

interface LiveTerminal {
  term: GhosttyTerminal;
  /** The wrapper div we created and passed to term.open(). Stored explicitly
   *  because ghostty-web sets `term.element` TO this wrapper (unlike xterm,
   *  which nested its own element inside it) — so term.element.parentElement
   *  would be the shared mount, not this terminal's wrapper. */
  wrapper: HTMLDivElement;
  inputDisposable: { dispose: () => void };
  resizeObserver: ResizeObserver;
}

const registry = new Map<string, LiveTerminal>();

// ── Output batching ──────────────────────────────────────────────
// PTY output arrives as many small IPC events (one per node-pty onData chunk). Writing each synchronously to xterm saturates the main thread on high-throughput output (cargo build, npm install, log floods) → UI freeze. Instead, buffer per-terminal and flush once per animation frame. Worst-case added latency: ~16ms (imperceptible); throughput is unchanged because the chunks concatenate into a single write.
const outputBuffers = new Map<string, string>();
const pendingFlushes = new Set<string>();

// ── Snapshot re-attach ──────────────────────────────────────────
// While a snapshot fetch is in flight, live output is PARKED (not queued);
// when the snapshot lands it is written first, then parked chunks with a
// newer seq replay. `lastSeq` dedupes anything the snapshot already
// contains — this is what makes a renderer reload non-destructive: the
// PTY lives in main, the terminal view is a disposable projection.
const snapshotPending = new Set<string>();
const parkedOutput = new Map<string, { seq: number; data: string }[]>();
const lastSeq = new Map<string, number>();

function flushTerminal(terminalId: string) {
  pendingFlushes.delete(terminalId);
  const buf = outputBuffers.get(terminalId);
  if (!buf) return;
  outputBuffers.delete(terminalId);
  const entry = registry.get(terminalId);
  if (entry) {
    try { entry.term.write(buf); } catch { /* disposed mid-flush */ }
  }
}

/** Queue a chunk for the terminal; schedules a single rAF flush. */
function queueOutput(terminalId: string, data: string) {
  outputBuffers.set(terminalId, (outputBuffers.get(terminalId) ?? "") + data);
  if (!pendingFlushes.has(terminalId)) {
    pendingFlushes.add(terminalId);
    requestAnimationFrame(() => flushTerminal(terminalId));
  }
}

// ── Fit ─────────────────────────────────────────────────────────
// ghostty-web's FitAddon hardcodes a 15px scrollbar gutter in
// proposeDimensions, but its scrollbar is an in-canvas overlay — the gutter
// is dead space on the right edge. Fit from the canvas's own cell metrics
// instead. Cell size MUST come from the CSS size: the bitmap (canvas.width)
// is scaled by devicePixelRatio (2× on retina), so deriving cells from it
// halves cols/rows and the canvas renders at a quarter of the panel.
function fitTerminal(term: GhosttyTerminal, wrapper: HTMLDivElement): { cols: number; rows: number } | null {
  const canvas = wrapper.querySelector('canvas');
  if (!canvas || term.cols === 0 || term.rows === 0) return null;
  const styleW = parseFloat(canvas.style.width);
  const styleH = parseFloat(canvas.style.height);
  const cssW = styleW > 0 ? styleW : canvas.width / (window.devicePixelRatio || 1);
  const cssH = styleH > 0 ? styleH : canvas.height / (window.devicePixelRatio || 1);
  const cellW = cssW / term.cols;
  const cellH = cssH / term.rows;
  if (!Number.isFinite(cellW) || cellW <= 0 || !Number.isFinite(cellH) || cellH <= 0) return null;
  const cols = Math.max(2, Math.floor(wrapper.clientWidth / cellW));
  const rows = Math.max(1, Math.floor(wrapper.clientHeight / cellH));
  if (cols !== term.cols || rows !== term.rows) {
    try { term.resize(cols, rows); } catch { /* disposed mid-fit */ }
  }
  return { cols, rows };
}

// ── Push-event listeners (registered at module scope) ────────────
// Each terminal's output/exit/ports events are routed by terminalId — the
// handlers look up the terminal instance in the module-level `registry` at
// event time (avoiding the per-terminal listener leak). Module scope, NOT
// component lifecycle: the panel fully unmounts whenever the right panel
// switches tabs, closes, or crosses the inline↔Sheet breakpoint.
// Component-scoped listeners would drop every PTY byte emitted while the
// panel was unmounted; the registry terms keep accepting writes (their
// scrollback lives in ghostty-web's WASM buffer, repainted on re-attach).
// Transport-agnostic: the Electrobun RPC bridge or the frozen Electron
// preload, whichever is present (client.ts picks).
subscribeTerminalEvents({
  onOutput: ({ terminalId, data, seq }: { terminalId: string; data: string; seq?: number }) => {
    // Snapshot in flight — park; the attach path replays newer chunks after
    // the snapshot lands.
    if (snapshotPending.has(terminalId)) {
      const list = parkedOutput.get(terminalId) ?? [];
      if (seq !== undefined) list.push({ seq, data });
      else list.push({ seq: Number.MAX_SAFE_INTEGER, data });
      parkedOutput.set(terminalId, list);
      return;
    }
    // Seq dedupe: chunks at or below the applied seq are already in the
    // snapshot — drop them.
    if (seq !== undefined) {
      if (seq <= (lastSeq.get(terminalId) ?? 0)) return;
      lastSeq.set(terminalId, seq);
    }
    // Batched flush (rAF) — see queueOutput. Keeps the UI responsive under
    // high-throughput PTY output instead of writing per-event.
    queueOutput(terminalId, data);
  },
  onExit: ({ terminalId, code }: { terminalId: string; code: number | null }) => {
    // Route through the same buffer so the exit line stays ordered after
    // any pending output (a direct write could land before buffered chunks).
    queueOutput(terminalId, `\r\n\x1b[31m[Process exited with code ${code}]\x1b[0m\r\n`);
  },
  onPorts: ({ terminalId, ports }: { terminalId: string; ports: { port: number; url: string; label: string }[] }) => {
    useUi.getState().setTerminalPorts(terminalId, ports);
  },
});

// ── File-path link provider ──────────────────────────────────────
// Detects absolute paths (and path:line / path:line:col) in terminal output and reveals them in the OS file manager on click. xterm calls provideLinks per visible line as the user hovers; we scan that line for path matches and return ILink objects with the buffer range + activate handler. Path pattern: an absolute POSIX path (starts with /) OR a Windows path (drive letter:\), optionally suffixed with :line and :col. We deliberately require a leading slash / drive to avoid matching arbitrary "foo:bar" text.
const PATH_PATTERN = /(?:\/[\w./@-]+|[A-Za-z]:\\[\w\\./-]+)(?::(\d+))?(?::(\d+))?/g;

class FilePathLinkProvider {
  private term: GhosttyTerminal;
  constructor(term: GhosttyTerminal) {
    this.term = term;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.term.buffer.active.getLine(bufferLineNumber);
    if (!line) { callback(undefined); return; }
    const text = line.translateToString(true);
    const links: ILink[] = [];
    let m: RegExpExecArray | null;
    PATH_PATTERN.lastIndex = 0;
    while ((m = PATH_PATTERN.exec(text)) !== null) {
      const path = m[0];
      // Filter obvious false positives: must have a slash/backslash beyond
      // the root, and be at least 3 chars ("/a" is too short to be useful).
      if (path.length < 3) continue;
      const x1 = m.index;
      const x2 = m.index + path.length - 1;
      links.push({
        range: {
          start: { x: x1 + 1, y: bufferLineNumber },
          end: { x: x2 + 1, y: bufferLineNumber },
        },
        text: path,
        activate: (event: MouseEvent) => {
          // VS Code-style: only open on modifier+click (Cmd on macOS, Ctrl
          // elsewhere) — a plain click just positions the cursor.
          const mod = isMac ? event.metaKey : event.ctrlKey;
          if (mod) showItemInFolder(path);
        },
      });
    }
    callback(links.length > 0 ? links : undefined);
  }
}

// ── URL link provider ─────────────────────────────────────────────
// Detects http(s) URLs and www. links in terminal output and opens them in
// the OS browser on modifier+click (replaces @xterm/addon-web-links, which
// isn't compatible with ghostty-web). Same VS Code-style modifier gate as
// the file-path provider above.
const URL_PATTERN = /(https?:\/\/[^\s<>"']+|www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"']*)/gi;

class UrlLinkProvider {
  private term: GhosttyTerminal;
  constructor(term: GhosttyTerminal) {
    this.term = term;
  }
  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.term.buffer.active.getLine(bufferLineNumber);
    if (!line) { callback(undefined); return; }
    const text = line.translateToString(true);
    const links: ILink[] = [];
    let m: RegExpExecArray | null;
    URL_PATTERN.lastIndex = 0;
    while ((m = URL_PATTERN.exec(text)) !== null) {
      const url = m[0];
      const x1 = m.index;
      const x2 = m.index + url.length - 1;
      links.push({
        range: {
          start: { x: x1 + 1, y: bufferLineNumber },
          end: { x: x2 + 1, y: bufferLineNumber },
        },
        text: url,
        activate: (event: MouseEvent) => {
          const mod = isMac ? event.metaKey : event.ctrlKey;
          if (mod) {
            const href = url.startsWith('http') ? url : `https://${url}`;
            openExternal(href);
          }
        },
      });
    }
    callback(links.length > 0 ? links : undefined);
  }
}

export const TerminalPanel = memo(function TerminalPanel() {
  // Draft-aware bucket key: terminals opened while composing belong to the
  // draft, and follow it into the session on promotion (adoptDraftTerminals).
  // Keying everything by session id here but 'default' there let one session's
  // draft-phase terminals reappear in every later new-session screen.
  const sessionId = useUi(terminalScopeKey);
  // MainScreen is always-mounted; the panel survives Settings visits (hidden,
  // zero-size box) as long as the terminal tab stays active. This flag
  // re-fits on return.
  const screenActive = useUi((s) => s.screen === "main");
  const closePanel = useUi((s) => s.toggleRightPanel);
  const terminalTheme = useUi((s) => s.terminalTheme);
  const terminalFontSize = useUi((s) => s.terminalFontSize);
  const allTerminals = useUi((s) => s.terminals);
  const terminals = allTerminals[sessionId] ?? [];
  const activeId = useUi((s) => s.activeTerminal[sessionId]);
  const addTerminal = useUi((s) => s.addTerminal);
  const closeTerminal = useUi((s) => s.closeTerminal);
  const setActiveTerminal = useUi((s) => s.setActiveTerminal);
  const renameTerminal = useUi((s) => s.renameTerminal);
  const mountRef = useRef<HTMLDivElement>(null);
  // Inline-rename state: the id of the tab whose title is being edited, plus
  // the working text. Entered by double-clicking a tab title; committed on
  // Enter/blur, cancelled on Escape.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const commitRename = (id: string) => {
    const trimmed = draftName.trim();
    if (trimmed) renameTerminal(sessionId, id, trimmed);
    setEditingId(null);
  };

  const active = activeId && terminals.some((t) => t.id === activeId) ? activeId : terminals[0]?.id;

  // ghostty-web (and its WASM) loads lazily on first panel mount — see
  // loadGhostty. Terminal creation is gated on the resolved module so the
  // first open doesn't race the WASM init.
  const [ghosttyReady, setGhosttyReady] = useState(false);
  useEffect(() => {
    let alive = true;
    loadGhostty().then(() => { if (alive) setGhosttyReady(true); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // The ACTIVE session's terminals — only these get xterm instances created
  // and shown. Switching sessions must NOT destroy the previous session's
  // terminals (that loses scrollback + kills their PTYs); it should just hide
  // them and let the new session's terminals show.
  const allEntries = useMemo(
    () => (allTerminals[sessionId] ?? []).map((t) => ({
      sessionId,
      terminalId: t.id,
      name: t.name,
    })),
    [allTerminals, sessionId],
  );
  // IDs of terminals that should SURVIVE — every session's, not just the
  // active one. The dispose loop uses this so switching sessions hides the
  // old session's terminals instead of killing them. Only terminals removed
  // from the store entirely (tab closed / session deleted) get killed.
  const survivingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const list of Object.values(allTerminals)) {
      for (const t of list) ids.add(t.id);
    }
    return ids;
  }, [allTerminals]);
  const activeSessionIds = useMemo(
    () => new Set(allEntries.map((e) => e.terminalId)),
    [allEntries],
  );

  // Tracks which terminal we last focused. We only refocus when the active
  // id actually CHANGES — calling focus() on every effect run would steal
  // focus from the user mid-keystroke whenever MainScreen re-renders.
  const prevActiveRef = useRef<string | null | undefined>(undefined);

  // ── IPC listeners live at module scope (see top of file) ──────────

  // Sync the registry with the store. Only runs when the terminal id set
  // or the active id actually changes — NOT on every parent re-render.
  // (terminalTheme/terminalFontSize are handled by a separate effect that
  // updates existing terminals in place via term.options — see below.)
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !hasTerminalBackend() || !ghosttyReady || !ghosttyModule) return;

    let createdActive = false;

    // ── Create terminals that don't exist yet ──
    for (const { sessionId: sid, terminalId: tid } of allEntries) {
      const existing = registry.get(tid);
      if (existing) {
        // Re-attach: the panel unmounts entirely when the right panel
        // switches tabs, closes, or crosses the inline↔Sheet breakpoint —
        // React removed the old mount div, taking the wrapper (and its
        // canvas) into a detached tree. Move the SAME wrapper into the
        // fresh mount: term identity, scrollback, and the PTY are all
        // untouched; forceRedraw below repaints the canvas.
        if (existing.wrapper.parentElement !== mount) {
          mount.appendChild(existing.wrapper);
          if (tid === active) createdActive = true;
        }
        continue;
      }

      const themeColors = getTerminalTheme(terminalTheme);
      const fontFamily = "'MesloLGS NF', 'MesloLGS Nerd Font', 'JetBrains Mono', Menlo, monospace";
      // Provisional size from font metrics — the PTY spawns at the right
      // dimensions while the emulator still initializes (no 80x24 flash).
      const provisional = measureTerminalContainer(mount, terminalFontSize, fontFamily);

      const term = new ghosttyModule.Terminal({
        cursorBlink: true,
        fontSize: terminalFontSize,
        fontFamily,
        theme: themeColors as any,
        ...(provisional ?? {}),
      });

      // Create a wrapper div INSIDE the mount. ghostty-web renders a canvas
      // into this. We manage this div imperatively — React never touches it.
      const wrapper = document.createElement('div');
      // caret-color:transparent — ghostty-web sets contenteditable="true" on
      // this element so it can receive IME/composition input, which makes the
      // browser paint a native DOM caret. ghostty ALSO draws its own VT block
      // cursor on the canvas (renderCursor) → two cursors. Hiding the caret
      // here keeps only the canvas one without disabling the editable input.
      wrapper.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;caret-color:transparent;';
      wrapper.dataset.terminalId = tid;
      mount.appendChild(wrapper);
      term.open(wrapper);
      fitTerminal(term, wrapper);

      // Link providers — ghostty-web has no WebLinksAddon equivalent, so we
      // register two providers: URLs (open in OS browser on modifier+click,
      // replacing @xterm/addon-web-links) and file paths (path:line:col →
      // reveal in OS file manager). Registered per-terminal; called per line
      // as the user hovers.
      term.registerLinkProvider(new UrlLinkProvider(term));
      term.registerLinkProvider(new FilePathLinkProvider(term));

      // Attach to the PTY. Snapshot FIRST: after a renderer reload the PTY
      // (and its scrollback) is still alive in main — replay it instead of
      // killing and respawning the shell. Only spawn when nothing is there.
      // pendingCommand is flushed on both paths once the PTY exists.
      const flushPending = () => {
        const state = useUi.getState();
        const inst = state.terminals[sid]?.find((t) => t.id === tid);
        const cmd = inst?.pendingCommand;
        if (cmd) {
          terminalInput(tid, cmd + '\r');
          // Clear it so the command doesn't re-fire if the terminal is
          // somehow re-spawned later (e.g., after dispose + recreate).
          useUi.setState((s) => ({
            terminals: {
              ...s.terminals,
              [sid]: (s.terminals[sid] ?? []).map((t) =>
                t.id === tid ? { ...t, pendingCommand: undefined } : t,
              ),
            },
          }));
        }
      };
      const attach = async () => {
        snapshotPending.add(tid);
        let snap: TerminalSnapshot | undefined;
        try {
          snap = await terminalSnapshot(tid);
        } catch { /* fall through to spawn */ }
        if (snap && snap.alive) {
          try { term.write(snap.data); } catch { /* disposed mid-attach */ }
          lastSeq.set(tid, snap.seq);
          const parked = parkedOutput.get(tid) ?? [];
          parkedOutput.delete(tid);
          snapshotPending.delete(tid);
          for (const p of parked) {
            if (p.seq <= snap.seq) continue;
            lastSeq.set(tid, p.seq);
            queueOutput(tid, p.data);
          }
          // The reloaded view may size differently than the pre-reload
          // renderer — bring the PTY to the current dimensions.
          try { terminalResize(tid, term.cols, term.rows); } catch { /* */ }
          flushPending();
          return;
        }
        snapshotPending.delete(tid);
        parkedOutput.delete(tid);
        await terminalStart(tid, sid, provisional ?? undefined);
        flushPending();
      };
      void attach();

      // PTY → terminal: push-event handlers are registered ONCE at module
      // scope (see subscribeTerminalEvents above) — they look up the
      // terminal by id at event time. Previously each terminal creation
      // added new listeners, causing a MaxListenersExceeded leak after
      // ~11 terminals.

      // terminal → PTY
      const inputDisposable = term.onData((data: string) => {
        terminalInput(tid, data);
      });

      // Resize
      const resizeObserver = new ResizeObserver(() => {
        // Skip 0×0 boxes (panel hidden, or the wrapper's tree detached
        // during an unmount window) — fitting there clears the canvas
        // bitmap for nothing; the re-attach/forceRedraw path repaints.
        if (wrapper.clientWidth === 0 || wrapper.clientHeight === 0) return;
        try { fitTerminal(term, wrapper); terminalResize(tid, term.cols, term.rows); } catch { /* */ }
      });
      resizeObserver.observe(wrapper);

      registry.set(tid, { term, wrapper, inputDisposable, resizeObserver });
      if (tid === active) createdActive = true;
    }

    // ── Dispose terminals truly removed from the store (tab closed / session
    //    deleted). Uses survivingIds (ALL sessions) so switching sessions does
    //    NOT kill the previous session's terminals — only ones removed from
    //    every session are torn down. ──
    for (const [tid, live] of registry) {
      if (survivingIds.has(tid)) continue;
      // Drain any buffered output first so nothing is lost, then tear down.
      flushTerminal(tid);
      live.inputDisposable.dispose();
      live.resizeObserver.disconnect();
      terminalKill(tid);
      snapshotPending.delete(tid);
      parkedOutput.delete(tid);
      lastSeq.delete(tid);
      // ghostty-web's dispose() clears `term.element` (=== wrapper) to void 0,
      // so capture the wrapper div BEFORE dispose to remove it from the mount.
      const wrapper = live.wrapper;
      live.term.dispose();
      wrapper.remove();
      registry.delete(tid);
    }

    // ── Visibility toggle ──
    // Terminals in the ACTIVE session are candidates to show; everything else (other sessions' terminals still alive in the registry) is hidden. Only refocus / refit when the active id actually changed, or when the active terminal was just created — calling focus() on every effect run is what caused the "can't type" + flicker symptoms.
    const activeChanged = active !== prevActiveRef.current;
    for (const [tid, live] of registry) {
      const wrapper = live.wrapper;
      // Belongs to the active session AND is the active terminal → visible.
      // (activeSessionIds = the active session's terminal IDs.)
      const isVisible = activeSessionIds.has(tid) && tid === active;
      // IMPORTANT: toggle visibility, NOT display. ghostty-web renders to a
      // <canvas>; hiding via display:none zero-sizes the wrapper, the
      // ResizeObserver fires fit() against a 0×0 box, the canvas is resized
      // (which CLEARS its bitmap), and on re-show the dirty state doesn't
      // force a full redraw → blank terminal + a cursor glitching at (0,0).
      // visibility:hidden keeps the wrapper laid out (non-zero) so the canvas
      // bitmap + cursor state survive tab switches; pointer-events:none makes
      // sure the inactive terminal can't capture the keyboard/mouse.
      wrapper.style.visibility = isVisible ? 'visible' : 'hidden';
      wrapper.style.pointerEvents = isVisible ? '' : 'none';
      if (isVisible && (activeChanged || createdActive)) {
        // forceRedraw (not bare fit()): fit() early-returns when the size
        // hasn't changed, so on session switchback — where the panel is the
        // same size as before it was hidden — no redraw fires and the canvas
        // shows whatever was last composited (blank). forceRedraw re-asserts
        // the current size, pushing ghostty-web through a full re-render.
        forceRedraw(live);
      }
    }
    prevActiveRef.current = active;
  }, [allEntries, activeSessionIds, survivingIds, active, ghosttyReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme / font-size updates: apply to EXISTING terminals in place via
  // term.options rather than recreating them. Keeps scrollback + PTY state.
  useEffect(() => {
    const themeColors = getTerminalTheme(terminalTheme);
    for (const { term } of registry.values()) {
      try {
        term.options.fontSize = terminalFontSize;
        // xterm.js needs the theme object reassigned to redraw.
        term.options.theme = themeColors as any;
      } catch { /* */ }
    }
  }, [terminalTheme, terminalFontSize]);

  // Refit on mount/re-attach OR on screen return. The panel lives in the
  // right panel's terminal tab — it unmounts on tab switch/close (the
  // registry terms survive; see the re-attach path in the sync effect) and
  // its box measures zero-size while MainScreen is hidden for Settings.
  // Either way the last fit() ran against stale/pre-hide dimensions, so on
  // (re)mount and Settings return, refit + refocus + force a redraw so the
  // canvas matches the visible size. The redraw matters: fit() early-returns
  // when the size hasn't changed, so without it the bitmap is blank until
  // the next PTY data arrives.
  const forceRedraw = (live: LiveTerminal | undefined) => {
    if (!live) return;
    try {
      // Re-asserting the current size forces ghostty-web's renderer to do a
      // FULL re-render (it clears the dirty rows + redraws). A real fit() is
      // attempted first so layout-driven resizes still propagate.
      fitTerminal(live.term, live.wrapper);
      const t = live.term;
      t.resize(t.cols, t.rows);
      t.focus();
    } catch { /* */ }
  };
  useEffect(() => {
    if (!screenActive) return;
    if (!active) return;
    const entry = registry.get(active);
    if (!entry) return;
    // Defer one tick so the browser has laid out the (re)attached wrapper
    // and it has real dimensions again.
    const raf = requestAnimationFrame(() => forceRedraw(entry));
    return () => cancelAnimationFrame(raf);
  }, [screenActive, active]);

  // Redraw on app focus / window visibility regain. ghostty-web drives its
  // canvas via a requestAnimationFrame loop, which the browser PAUSES while the
  // document is hidden (OS app switch, minimize, alt-tab). On return, rAF
  // resumes but there's no forced full redraw — the canvas shows whatever was
  // last composited (often blank/stale) until fresh PTY data dirties rows.
  // visibilitychange fires on minimize/restore + tab-hide; the window 'focus'
  // event catches alt-tab return on macOS where the document never fully hides.
  useEffect(() => {
    if (!active) return;
    const redraw = () => {
      if (document.visibilityState === 'hidden') return;
      forceRedraw(registry.get(active));
    };
    document.addEventListener('visibilitychange', redraw);
    window.addEventListener('focus', redraw);
    return () => {
      document.removeEventListener('visibilitychange', redraw);
      window.removeEventListener('focus', redraw);
    };
  }, [active]);

  const items = terminals.map((t) => ({
    id: t.id,
    label: t.name,
    icon: <TerminalIcon className="size-3" />,
  }));

  return (
    <div className="flex h-full w-full flex-col">
      <ScrollTabs
        value={active ?? ''}
        onValueChange={(id) => setActiveTerminal(sessionId, id)}
        orientation="horizontal"
        className="flex-col gap-0"
      >
        <ScrollTabsList
          onDoubleClick={(e) => {
            // Double-click EMPTY space on the tab bar → new tab. Only the bare
            // list background counts: the target must be the list (role=tablist)
            // itself or the inner scroll wrapper, NOT a tab, chevron, or +/-.
            // We check ancestors for [role=tab] (a tab trigger) or <button>
            // (chevrons + trailing actions) AND require the target to not be
            // inside interactive content. This also avoids the drag-scroll's
            // pointer-capture path: a genuine double-click on empty space
            // doesn't move the strip, so handleClickCapture never suppresses it.
            const target = e.target as HTMLElement;
            if (target.closest('[role="tab"], button, input, [role="button"]')) return;
            addTerminal(sessionId);
          }}
          trailing={
            // New-terminal + close-panel actions. Live in the trailing
            // slot so they stay visible regardless of tab-strip overflow.
            <div className="flex items-center gap-0.5 pr-1 flex-none">
              <Tip label="New terminal" side="bottom">
                <Button
                  variant="ghost"
                  size={'icon-xs'}
                  onClick={() => addTerminal(sessionId)}
                  className="text-muted-foreground/60 hover:text-foreground p-1 rounded hover:bg-card/40 flex-shrink-0"
                >
                  <Plus className="size-3.5" />
                </Button>
              </Tip>
              <Tip label="Close panel" side="bottom">
                <Button
                  variant="ghost"
                  size={'icon-xs'}
                  onClick={closePanel}
                  className="text-muted-foreground/60 hover:text-foreground p-1 rounded hover:bg-card/40 flex-shrink-0"
                >
                  <X className="size-3.5" />
                </Button>
              </Tip>
            </div>
          }
        >
          {items.map((item) => (
            <ContextMenu key={item.id}>
              <ContextMenuTrigger>
                <ScrollTabsTrigger
                  value={item.id}
                  className="px-2.5 h-[2rem] gap-1.5 text-xs"
                >
                  {item.icon}
                  {editingId === item.id ? (
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      size={Math.max(draftName.length, 6)}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitRename(item.id);
                        else if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => commitRename(item.id)}
                      className="bg-input border border-input rounded px-1 text-xs font-mono outline-none focus:border-primary/60 max-w-[10rem]"
                    />
                  ) : (
                    <span
                      className="truncate max-w-[10rem] cursor-text select-none font-mono"
                      title={item.id === active ? 'Click to rename' : undefined}
                      onPointerDown={(e) => {
                        if (item.id !== active) return;
                        e.stopPropagation();
                      }}
                      onClick={() => {
                        if (item.id === active) {
                          setDraftName(item.label);
                          setEditingId(item.id);
                        }
                      }}
                    >
                      {item.label}
                    </span>
                  )}
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(sessionId, item.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        e.preventDefault();
                        closeTerminal(sessionId, item.id);
                      }
                    }}
                    className={cn(
                      'ml-0.5 inline-flex items-center justify-center rounded size-3.5 flex-none transition-colors',
                      'text-muted-foreground/60 hover:bg-accent hover:text-foreground',
                    )}
                    title="Close terminal"
                    aria-label={`Close ${item.label}`}
                  >
                    <X className="size-2.5 pointer-events-none" />
                  </span>
                </ScrollTabsTrigger>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => closeTerminal(sessionId, item.id)} className="text-xs">
                  Close
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={terminals.length <= 1}
                  onSelect={(e) => {
                    e.preventDefault();
                    const all = [...(useUi.getState().terminals[sessionId] ?? [])];
                    for (const t of all) {
                      if (t.id !== item.id) useUi.getState().closeTerminal(sessionId, t.id);
                    }
                    useUi.getState().setActiveTerminal(sessionId, item.id);
                  }}
                  className="text-xs">
                  Close Others
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={terminals.length <= 1}
                  onSelect={(e) => {
                    e.preventDefault();
                    const all = [...(useUi.getState().terminals[sessionId] ?? [])];
                    for (const t of all) useUi.getState().closeTerminal(sessionId, t.id);
                  }}
                  className="text-xs">
                  Close All
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </ScrollTabsList>
      </ScrollTabs>

      <div className="flex-1 min-w-0 min-h-0 relative">
        {terminals.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground/60 gap-2">
            <TerminalIcon className="size-5 opacity-50" />
            <div className="text-xs">No terminals open</div>
            <Button variant="secondary" size="sm" onClick={() => addTerminal(sessionId)} className="text-xs h-7">
              <Plus className="size-3" /> New terminal
            </Button>
          </div>
        ) : (
          <div ref={mountRef} className="absolute inset-0" />
        )}
      </div>
    </div>
  );
});
