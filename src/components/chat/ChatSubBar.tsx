import {
  ChevronRight,
  FolderGit2,
  GitBranch,
  Play,
  Square,
  Hammer,
  ChevronDown,
  Power,
  Trash2,
} from 'lucide-react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/quick-tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useUi } from '@/lib/stores/ui';
import { useWorkspaces, useSession } from '@/lib/queries';
import * as api from '@/lib/api/client';
import { createLogger } from '@/lib/logger';

const log = createLogger('script');

/** Chat column sub-bar (32px): breadcrumb (left) and git branch + run/scripts/port controls (right). Scripts execute real child processes via IPC; port detection is parsed from stdout/stderr. */

/** Strip the dedupe suffix added by addTerminal so two terminals spawned
 *  by the same Run command ("npm run dev" and "npm run dev (1)") compare
 *  as the same script. Matches the format from dedupeTerminalName in
 *  ui.ts: "name (N)" where N is digits. */
function stripTermSuffix(name: string): string {
  return name.replace(/ \(\d+\)$/, '');
}
export function ChatSubBar() {
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const mainView = useUi((s) => s.mainView);
  const addTerminal = useUi((s) => s.addTerminal);
  const toggleTerminalOpen = useUi((s) => s.toggleTerminal);
  // All known terminals (any session) + their detected ports — we look
  // through these to find any terminal whose name matches the primary
  // Run script, which is how we know "the script is running" + which
  // terminal id to interrupt on Stop.
  const allTerminals = useUi((s) => s.terminals);
  const terminalPorts = useUi((s) => s.terminalPorts);

  const { data: workspaces } = useWorkspaces();
  const { data: session } = useSession(activeSessionId);

  const activeWorkspace = workspaces?.find((w) => w.id === activeWorkspaceId);
  const scripts = activeWorkspace?.scripts ?? [];
  const sessionTitle = session?.title ?? 'New session';
  const gitBranch = activeWorkspace?.branch;

  const primaryRun = scripts.find((s) => s.kind === 'run' && s.command);
  const setupScripts = scripts.filter((s) => s.kind === 'setup' && s.command);
  const runScripts = scripts.filter((s) => s.kind === 'run' && s.command);
  const deleteScripts = scripts.filter((s) => s.kind === 'delete' && s.command);

  // Identify any terminal currently RUNNING the primary Run script. Gating on `scriptRunning` (not just "tab exists") is what flips the button back to Run after Stop — Stop kills the foreground process but leaves the shell + tab alive, so name-only matching would keep the button stuck on Stop forever. Match by BASE name (strip the " (N)" suffix) so two clicks on Run — producing "npm run dev" and "npm run dev (1)" — both count; Stop drains them one at a time.
  const primaryRunName = primaryRun?.command.slice(0, 40);
  const runTerminal = useMemo(() => {
    if (!primaryRunName) return undefined;
    for (const list of Object.values(allTerminals)) {
      const found = list.find(
        (t) => stripTermSuffix(t.name) === primaryRunName && t.scriptRunning,
      );
      if (found) return found;
    }
    return undefined;
  }, [allTerminals, primaryRunName]);
  const isPrimaryRunActive = !!runTerminal;

  // PID-based liveness — the source of truth for whether the Run script is ACTUALLY still running. `scriptRunning` flips correctly on a user Stop, but can't detect a crashed/killed dev server. So when a run terminal exists, poll its pid: if the process died (crash, external kill, OS shutdown), clear scriptRunning so the button reverts to Run and port badges clear — without waiting for the user to notice.
  useEffect(() => {
    const tid = runTerminal?.id;
    if (!tid) return;
    let cancelled = false;
    const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;
    const poll = async () => {
      if (cancelled || !ipc) return;
      const pid = await ipc.terminalGetPid(tid);
      if (cancelled || !pid) return;
      const alive = await ipc.processIsAlive(pid);
      if (cancelled) return;
      if (!alive) {
        // Process died without a user Stop — sync the UI to reality.
        useUi.getState().markTerminalStopped(tid);
      }
    };
    poll(); // immediate check
    const interval = setInterval(poll, 2000); // then every 2s
    return () => { cancelled = true; clearInterval(interval); };
  }, [runTerminal?.id]);
  // Aggregate ports from ALL terminals across ALL sessions — multiple scripts can run side by side, each exposing its own dev-server port. Detection is backend-driven (per-PTY output scanning) so it fires regardless of which tab is visible or whether the panel is open. Each badge is stamped with the source terminal's name so the user can tell which script exposes which port when several are live.
  const aggregatedPorts = useMemo(() => {
    // Scope to the ACTIVE session's terminals only — otherwise a port
    // detected in session A's terminal leaks into session B's sub-bar.
    const activeTids = new Set<string>();
    for (const t of allTerminals[activeSessionId ?? ''] ?? []) {
      activeTids.add(t.id);
    }
    const seen = new Set<number>();
    const out: { port: number; url: string; label: string }[] = [];
    for (const [tid, ports] of Object.entries(terminalPorts)) {
      if (!activeTids.has(tid)) continue; // port belongs to another session
      const tname = (allTerminals[activeSessionId ?? ''] ?? []).find((t) => t.id === tid)?.name;
      for (const p of ports ?? []) {
        if (seen.has(p.port)) continue;
        seen.add(p.port);
        out.push({
          ...p,
          label: tname ? `${tname} — ${p.url}` : `${p.label} — ${p.url}`,
        });
      }
    }
    return out.sort((a, b) => a.port - b.port);
  }, [terminalPorts, allTerminals, activeSessionId]);

  const stopRunTerminal = useCallback(() => {
    if (!runTerminal) return;
    const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;
    ipc?.terminalStop(runTerminal.id);
    // Flip the button back to Run immediately. SIGINT kills the foreground process; the shell + tab stay alive so the user can read tail output. Without this client-side mark the button would stay Stop forever (we have no PTY-side signal that "foreground process exited" — the shell doesn't tell us).
    useUi.getState().markTerminalStopped(runTerminal.id);
  }, [runTerminal]);

  // Track which scripts are running locally (not in Zustand — these are
  // per-workspace, not per-session, and the IPC layer is the source of truth).
  // Port detection lives in the terminal layer now — terminalPorts (from
  // the ui store, fed by terminal:ports events) drives the badges.
  const [runningCommands, setRunningCommands] = useState<Set<string>>(new Set());

  // Subscribe to script-exit events for setup/delete scripts (the only
  // remaining callers of api.runScript). Port detection for terminal-run
  // scripts comes through terminal:ports → terminalPorts store slice.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;
    if (!ipc) return;

    ipc.onScriptExit((data) => {
      if (data.workspaceId === activeWorkspaceId) {
        setRunningCommands((prev) => {
          const next = new Set(prev);
          next.delete(data.command);
          return next;
        });
      }
    });

    return () => {
      ipc.removeAllScriptListeners();
    };
  }, [activeWorkspaceId]);

  const isRunning = useCallback(
    (cmd: string) => runningCommands.has(cmd),
    [runningCommands],
  );

  // Run a script INSIDE a terminal tab — the command is queued on the terminal instance as `pendingCommand` and flushed by TerminalPanel once ipc.terminalStart resolves. Doing the input send here directly would race the PTY spawn (the main process has no PTY for the new id until terminalStart fires) and the bytes would be dropped. Setup/Delete scripts keep the old api.runScript path — they're lifecycle events, not interactive dev workflows.
  const runScriptInTerminal = useCallback(
    (cmd: string) => {
      const sid = activeSessionId ?? activeWorkspaceId;
      if (!sid) return;
      addTerminal(sid, cmd.slice(0, 40), cmd);
      if (!useUi.getState().terminalOpen) {
        toggleTerminalOpen();
      }
    },
    [activeSessionId, activeWorkspaceId, addTerminal, toggleTerminalOpen],
  );

  const toggleScript = useCallback(
    async (cmd: string) => {
      if (!activeWorkspaceId) return;
      if (isRunning(cmd)) {
        // Fire-and-forget the stop IPC — clear local state immediately so
        // the UI flips to "Run" without waiting for the process to die.
        // The onScriptExit listener also clears as a backstop.
        api.stopScript(activeWorkspaceId, cmd).catch(() => {});
        setRunningCommands((prev) => {
          const next = new Set(prev);
          next.delete(cmd);
          return next;
        });
      } else {
        setRunningCommands((prev) => new Set(prev).add(cmd));
        try {
          const result = await api.runScript(activeWorkspaceId, cmd);
          if (!result.ok) {
            setRunningCommands((prev) => {
              const next = new Set(prev);
              next.delete(cmd);
              return next;
            });
            log.warn('Failed to start', result.reason);
            return;
          }
        } catch {
          setRunningCommands((prev) => {
            const next = new Set(prev);
            next.delete(cmd);
            return next;
          });
          return;
        }
        // Open terminal so the user sees output.
        addTerminal(activeSessionId ?? activeWorkspaceId, `Run: ${cmd.slice(0, 30)}`);
        toggleTerminalOpen();
      }
    },
    [activeWorkspaceId, activeSessionId, isRunning, addTerminal, toggleTerminalOpen],
  );

  return (
    <div className="h-10 flex items-center px-4 gap-2 bg-background border-b border-input flex-shrink-0 min-w-0">
      {/* Breadcrumb: workspace › session title */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground/60 flex-1 min-w-0">
        {activeWorkspace && (
          <>
            <FolderGit2 className="size-4 flex-shrink-0" style={{ opacity: 0.6 }} />
            <span className="text-[0.8rem] text-muted-foreground truncate">{activeWorkspace.name}</span>
            <ChevronRight className="size-4 flex-shrink-0" style={{ opacity: 0.6 }} />
          </>
        )}
        <span className="text-[0.8rem] text-foreground truncate">{sessionTitle}</span>
      </div>

      {/* Right: git branch + scripts + ports — only when a session is active,
          not on the "New session" empty state. */}
      {mainView === 'chat' && (
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {/* Git branch badge */}
        {gitBranch && (
          <div className="h-7 flex items-center gap-1 text-muted-foreground/60 font-mono bg-secondary rounded-lg px-2 py-1">
            <GitBranch className="size-4" style={{ opacity: 0.6 }} />
            <span className="truncate text-[0.8rem] max-w-[120px]">{gitBranch}</span>
          </div>
        )}

        {/* Primary Run / Stop button. When a terminal running this script
            is alive, the button flips to Stop and interrupts the PTY via
            SIGINT (Ctrl+C) — graceful: dev servers clean up before dying.
            Each Run click opens a fresh tab so restarts are clean. */}
        {primaryRun && (
          <Tip label={isPrimaryRunActive ? `Stop — ${primaryRun.command}` : primaryRun.command}>
            <Button
              variant={isPrimaryRunActive ? 'destructive' : 'secondary'}
              size="lg"
              className="h-7 gap-1 px-2 text-[0.8rem]"
              onClick={() =>
                isPrimaryRunActive ? stopRunTerminal() : runScriptInTerminal(primaryRun.command)
              }
            >
              {isPrimaryRunActive ? (
                <Square className="size-3 fill-current animate-stop-pulse" />
              ) : (
                <Play className="size-3 text-success" />
              )}
              {isPrimaryRunActive ? 'Stop' : 'Run'}
            </Button>
          </Tip>
        )}

        {/* Live port badges — aggregated across all terminals. Each badge
            links to the dev server URL and pulses to signal "alive". */}
        {aggregatedPorts.map((p) => (
          <Tip key={p.port} label={`${p.label} — ${p.url}`}>
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="h-7 inline-flex items-center gap-1 px-1.5 text-[0.8rem] font-mono rounded-lg text-success bg-success/10 border border-success/25 hover:bg-success/15 transition-colors"
            >
              :{p.port}
            </a>
          </Tip>
        ))}

        {/* Scripts dropdown */}
        {activeWorkspace && scripts.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-0.5 text-[0.8rem] px-1.5 text-muted-foreground">
                <Hammer className="size-3" />
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[280px]">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
                {activeWorkspace.name} scripts
              </DropdownMenuLabel>

              {setupScripts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-info font-semibold flex items-center gap-1">
                    <Power className="size-2.5" /> Setup
                  </div>
                  {setupScripts.map((s, i) => (
                    <DropdownMenuItem
                      key={i}
                      onClick={() => toggleScript(s.command)}
                      className="gap-2 py-1.5 cursor-pointer"
                    >
                      <code className="font-mono text-[11px] flex-1 truncate text-muted-foreground">{s.command}</code>
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              {runScripts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-success font-semibold flex items-center gap-1">
                    <Play className="size-2.5" /> Run
                  </div>
                  {runScripts.map((s, i) => (
                    <DropdownMenuItem
                      key={i}
                      onClick={() => runScriptInTerminal(s.command)}
                      className="gap-2 py-1.5 cursor-pointer"
                    >
                      <code className="font-mono text-[11px] flex-1 truncate text-muted-foreground">{s.command}</code>
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              {deleteScripts.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-destructive font-semibold flex items-center gap-1">
                    <Trash2 className="size-2.5" /> Cleanup
                  </div>
                  {deleteScripts.map((s, i) => (
                    <DropdownMenuItem
                      key={i}
                      onClick={() => toggleScript(s.command)}
                      className="gap-2 py-1.5 cursor-pointer"
                    >
                      <code className="font-mono text-[11px] flex-1 truncate text-muted-foreground">{s.command}</code>
                    </DropdownMenuItem>
                  ))}
                </>
              )}

              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => useUi.getState().setScreen('settings')}
                className="text-[11px] text-muted-foreground/60 gap-2 cursor-pointer"
              >
                <Hammer className="size-3" /> Configure scripts…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      )}
    </div>
  );
}
