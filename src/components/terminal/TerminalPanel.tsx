import { useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { Terminal as TerminalIcon, Plus, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useUi } from '@/lib/stores/ui';
import { getTerminalTheme } from '@/components/screens/settings/AppearanceSection';
import { Button } from '@/components/ui/button';
import { ScrollTabs, ScrollTabsList, ScrollTabsTrigger } from '@/components/ui/scroll-tabs';
import { Tip } from '@/components/ui/quick-tooltip';
import { cn } from '@/lib/utils';

const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;

// ── Module-level terminal registry ──────────────────────────────
// xterm instances live OUTSIDE React's reconciliation. React provides
// a mount div; we imperatively create/destroy terminal canvases inside
// it. This guarantees terminals survive session switches — the DOM
// elements are never touched by React's diffing.

interface LiveTerminal {
  term: Terminal;
  fit: FitAddon;
  inputDisposable: { dispose: () => void };
  resizeObserver: ResizeObserver;
}

const registry = new Map<string, LiveTerminal>();

export const TerminalPanel = memo(function TerminalPanel() {
  const sessionId = useUi((s) => s.activeSessionId ?? 'default');
  const terminalOpen = useUi((s) => s.terminalOpen);
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
  const mountRef = useRef<HTMLDivElement>(null);

  const active = activeId && terminals.some((t) => t.id === activeId) ? activeId : terminals[0]?.id;

  // Drag-to-resize from the top edge. We attach mousemove + mouseup to the
  // window so the drag keeps working after the cursor leaves the handle
  // (otherwise a fast upward drag detaches from the listener and stalls).
  // Height is clamped to [120, 720] — keeps the terminal useful without
  // swallowing the chat area on giant displays.
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

  // Only process the ACTIVE session's terminals — not all sessions'.
  // Previously this flattened every session's terminals, causing all PTYs
  // to spawn on startup (20+ zombie processes). Now only the current
  // session's terminals get xterm instances + PTYs.
  const allEntries = useMemo(
    () => (allTerminals[sessionId] ?? []).map((t) => ({
      sessionId,
      terminalId: t.id,
      name: t.name,
    })),
    [allTerminals, sessionId],
  );
  const allIds = useMemo(() => new Set(allEntries.map((e) => e.terminalId)), [allEntries]);

  // Tracks which terminal we last focused. We only refocus when the active
  // id actually CHANGES — calling focus() on every effect run would steal
  // focus from the user mid-keystroke whenever MainScreen re-renders.
  const prevActiveRef = useRef<string | null | undefined>(undefined);

  // ── IPC listeners (registered ONCE, not per-terminal) ──────────────
  // Each terminal's output/exit/ports events are routed by terminalId — the
  // handlers look up the xterm instance in the module-level `registry` at
  // event time. This avoids adding a new listener per terminal creation,
  // which caused MaxListenersExceededWarning after ~11 terminals.
  useEffect(() => {
    if (!ipc) return;

    const onOutput = ({ terminalId, data }: { terminalId: string; data: string }) => {
      const entry = registry.get(terminalId);
      if (entry) entry.term.write(data);
    };
    const onExit = ({ terminalId, code }: { terminalId: string; code: number | null }) => {
      const entry = registry.get(terminalId);
      if (entry) entry.term.write(`\r\n\x1b[31m[Process exited with code ${code}]\x1b[0m\r\n`);
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
    if (!mount || !ipc) return;

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
        allowProposedApi: true,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());

      // Create a wrapper div INSIDE the mount. xterm renders into this.
      // We manage this div imperatively — React never touches it.
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:absolute;inset:0;padding:4px 4px 0 4px;';
      wrapper.dataset.terminalId = tid;
      mount.appendChild(wrapper);
      term.open(wrapper);
      fit.fit();

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

      registry.set(tid, { term, fit, inputDisposable, resizeObserver });
      if (tid === active) createdActive = true;
    }

    // ── Dispose terminals removed from store (tab closed) ──
    for (const [tid, live] of registry) {
      if (allIds.has(tid)) continue;
      live.inputDisposable.dispose();
      live.resizeObserver.disconnect();
      ipc.terminalKill(tid);
      live.term.dispose();
      const wrapper = live.term.element?.parentElement;
      wrapper?.remove();
      registry.delete(tid);
    }

    // ── Visibility toggle ──
    // Only refocus / refit when the active id actually changed, or when
    // the active terminal was just created. Calling focus() on every
    // effect run is what caused the "can't type" + flicker symptoms.
    const activeChanged = active !== prevActiveRef.current;
    for (const [tid, live] of registry) {
      const wrapper = live.term.element?.parentElement;
      if (!wrapper) continue;
      const isVisible = tid === active;
      wrapper.style.display = isVisible ? 'block' : 'none';
      if (isVisible && (activeChanged || createdActive)) {
        try { live.fit.fit(); live.term.focus(); } catch { /* */ }
      }
    }
    prevActiveRef.current = active;
  }, [allEntries, allIds, active]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Refit on expand. The panel is always mounted (so xterm state survives
  // collapse), but its outer div has display:none while collapsed — the
  // ResizeObserver can't measure a zero-size box, so the active terminal's
  // last fit() ran against the pre-collapse dimensions. When the user
  // re-opens the panel, refit + refocus so the canvas matches the new
  // visible size.
  useEffect(() => {
    if (!terminalOpen) return;
    if (!active) return;
    const entry = registry.get(active);
    if (!entry) return;
    // Defer one tick so the browser has laid out the un-hidden panel and
    // the wrapper has real dimensions again.
    const raf = requestAnimationFrame(() => {
      try { entry.fit.fit(); entry.term.focus(); } catch { /* */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [terminalOpen, active]);

  const items = terminals.map((t) => ({
    id: t.id,
    label: t.name,
    icon: <TerminalIcon className="size-3" />,
  }));

  return (
    <div
      // `hidden` (= display:none) when collapsed, so the panel stops
      // occupying layout space — but the component stays mounted, which
      // is what keeps the xterm canvases + scrollback alive across
      // toggle cycles. Re-displayed when terminalOpen flips back to true.
      className={cn(
        'flex-shrink-0 flex flex-col overflow-hidden',
        !terminalOpen && 'hidden',
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
        className="group relative flex-shrink-0 h-1.5 cursor-row-resize bg-transparent hover:bg-accent/40 transition-colors"
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
              <span className="truncate max-w-[10rem]">{item.label}</span>
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

      <div className="flex-1 overflow-hidden min-h-0 relative">
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
             inside this div by the effect above. React never manages
             the xterm DOM, only this container. */
          <div ref={mountRef} className="absolute inset-0" />
        )}
      </div>
    </div>
  );
});
