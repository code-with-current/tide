/** WindowTopBar — merged with ChatSubBar. Single 40px full-width bar:
 *  [toggle] breadcrumb    drag region    [branch]    [ports][run][scripts]  |  [open-app][terminal][right-panel]
 *  Session-level content (breadcrumb, branch, ports, scripts) hides on workspaceMissing / mainView !== 'chat'. */

import {
  PanelRight, Terminal, PanelRightClose,
  ChevronRight, GitBranch, Play, Square,
  Hammer, ChevronDown, Power, Trash2,
  FolderCode,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Tip } from "@/components/ui/quick-tooltip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { useUi } from "@/lib/stores/ui";
import { useWorkspaces, useSession } from "@/lib/queries";
import * as api from "@/lib/api/client";
import { useQueryClient } from "@tanstack/react-query";
import { cn, isMac } from "@/lib/utils";
import { OpenInAppMenu } from "./open-in-app-menu";
import { Badge } from "../ui/badge";

const CAPTION_PAD = isMac ? 0 : 140;

function stripTermSuffix(name: string): string {
  return name.replace(/ \(\d+\)$/, '');
}

export function WindowTopBar() {
  // ── Scripts dropdown open state (controlled so we can close on action) ──
  const [scriptsOpen, setScriptsOpen] = useState(false);

  // ── Panel toggles ──
  const toggleTerminal = useUi((s) => s.toggleTerminal);
  const toggleRightPanel = useUi((s) => s.toggleRightPanel);
  const toggleSessionsPanel = useUi((s) => s.toggleSessionsPanel);
  const sidebarMode = useUi((s) => s.sidebarMode);
  const sessionsPanelOpen = useUi((s) => s.sessionsPanelOpen);

  // ── Session context ──
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const mainView = useUi((s) => s.mainView);
  const addTerminal = useUi((s) => s.addTerminal);
  const toggleTerminalOpen = useUi((s) => s.toggleTerminal);
  const allTerminals = useUi((s) => s.terminals);
  const terminalPorts = useUi((s) => s.terminalPorts);

  const { data: workspaces } = useWorkspaces();
  const { data: session } = useSession(activeSessionId);
  const qc = useQueryClient();
  const activeWorkspace = workspaces?.find((w) => w.id === activeWorkspaceId);
  const scripts = activeWorkspace?.scripts ?? [];

  const addRunScript = useCallback(async (command: string) => {
    if (!activeWorkspaceId || !command.trim()) return;
    const newScripts = [...scripts, { kind: 'run' as const, command: command.trim() }];
    await api.updateWorkspace(activeWorkspaceId, { scripts: newScripts });
    qc.invalidateQueries({ queryKey: ['workspaces'] });
  }, [activeWorkspaceId, scripts, qc]);
  const sessionTitle = session?.title ?? 'New session';
  const gitBranch = activeWorkspace?.branch;
  const showSessionContent = mainView === 'chat' && !!activeWorkspace;

  // ── Scripts logic (from ChatSubBar) ──
  const primaryRun = scripts.find((s) => s.kind === 'run' && s.command);
  const setupScripts = scripts.filter((s) => s.kind === 'setup' && s.command);
  const runScripts = scripts.filter((s) => s.kind === 'run' && s.command);
  const deleteScripts = scripts.filter((s) => s.kind === 'delete' && s.command);
  const primaryRunName = primaryRun?.command.slice(0, 40);

  const runTerminal = useMemo(() => {
    if (!primaryRunName) return undefined;
    for (const list of Object.values(allTerminals)) {
      const found = list.find((t) => stripTermSuffix(t.name) === primaryRunName && t.scriptRunning);
      if (found) return found;
    }
    return undefined;
  }, [allTerminals, primaryRunName]);
  const isPrimaryRunActive = !!runTerminal;

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
      if (!alive) useUi.getState().markTerminalStopped(tid);
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [runTerminal?.id]);

  const aggregatedPorts = useMemo(() => {
    const activeTids = new Set<string>();
    for (const t of allTerminals[activeSessionId ?? ''] ?? []) activeTids.add(t.id);
    const seen = new Set<number>();
    const out: { port: number; url: string; label: string }[] = [];
    for (const [tid, ports] of Object.entries(terminalPorts)) {
      if (!activeTids.has(tid)) continue;
      const tname = (allTerminals[activeSessionId ?? ''] ?? []).find((t) => t.id === tid)?.name;
      for (const p of ports ?? []) {
        if (seen.has(p.port)) continue;
        seen.add(p.port);
        out.push({ ...p, label: tname ? `${tname} — ${p.url}` : `${p.label} — ${p.url}` });
      }
    }
    return out.sort((a, b) => a.port - b.port);
  }, [terminalPorts, allTerminals, activeSessionId]);

  const stopRunTerminal = useCallback(() => {
    if (!runTerminal) return;
    window.tideIpc?.terminalStop(runTerminal.id);
    useUi.getState().markTerminalStopped(runTerminal.id);
  }, [runTerminal]);

  const [runningCommands, setRunningCommands] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const ipc = typeof window !== 'undefined' ? window.tideIpc : undefined;
    if (!ipc) return;
    ipc.onScriptExit((data) => {
      if (data.workspaceId === activeWorkspaceId) {
        setRunningCommands((prev) => { const n = new Set(prev); n.delete(data.command); return n; });
      }
    });
    return () => ipc.removeAllScriptListeners();
  }, [activeWorkspaceId]);

  const isRunning = useCallback((cmd: string) => runningCommands.has(cmd), [runningCommands]);

  const runScriptInTerminal = useCallback((cmd: string) => {
    const sid = activeSessionId ?? activeWorkspaceId;
    if (!sid) return;
    addTerminal(sid, cmd.slice(0, 40), cmd);
    if (!useUi.getState().terminalOpen) toggleTerminalOpen();
  }, [activeSessionId, activeWorkspaceId, addTerminal, toggleTerminalOpen]);

  const toggleScript = useCallback(async (cmd: string) => {
    if (!activeWorkspaceId) return;
    if (isRunning(cmd)) {
      api.stopScript(activeWorkspaceId, cmd).catch(() => {});
      setRunningCommands((prev) => { const n = new Set(prev); n.delete(cmd); return n; });
    } else {
      setRunningCommands((prev) => new Set(prev).add(cmd));
      try {
        const result = await api.runScript(activeWorkspaceId, cmd);
        if (!result.ok) {
          setRunningCommands((prev) => { const n = new Set(prev); n.delete(cmd); return n; });
          return;
        }
      } catch {
        setRunningCommands((prev) => { const n = new Set(prev); n.delete(cmd); return n; });
        return;
      }
      addTerminal(activeSessionId ?? activeWorkspaceId, `Run: ${cmd.slice(0, 30)}`);
      toggleTerminalOpen();
    }
  }, [activeWorkspaceId, activeSessionId, isRunning, addTerminal, toggleTerminalOpen]);

  return (
    <div
      className="drag-region flex items-center px-2 gap-2 border-b border-input flex-shrink-0"
      style={{ height: 40 }}
    >
      {/* ══ Far left: sessions toggle + breadcrumb ══ */}
      {sidebarMode === 'dual' && (
        <Tip label="Sessions Panel">
          <Button variant="outline" size="sm" className="p-1.5 flex-shrink-0" onClick={toggleSessionsPanel}>
            <PanelRightClose className={cn("size-3.5 transition-transform", { "rotate-180": sessionsPanelOpen })} />
          </Button>
        </Tip>
      )}

      {activeWorkspace && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground/60 flex-shrink-0 min-w-0">
          <FolderCode className="size-4 flex-shrink-0 text-muted-foreground " />
          <span className="text-[0.8rem] text-muted-foreground truncate max-w-[120px]">{activeWorkspace.name}</span>
          <ChevronRight className="size-4 flex-shrink-0" style={{ opacity: 0.6 }} />
          <span className="text-[0.8rem] text-card-foreground truncate max-w-[200px]">{sessionTitle}</span>

          {showSessionContent && gitBranch && (
            <Badge variant="secondary" className="py-0.5 px-2 ml-2">
              <GitBranch className="size-3.5" style={{ opacity: 0.6 }} />
              <span className="truncate text-[0.75rem] max-w-[120px]">{gitBranch}</span>
            </Badge>
          )}
        </div>
      )}

      {/* ══ Center: drag region + git branch (centered) ══ */}
      <div className="flex-1 flex items-center justify-center relative">

      </div>

      {/* ══ Right-mid: ports + merged run/stop + scripts button group ══ */}
      {showSessionContent && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {aggregatedPorts.map((p) => (
            <Tip key={p.port} label={`${p.label} — ${p.url}`}>
              <a href={p.url} target="_blank" rel="noreferrer"
                className="h-7 inline-flex items-center gap-1 px-1.5 text-[0.8rem] font-mono rounded-lg text-success bg-success/10 border border-success/25 hover:bg-success/15 transition-colors">
                {`:${p.port}`}
              </a>
            </Tip>
          ))}

          {/* Merged button group: Run/Stop (if run script exists) + Scripts dropdown (always) */}
          <ButtonGroup>
            {primaryRun && (
              <Tip label={isPrimaryRunActive ? `Stop — ${primaryRun.command}` : primaryRun.command}>
                <Button
                  variant={isPrimaryRunActive ? 'destructive' : 'outline'}
                  size="sm"
                  className="gap-1 px-1.5 text-[0.8rem] rounded-r-none "
                  onClick={() => isPrimaryRunActive ? stopRunTerminal() : runScriptInTerminal(primaryRun.command)}
                >
                  {isPrimaryRunActive ? <Square className="size-3 fill-current animate-stop-pulse" /> : <Play className="size-3 text-success" />}
                  {isPrimaryRunActive ? 'Stop' : 'Run'}
                </Button>
              </Tip>
            )}
            <DropdownMenu open={scriptsOpen} onOpenChange={setScriptsOpen}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className={cn('gap-0.5 text-[0.8rem] px-1.5 text-muted-foreground', primaryRun && 'rounded-l-none')}>
                  <Hammer className="size-3" /><ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[260px] p-0">
                {scripts.length === 0 ? (
                  /* Empty state — inline add form */
                  <div className="p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="size-6 rounded-md bg-secondary flex items-center justify-center">
                        <Play className="size-3 text-muted-foreground" />
                      </div>
                      <span className="text-[12px] font-medium">Add a run script</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        placeholder="pnpm dev"
                        className="flex-1 h-8 text-[11px] font-mono rounded-md border border-border bg-secondary/50 px-2.5 outline-none focus:border-primary/40 transition-colors"
                        onKeyDown={(e: React.KeyboardEvent) => {
                          if (e.key === 'Enter') {
                            const val = (e.target as HTMLInputElement).value.trim();
                            if (val) { addRunScript(val); (e.target as HTMLInputElement).value = ''; setScriptsOpen(false); }
                          }
                        }}
                      />
                      <Button variant="default" size="sm" className="h-8 px-3 text-[0.7rem]"
                        onClick={(e) => {
                          const input = (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement);
                          const val = input?.value.trim();
                          if (val) { addRunScript(val); input.value = ''; setScriptsOpen(false); }
                        }}>Add</Button>
                    </div>
                    <button type="button"
                      onClick={() => { localStorage.setItem('tide-settings-section', 'workspace'); useUi.getState().setScreen('settings'); setScriptsOpen(false); }}
                      className="w-full mt-2 text-[11px] text-muted-foreground/50 hover:text-muted-foreground text-left transition-colors">
                      Configure scripts →
                    </button>
                  </div>
                ) : (
                  /* Scripts list — flat, icon-led rows */
                  <div className="py-1">
                    {setupScripts.map((s, i) => (
                      <button key={`setup-${i}`} type="button"
                        onClick={() => { toggleScript(s.command); setScriptsOpen(false); }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-secondary/60 transition-colors text-left group">
                        <Power className="size-3.5 text-info/70 group-hover:text-info flex-shrink-0" />
                        <code className="font-mono text-[11px] flex-1 truncate text-muted-foreground group-hover:text-foreground">{s.command}</code>
                        {isRunning(s.command) && <span className="size-1.5 rounded-full bg-info animate-pulse flex-shrink-0" />}
                      </button>
                    ))}
                    {runScripts.map((s, i) => (
                      <button key={`run-${i}`} type="button"
                        onClick={() => { runScriptInTerminal(s.command); setScriptsOpen(false); }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-secondary/60 transition-colors text-left group">
                        <Play className="size-3.5 text-success/70 group-hover:text-success flex-shrink-0" />
                        <code className="font-mono text-[11px] flex-1 truncate text-muted-foreground group-hover:text-foreground">{s.command}</code>
                      </button>
                    ))}
                    {deleteScripts.map((s, i) => (
                      <button key={`del-${i}`} type="button"
                        onClick={() => { toggleScript(s.command); setScriptsOpen(false); }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-secondary/60 transition-colors text-left group">
                        <Trash2 className="size-3.5 text-destructive/70 group-hover:text-destructive flex-shrink-0" />
                        <code className="font-mono text-[11px] flex-1 truncate text-muted-foreground group-hover:text-foreground">{s.command}</code>
                        {isRunning(s.command) && <span className="size-1.5 rounded-full bg-destructive animate-pulse flex-shrink-0" />}
                      </button>
                    ))}
                    <div className="border-t border-border/50 mt-1 pt-1">
                      <button type="button"
                        onClick={() => { localStorage.setItem('tide-settings-section', 'workspace'); useUi.getState().setScreen('settings'); setScriptsOpen(false); }}
                        className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-secondary/60 transition-colors text-left group">
                        <Hammer className="size-3.5 text-muted-foreground/50 group-hover:text-muted-foreground flex-shrink-0" />
                        <span className="text-[11px] text-muted-foreground/60 group-hover:text-muted-foreground">Configure scripts</span>
                      </button>
                    </div>
                  </div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>
      )}

      {/* ══ Far right: open-in-app + terminal + right panel ══ */}
      <div className="flex items-center gap-1.5 flex-shrink-0" style={{ paddingRight: CAPTION_PAD }}>
        <OpenInAppMenu />
        <Tip label="Terminal Panel">
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleTerminal}>
            <Terminal className="size-3.5" />
          </Button>
        </Tip>
        <Tip label="Right Panel">
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleRightPanel}>
            <PanelRight className="size-3.5" />
          </Button>
        </Tip>
      </div>
    </div>
  );
}
