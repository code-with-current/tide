import { useRef, useEffect, useCallback, useMemo, memo, useState } from 'react';
import { Terminal as TerminalIcon, Plus, X } from 'lucide-react';
import { init, Terminal, FitAddon } from 'ghostty-web';
import type { ILink } from 'ghostty-web';
import { useUi } from '@/lib/stores/ui';
import { getTerminalTheme } from '@/components/screens/settings/appearance';
import { Button } from '@/components/ui/button';
import { ScrollTabs, ScrollTabsList, ScrollTabsTrigger } from '@/components/ui/scroll-tabs';
import { Tip } from '@/components/ui/quick-tooltip';
import { cn, isMac } from '@/lib/utils';

const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;

// ── Module-level terminal registry ──────────────────────────────
// xterm instances live OUTSIDE React's reconciliation. React provides a mount div; we imperatively create/destroy terminal canvases inside it. This guarantees terminals survive session switches — the DOM elements are never touched by React's diffing.

interface LiveTerminal {
  term: Terminal;
  fit: FitAddon;
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

// ── File-path link provider ──────────────────────────────────────
// Detects absolute paths (and path:line / path:line:col) in terminal output and reveals them in the OS file manager on click. xterm calls provideLinks per visible line as the user hovers; we scan that line for path matches and return ILink objects with the buffer range + activate handler. Path pattern: an absolute POSIX path (starts with /) OR a Windows path (drive letter:\), optionally suffixed with :line and :col. We deliberately require a leading slash / drive to avoid matching arbitrary "foo:bar" text.
const PATH_PATTERN = /(?:\/[\w./@-]+|[A-Za-z]:\\[\w\\./-]+)(?::(\d+))?(?::(\d+))?/g;

class FilePathLinkProvider {
  private term: Terminal;
  constructor(term: Terminal) {
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
          if (mod) window.tideIpc?.showItemInFolder(path);
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
  private term: Terminal;
  constructor(term: Terminal) {
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
            window.tideIpc?.openExternal(href);
          }
        },
      });
    }
    callback(links.length > 0 ? links : undefined);
  }
}

export const TerminalPanel = memo(function TerminalPanel() {
  const sessionId = useUi((s) => s.activeSessionId ?? 'default');
  const terminalOpen = useUi((s) => s.terminalOpen);
  // MainScreen is always-mounted now; the panel survives Settings visits but
  // its box measures zero-size while hidden. This flag re-fits on return.
  const screenActive = useUi((s) => s.screen === "main");
  const toggle = useUi((s) => s.toggleTerminal);
  const terminalTheme = useUi((s) => s.terminalTheme);
  const terminalFontSize = useUi((s) => s.terminalFontSize);
  const height = useUi((s) => s.terminalHeight);
  const setHeight = useUi((s) => s.setTerminalHeight);
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

  // Drag-to-resize from the top edge. We attach mousemove + mouseup to the window so the drag keeps working after the cursor leaves the handle (otherwise a fast upward drag detaches from the listener and stalls). Height is clamped to [120, 720] — keeps the terminal useful without swallowing the chat area on giant displays.
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = useUi.getState().terminalHeight;
    const onMove = (ev: MouseEvent) => {
      // Terminal grows when the cursor moves UP (toward the chat), shrinks
      // when it moves DOWN — so the delta is inverted vs. cursor Y.
      const delta = startY - ev.clientY;
      const next = Math.max(120, Math.min(720, startHeight + delta));
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [setHeight]);

  // ghostty-web loads its WASM (embedded base64 fallback) once before any
  // Terminal can be constructed. Gate terminal creation on this so the first
  // open doesn't race the WASM init.
  const [wasmReady, setWasmReady] = useState(false);
  useEffect(() => { let alive = true; init().then(() => { if (alive) setWasmReady(true); }).catch(() => {}); return () => { alive = false; }; }, []);

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

  // ── IPC listeners (registered ONCE, not per-terminal) ──────────────
  // Each terminal's output/exit/ports events are routed by terminalId — the handlers look up the xterm instance in the module-level `registry` at event time. This avoids adding a new listener per terminal creation, which caused MaxListenersExceededWarning after ~11 terminals.
  useEffect(() => {
    if (!ipc) return;

    const onOutput = ({ terminalId, data }: { terminalId: string; data: string }) => {
      // Batched flush (rAF) — see queueOutput. Keeps the UI responsive under
      // high-throughput PTY output instead of writing per-IPC-event.
      queueOutput(terminalId, data);
    };
    const onExit = ({ terminalId, code }: { terminalId: string; code: number | null }) => {
      // Route through the same buffer so the exit line stays ordered after
      // any pending output (a direct write could land before buffered chunks).
      queueOutput(terminalId, `\r\n\x1b[31m[Process exited with code ${code}]\x1b[0m\r\n`);
    };
    const onPorts = ({ terminalId, ports }: { terminalId: string; ports: { port: number; url: string; label: string }[] }) => {
      useUi.getState().setTerminalPorts(terminalId, ports);
    };

    ipc.onTerminalOutput(onOutput);
    ipc.onTerminalExit(onExit);
    ipc.onTerminalPorts(onPorts);

    return () => {
      ipc.removeAllTerminalListeners();
    };
  }, []);

  // Sync the registry with the store. Only runs when the terminal id set
  // or the active id actually changes — NOT on every parent re-render.
  // (terminalTheme/terminalFontSize are handled by a separate effect that
  // updates existing terminals in place via term.options — see below.)
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !ipc || !wasmReady) return;

    let createdActive = false;

    // ── Create terminals that don't exist yet ──
    for (const { sessionId: sid, terminalId: tid } of allEntries) {
      if (registry.has(tid)) continue;

      const themeColors = getTerminalTheme(terminalTheme);

      const term = new Terminal({
        cursorBlink: true,
        fontSize: terminalFontSize,
        fontFamily: "'MesloLGS NF', 'MesloLGS Nerd Font', 'JetBrains Mono', Menlo, monospace",
        theme: themeColors as any,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);

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
      fit.fit();

      // Link providers — ghostty-web has no WebLinksAddon equivalent, so we
      // register two providers: URLs (open in OS browser on modifier+click,
      // replacing @xterm/addon-web-links) and file paths (path:line:col →
      // reveal in OS file manager). Registered per-terminal; called per line
      // as the user hovers.
      term.registerLinkProvider(new UrlLinkProvider(term));
      term.registerLinkProvider(new FilePathLinkProvider(term));

      // Start PTY. Await so any pendingCommand is flushed to a real PTY
      // rather than a not-yet-existing id — without this, the Run button
      // races ahead of the terminal spawn and the bytes get dropped.
      ipc.terminalStart(tid, sid).then(() => {
        // Read the pending command from the live store (not the closure,
        // which would be stale across renders).
        const state = useUi.getState();
        const inst = state.terminals[sid]?.find((t) => t.id === tid);
        const cmd = inst?.pendingCommand;
        if (cmd) {
          ipc?.terminalInput(tid, cmd + '\r');
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
      });

      // PTY → terminal: IPC listeners are registered ONCE (see useEffect below)
      // — they look up the terminal by id at event time. Previously each
      // terminal creation added new listeners, causing a MaxListenersExceeded
      // leak after ~11 terminals.

      // terminal → PTY
      const inputDisposable = term.onData((data: string) => {
        ipc.terminalInput(tid, data);
      });

      // Resize
      const resizeObserver = new ResizeObserver(() => {
        try { fit.fit(); ipc.terminalResize(tid, term.cols, term.rows); } catch { /* */ }
      });
      resizeObserver.observe(wrapper);

      registry.set(tid, { term, fit, wrapper, inputDisposable, resizeObserver });
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
      ipc.terminalKill(tid);
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
  }, [allEntries, activeSessionIds, survivingIds, active, wasmReady]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Refit on expand OR on screen return. The panel is always mounted (so
  // terminal state survives collapse + Settings visits), but its outer div has
  // display:none while collapsed/hidden — the ResizeObserver can't measure a
  // zero-size box, so the active terminal's last fit() ran against the
  // pre-hide dimensions. When the user re-opens the panel or returns from
  // Settings, refit + refocus + force a redraw so the canvas matches the new
  // visible size. The redraw matters: fit() early-returns when the size hasn't
  // changed (open/switch-back to an identical-sized panel), so without it the
  // bitmap is blank until the next PTY data arrives.
  const forceRedraw = (live: LiveTerminal | undefined) => {
    if (!live) return;
    try {
      // Re-asserting the current size forces ghostty-web's renderer to do a
      // FULL re-render (it clears the dirty rows + redraws). A real fit() is
      // attempted first so layout-driven resizes still propagate.
      live.fit.fit();
      const t = live.term;
      t.resize(t.cols, t.rows);
      t.focus();
    } catch { /* */ }
  };
  useEffect(() => {
    if (!terminalOpen) return;
    if (!screenActive) return;
    if (!active) return;
    const entry = registry.get(active);
    if (!entry) return;
    // Defer one tick so the browser has laid out the un-hidden panel and
    // the wrapper has real dimensions again.
    const raf = requestAnimationFrame(() => forceRedraw(entry));
    return () => cancelAnimationFrame(raf);
  }, [terminalOpen, screenActive, active]);

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
    <div
      className={cn(
        'flex-shrink-0 flex flex-col overflow-hidden border-border border-t',
        (!terminalOpen || terminals.length === 0) && 'hidden',
      )}
      style={{ height }}
    >
      {/* Drag handle — invisible until hover. Sits at the very top edge so
          the user grabs the terminal by its top border to resize. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={startResize}
        onDoubleClick={() => setHeight(220)}
        className="group relative flex-shrink-0 h-1 cursor-row-resize bg-transparent hover:bg-accent/40 transition-colors"
        title="Drag to resize · double-click to reset"
      >
        <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="block w-1 h-1 rounded-full bg-muted-foreground/50" />
          <span className="block w-1 h-1 rounded-full bg-muted-foreground/50" />
          <span className="block w-1 h-1 rounded-full bg-muted-foreground/50" />
        </span>
      </div>
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
                  onClick={toggle}
                  className="text-muted-foreground/60 hover:text-foreground p-1 rounded hover:bg-card/40 flex-shrink-0"
                >
                  <X className="size-3.5" />
                </Button>
              </Tip>
            </div>
          }
        >
          {items.map((item) => (
            <ScrollTabsTrigger
              key={item.id}
              value={item.id}
              className="px-2.5 h-[2rem] gap-1.5 text-xs"
            >
              {item.icon}
              {editingId === item.id ? (
                <input
                  // Inline rename — autofocus + select on mount so the user
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
                  className="bg-input border border-input rounded px-1 text-xs outline-none focus:border-primary/60 max-w-[10rem]"
                />
              ) : (
                <span
                  className="truncate max-w-[10rem] cursor-text select-none"
                  title={item.id === active ? 'Click to rename' : undefined}
                  // Use onPointerDown (NOT onClick): the list's drag-scroll
                  // does setPointerCapture at pointerdown and its click
                  // suppressor (handleClickCapture) can swallow a plain click
                  // before the span's onClick fires. pointerdown fires BEFORE
                  // the list's handler (capture target is set there), and
                  // stopPropagation keeps this from starting a drag-scroll.
                  onPointerDown={(e) => {
                    if (item.id !== active) return; // inactive tab → let Radix select
                    e.stopPropagation();
                  }}
                  onClick={() => {
                    // Single-click on the ACTIVE tab's title → inline rename.
                    // Inactive tabs just select (Radix handles that via the
                    // Trigger), so only act when it's already active.
                    if (item.id === active) {
                      setDraftName(item.label);
                      setEditingId(item.id);
                    }
                  }}
                >
                  {item.label}
                </span>
              )}
              {/* Close button — span (not <button>) to avoid nesting in
                  Radix's TabsTrigger. Stop propagation so close ≠ select. */}
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
          ))}
        </ScrollTabsList>
      </ScrollTabs>

      <div className="flex-1 overflow-hidden w-full min-h-0 relative">
        {terminals.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground/60 gap-2">
            <TerminalIcon className="size-5 opacity-50" />
            <div className="text-xs">No terminals open</div>
            <Button variant="secondary" size="sm" onClick={() => addTerminal(sessionId)} className="text-xs h-7">
              <Plus className="size-3" /> New terminal
            </Button>
          </div>
        ) : (
          /* Mount point — terminal canvases are created imperatively
             inside this div. React never manages the xterm DOM. */
          <div ref={mountRef} className="absolute inset-0" />
        )}
      </div>
    </div>
  );
});
