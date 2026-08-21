/** WindowTopBar — merged with ChatSubBar. Single 40px full-width bar:
 *  [toggle] breadcrumb    drag region    [branch]    [ports][run][scripts]  |  [open-app][terminal][right-panel]
 *  Session-level content (breadcrumb, branch, ports, scripts) hides on workspaceMissing / mainView !== 'chat'. */

import {
  PanelRight, Terminal, PanelRightClose,
  ChevronRight, GitBranch, Play,
  Hammer, ChevronDown, Trash2,
  FolderCode, Info,
  FolderTree,
  GitPullRequestArrow, Check, Plus, Loader2,
} from "lucide-react";
// Square removed — replaced by animate-pulse span for the stop button.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Tip } from "@/components/ui/quick-tooltip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { useUi, terminalScopeKey } from "@/lib/stores/ui";
import { useTabs } from "@/lib/stores/tabs";
import { useWorkspaces, useSession, useGitBranchInfo, useGitRecentBranches } from "@/lib/queries";
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

  // ── Compact mode: measured on the BAR itself (ResizeObserver), not the
  //    window — the bar lives inside the content card, so its real width is
  //    window minus sidebar minus card margins. Below the floor, ports and
  //    scripts collapse (Run/Stop stays); the essential right-side buttons
  //    keep room. ──
  const mainView = useUi((s) => s.mainView);
  const [compact, setCompact] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCompact(el.clientWidth < 880));
    ro.observe(el);
    setCompact(el.clientWidth < 880);
    return () => ro.disconnect();
    // mainView gating: the bar renders null on the new-session screen, so the
    // ref can be empty on first run — re-attach when it mounts.
  }, [mainView]);

  // ── Panel toggles ──
  const toggleTerminal = useUi((s) => s.toggleTerminal);
  const toggleRightPanel = useUi((s) => s.toggleRightPanel);
  const rightPanelOpen = useUi((s) => s.rightPanelOpen);
  const toggleSessionsPanel = useUi((s) => s.toggleSessionsPanel);
  const sidebarMode = useUi((s) => s.sidebarMode);
  const sessionsPanelOpen = useUi((s) => s.sessionsPanelOpen);

  // ── Session context ──
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const addTerminal = useUi((s) => s.addTerminal);
  const allTerminals = useUi((s) => s.terminals);
  const terminalPorts = useUi((s) => s.terminalPorts);

  // ── Right panel view switcher (after activeSessionId is declared) ──
  const rpFeature = useTabs((s) => s.active[activeSessionId ?? 'default'] ?? 'files');
  const rpSetFeature = useTabs((s) => s.setActive);
  const switchTo = (kind: string) => {
    rpSetFeature(activeSessionId ?? 'default', kind as any);
    if (!rightPanelOpen) useUi.setState({ rightPanelOpen: true });
  };

  const { data: workspaces } = useWorkspaces();
  const { data: session } = useSession(activeSessionId);
  // Live branch (reflects mid-session checkouts) — worktree-aware. Falls back
  // to the persisted workspace branch until the first fetch resolves.
  const gitSessionId = session?.worktree ? (activeSessionId ?? undefined) : undefined;
  const { data: gitBranchInfo } = useGitBranchInfo(activeWorkspaceId, gitSessionId);

  // ── Branch switcher dropdown ──
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [pendingCheckout, setPendingCheckout] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [newBranchMode, setNewBranchMode] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [pendingRemoveScript, setPendingRemoveScript] = useState<string | null>(null);
  const { data: recentBranches = [] } = useGitRecentBranches(activeWorkspaceId, gitSessionId, branchMenuOpen);

  const qc = useQueryClient();
  const activeWorkspace = workspaces?.find((w) => w.id === activeWorkspaceId);
  const scripts = activeWorkspace?.scripts ?? [];
  const removeScript = useCallback(async (command: string) => {
    if (!activeWorkspaceId) return;
    const remaining = scripts.filter((s) => s.command !== command);
    await api.updateWorkspace(activeWorkspaceId, { scripts: remaining });
    qc.invalidateQueries({ queryKey: ['workspaces'] });
  }, [activeWorkspaceId, scripts, qc]);
  const doCheckout = useCallback(async (branch: string) => {
    if (!activeWorkspaceId) return;
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      const result = await api.gitCheckout(activeWorkspaceId, branch, gitSessionId);
      if (!result.ok) { setCheckoutError(result.error ?? 'Checkout failed'); return; }
      qc.invalidateQueries({ queryKey: ['gitBranch'] });
      qc.invalidateQueries({ queryKey: ['gitStatus'] });
      qc.invalidateQueries({ queryKey: ['gitLog'] });
      qc.invalidateQueries({ queryKey: ['gitRecentBranches'] });
      setBranchMenuOpen(false);
      setPendingCheckout(null);
    } finally {
      setCheckingOut(false);
    }
  }, [activeWorkspaceId, gitSessionId, qc]);

  const doCreateBranch = useCallback(async () => {
    if (!activeWorkspaceId || !newBranchName.trim()) return;
    setCreatingBranch(true);
    setBranchError(null);
    try {
      const result = await api.gitCreateBranch(activeWorkspaceId, newBranchName.trim(), gitSessionId);
      if (!result.ok) { setBranchError(result.error ?? 'Failed to create branch'); return; }
      qc.invalidateQueries({ queryKey: ['gitBranch'] });
      qc.invalidateQueries({ queryKey: ['gitStatus'] });
      qc.invalidateQueries({ queryKey: ['gitLog'] });
      qc.invalidateQueries({ queryKey: ['gitRecentBranches'] });
      setBranchMenuOpen(false);
      setNewBranchMode(false);
      setNewBranchName('');
    } catch (e: any) {
      setBranchError(e?.message ?? 'Failed to create branch');
    } finally {
      setCreatingBranch(false);
    }
  }, [activeWorkspaceId, gitSessionId, qc, newBranchName]);

  const sessionTitle = session?.title ?? 'New session';
  const gitBranch = gitBranchInfo?.branch ?? activeWorkspace?.branch;
  const showSessionContent = mainView === 'chat' && !!activeWorkspace;

  // ── Scripts logic ──
  const primaryRun = scripts.find((s) => s.kind === 'run' && s.command);
  const setupScripts = scripts.filter((s) => s.kind === 'setup' && s.command);
  const runScripts = scripts.filter((s) => s.kind === 'run' && s.command);
  const primaryRunName = primaryRun?.command.slice(0, 40);

  // Same key Run-script terminals are stored under (activeSessionId falls
  // back to workspaceId before any session exists) — keeps the Run/Stop state
  // and port chips scoped to THIS session, not every session in the workspace.
  const sessionKey = activeSessionId ?? activeWorkspaceId;

  const runTerminal = useMemo(() => {
    if (!primaryRunName || !sessionKey) return undefined;
    return (allTerminals[sessionKey] ?? []).find(
      (t) => stripTermSuffix(t.name) === primaryRunName && t.scriptRunning,
    );
  }, [allTerminals, primaryRunName, sessionKey]);
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
    if (!sessionKey) return [];
    const sessionTerminals = allTerminals[sessionKey] ?? [];
    const activeTids = new Set<string>(sessionTerminals.map((t) => t.id));
    const seen = new Set<number>();
    const out: { port: number; url: string; label: string }[] = [];
    for (const [tid, ports] of Object.entries(terminalPorts)) {
      if (!activeTids.has(tid)) continue;
      const tname = sessionTerminals.find((t) => t.id === tid)?.name;
      for (const p of ports ?? []) {
        if (seen.has(p.port)) continue;
        seen.add(p.port);
        out.push({ ...p, label: tname ? `${tname} — ${p.url}` : `${p.label} — ${p.url}` });
      }
    }
    return out.sort((a, b) => a.port - b.port);
  }, [terminalPorts, allTerminals, sessionKey]);

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
    const sid = terminalScopeKey(useUi.getState());
    addTerminal(sid, cmd.slice(0, 40), cmd);
  }, [addTerminal]);

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
      addTerminal(terminalScopeKey(useUi.getState()), `Run: ${cmd.slice(0, 30)}`);
    }
  }, [activeWorkspaceId, isRunning, addTerminal]);

  // New-session screen: hide the top bar entirely.
  if (mainView !== 'chat') return null;

  return (
    <div
      ref={barRef}
      className="drag-region flex items-center gap-2 border-b border-border flex-shrink-0 overflow-hidden"
      style={{ height: 40 }}
    >
      {/* ══ Far left: sessions toggle + breadcrumb ══ */}
      {sidebarMode === 'dual' && (
        <Tip label="Sessions Panel">
          <Button variant="outline" size="sm" className="ml-2 p-1.5 flex-shrink-0" onClick={toggleSessionsPanel}>
            <PanelRightClose className={cn("size-3.5 transition-transform", { "rotate-180": sessionsPanelOpen })} />
          </Button>
        </Tip>
      )}

      {activeWorkspace && (
        <div className="flex items-center gap-1 ml-2 text-xs text-muted-foreground/60 min-w-0">
          <FolderCode className="size-4 flex-shrink-0 text-muted-foreground " />
          <span className="text-[0.8rem] text-muted-foreground truncate max-w-[120px] min-w-0">{activeWorkspace.name}</span>
          <ChevronRight className="size-4 flex-shrink-0" style={{ opacity: 0.6 }} />
          <span className="text-[0.8rem] text-card-foreground truncate max-w-[200px] min-w-0">{sessionTitle}</span>

          {showSessionContent && gitBranch && (
            <DropdownMenu
              open={branchMenuOpen}
              onOpenChange={(o) => { setBranchMenuOpen(o); if (!o) { setPendingCheckout(null); setCheckoutError(null); setNewBranchMode(false); setNewBranchName(''); setBranchError(null); } }}
            >
              <DropdownMenuTrigger asChild>
                <Badge variant="secondary" className="no-drag py-0.5 px-2 ml-2 cursor-pointer hover:bg-secondary/80 transition-colors select-none">
                  <GitBranch className="size-3.5" style={{ opacity: 0.6 }} />
                  <span className="truncate text-[0.75rem] max-w-[250px] min-w-0">{gitBranch}</span>
                </Badge>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[260px] p-0 overflow-hidden">
                {/* ── Current branch header ── */}
                <div className="flex items-center gap-2 px-3 py-2 bg-secondary/40 border-b border-border">
                  <span className="size-1.5 rounded-full bg-success flex-shrink-0" />
                  <GitBranch className="size-3.5 text-muted-foreground/50 flex-shrink-0" />
                  <span className="flex-1 truncate font-mono text-[0.75rem] font-medium text-foreground">{gitBranch}</span>
                  <span className="text-[0.6rem] uppercase tracking-wider text-muted-foreground/40 flex-shrink-0">current</span>
                </div>

                {/* ── New Branch (inline form or button) ── */}
                {newBranchMode ? (
                  <div className="p-2.5 space-y-2 bg-primary/[0.03] border-b border-border animate-slide-up">
                    <div className="flex items-center gap-1.5 text-[0.65rem] uppercase tracking-wider text-muted-foreground/50 font-semibold">
                      <Plus className="size-2.5" /> New Branch
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        autoFocus
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') doCreateBranch(); if (e.key === 'Escape') { setNewBranchMode(false); setNewBranchName(''); setBranchError(null); } }}
                        placeholder="feature/my-branch"
                        className="flex-1 h-7 text-[0.72rem] font-mono bg-input border border-input rounded-md px-2 outline-none focus:border-primary/60 transition-colors"
                      />
                      <button
                        type="button"
                        disabled={creatingBranch || !newBranchName.trim()}
                        onClick={doCreateBranch}
                        className="flex items-center gap-1 h-7 px-2.5 text-[0.7rem] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:pointer-events-none transition-all flex-shrink-0"
                      >
                        <Check className="size-3" />
                        {creatingBranch ? '…' : 'Create'}
                      </button>
                    </div>
                    {branchError && (
                      <div className="text-[0.65rem] text-destructive/80 flex items-center gap-1">
                        <span className="size-1 rounded-full bg-destructive/60" />
                        {branchError}
                      </div>
                    )}
                  </div>
                ) : null}

                {/* ── Branch list ── */}
                {recentBranches.length > 0 && (
                  <div className="py-1">
                    <div className="px-3 py-1 text-[0.6rem] uppercase tracking-wider text-muted-foreground/40 font-semibold">Switch to</div>
                    {recentBranches.map((b) => (
                      pendingCheckout === b ? (
                        <div key={b} className="flex items-center gap-1.5 mx-1.5 px-2 py-1 bg-primary/10 rounded-md border border-primary/20">
                          <span className="size-1.5 rounded-full bg-primary/50 flex-shrink-0" />
                          <span className="flex-1 truncate font-mono text-[0.72rem] text-foreground">{b}</span>
                          <button
                            type="button"
                            disabled={checkingOut}
                            onClick={() => doCheckout(b)}
                            className="flex items-center gap-1 h-5 px-2 text-[0.65rem] font-semibold rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex-shrink-0"
                          >
                            {checkingOut ? <Loader2 className="size-2.5 animate-spin" /> : <Check className="size-2.5" />}
                            Checkout
                          </button>
                        </div>
                      ) : (
                        <button
                          key={b}
                          type="button"
                          onClick={() => { setPendingCheckout(b); setCheckoutError(null); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/40 transition-colors text-left group"
                        >
                          <span className="size-1.5 rounded-full border border-muted-foreground/20 flex-shrink-0 transition-colors group-hover:border-primary/40" />
                          <span className="truncate font-mono text-[0.72rem] text-muted-foreground group-hover:text-foreground transition-colors">{b}</span>
                          <ChevronRight className="size-3 text-transparent group-hover:text-muted-foreground/40 transition-colors ml-auto flex-shrink-0" />
                        </button>
                      )
                    ))}
                  </div>
                )}
                {recentBranches.length === 0 && !newBranchMode && (
                  <div className="py-4 text-center">
                    <GitBranch className="size-4 text-muted-foreground/20 mx-auto mb-1.5" />
                    <div className="text-[0.7rem] text-muted-foreground/40">No other branches yet</div>
                  </div>
                )}
                {checkoutError && (
                  <div className="mx-2 mb-1 px-2.5 py-1.5 text-[0.65rem] text-destructive/80 bg-destructive/5 rounded-md flex items-center gap-1.5">
                    <span className="size-1 rounded-full bg-destructive/60 flex-shrink-0" />
                    {checkoutError}
                  </div>
                )}

                {/* ── Footer actions ── */}
                <div className="border-t border-border flex">
                  {!newBranchMode && (
                    <button
                      type="button"
                      onClick={() => { setNewBranchMode(true); setBranchError(null); }}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[0.7rem] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                    >
                      <Plus className="size-3" />
                      New Branch
                    </button>
                  )}
                  {newBranchMode && (
                    <button
                      type="button"
                      onClick={() => { setNewBranchMode(false); setNewBranchName(''); setBranchError(null); }}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[0.7rem] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                  <div className="w-px bg-border flex-shrink-0" />
                  <button
                    type="button"
                    onClick={() => { switchTo('git'); setBranchMenuOpen(false); }}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[0.7rem] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                  >
                    <GitPullRequestArrow className="size-3" />
                    Git Panel
                  </button>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      {/* ══ Center: drag region + git branch (centered) ══ */}


      {/* ══ Right-mid: ports + merged run/stop + scripts button group ══
          Collapses (slides left + fades) in compact mode so the essential
          right-side buttons stay visible on narrow windows. */}
      {showSessionContent && (
        <div className="flex flex-1 min-w-0 items-center gap-1 overflow-hidden">
          {/* Port chips — compact glowing pills; collapse in compact mode */}
          <div
            className={cn(
              'flex items-center gap-1 min-w-0 overflow-hidden transition-[max-width,opacity] duration-200 ease-out',
              compact ? 'max-w-0 opacity-0' : 'max-w-[600px] opacity-100',
            )}
          >
          {aggregatedPorts.map((p) => (
            <Tip key={p.port} label={`${p.label}`}>
              <a href={p.url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 h-6 px-1.5 text-[0.65rem] font-mono font-medium rounded-full text-info bg-info/10 border border-info/20 hover:bg-info/20 hover:border-info/40 transition-all">
                <span className="size-1 rounded-full bg-info animate-pulse" />
                {p.port}
              </a>
            </Tip>
          ))}
          </div>

          {/* Run/Stop + Scripts — unified control. Run/Stop stays visible in
              compact mode; only the scripts dropdown collapses. */}
          <div className="flex items-center gap-0.5">
            {primaryRun && (
              <Tip label={isPrimaryRunActive ? `Stop — ${primaryRun.command}` : `Run — ${primaryRun.command}`}>
                <button
                  type="button"
                  onClick={() => isPrimaryRunActive ? stopRunTerminal() : runScriptInTerminal(primaryRun.command)}
                  className={cn(
                    'inline-flex items-center gap-1.5 h-7 px-2.5 text-[0.75rem] font-medium rounded-md transition-all',
                    isPrimaryRunActive
                      ? 'bg-destructive/15 text-destructive hover:bg-destructive/25 border border-destructive/30'
                      : 'bg-success/10 text-success hover:bg-success/20 border border-success/25',
                  )}
                >
                  {isPrimaryRunActive
                    ? <span className="size-2 rounded-sm bg-destructive animate-pulse" />
                    : <Play className="size-2.5 fill-current" />}
                  {isPrimaryRunActive ? 'Stop' : 'Run'}
                </button>
              </Tip>
            )}
            <DropdownMenu open={scriptsOpen} onOpenChange={setScriptsOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title="Scripts"
                  className={cn(
                    'inline-flex items-center gap-1 h-7 px-2 text-[0.75rem] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 rounded-md transition-all',
                    compact && 'max-w-0 opacity-0 px-0 overflow-hidden pointer-events-none',
                    primaryRun && !compact && 'ml-px',
                  )}
                >
                  <Hammer className="size-3" />
                  <ChevronDown className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[260px] p-0 overflow-hidden">
                {/* ── Header ── */}
                <div className="flex items-center gap-2 px-3 py-2 bg-secondary/40 border-b border-border">
                  <Hammer className="size-3.5 text-muted-foreground/50 flex-shrink-0" />
                  <span className="flex-1 text-[0.75rem] font-medium text-foreground">Scripts</span>
                  <span className="text-[0.6rem] uppercase tracking-wider text-muted-foreground/40 flex-shrink-0">{scripts.length} {scripts.length === 1 ? 'script' : 'scripts'}</span>
                </div>

                {scripts.length === 0 ? (
                  /* ── Empty state ── */
                  <div className="py-6 text-center">
                    <Hammer className="size-5 text-muted-foreground/20 mx-auto mb-2" />
                    <div className="text-[0.7rem] text-muted-foreground/40 mb-1">No scripts configured</div>
                    <div className="text-[0.6rem] text-muted-foreground/30">Set them up in workspace settings</div>
                  </div>
                ) : (
                  /* ── Script list ── */
                  <div className="py-1">
                    {/* Run scripts */}
                    {runScripts.length > 0 && (
                      <div>
                        <div className="px-3 py-1 text-[0.6rem] uppercase tracking-wider text-muted-foreground/40 font-semibold">Run Script</div>
                        {runScripts.map((s, i) => (
                          pendingRemoveScript === s.command ? (
                            <div key={`run-${i}`} className="flex items-center gap-1.5 mx-1.5 px-2 py-1 bg-destructive/10 rounded-md border border-destructive/20">
                              <Play className="size-3 text-success/50 flex-shrink-0" />
                              <span className="flex-1 truncate font-mono text-[0.72rem] text-foreground">{s.command}</span>
                              <button type="button"
                                onClick={() => { removeScript(s.command); setPendingRemoveScript(null); }}
                                className="flex items-center gap-1 h-5 px-2 text-[0.65rem] font-semibold rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors flex-shrink-0">
                                <Trash2 className="size-2.5" /> Remove
                              </button>
                            </div>
                          ) : (
                            <div key={`run-${i}`} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/40 transition-colors text-left group">
                              <button type="button" className="flex items-center gap-2 flex-1 min-w-0"
                                onClick={() => { runScriptInTerminal(s.command); setScriptsOpen(false); }}>
                                <Play className="size-3 text-success/50 group-hover:text-success flex-shrink-0 transition-colors" />
                                <code className="font-mono text-[0.72rem] flex-1 truncate text-muted-foreground group-hover:text-foreground transition-colors">{s.command}</code>
                              </button>
                              <ChevronRight className="size-3 text-muted-foreground/20 group-hover:text-transparent flex-shrink-0 transition-all" />
                              <button type="button"
                                onClick={(e) => { e.stopPropagation(); setPendingRemoveScript(s.command); }}
                                className="size-5 flex items-center justify-center rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100">
                                <Trash2 className="size-3" />
                              </button>
                            </div>
                          )
                        ))}
                      </div>
                    )}
                    {/* Setup scripts */}
                    {setupScripts.length > 0 && (
                      <div className={runScripts.length > 0 ? 'mt-1' : ''}>
                        <div className="px-3 py-1 text-[0.6rem] uppercase tracking-wider text-muted-foreground/40 font-semibold">Install Script</div>
                        {setupScripts.map((s, i) => (
                          <button key={`setup-${i}`} type="button"
                            onClick={() => { toggleScript(s.command); setScriptsOpen(false); }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/40 transition-colors text-left group">
                            {isRunning(s.command)
                              ? <span className="size-1.5 rounded-full bg-info animate-pulse flex-shrink-0" />
                              : <span className="size-1.5 rounded-full border border-muted-foreground/20 flex-shrink-0 group-hover:border-info/40 transition-colors" />}
                            <code className="font-mono text-[0.72rem] flex-1 truncate text-muted-foreground group-hover:text-foreground transition-colors">{s.command}</code>
                            {isRunning(s.command)
                              ? <span className="text-[0.6rem] text-info font-medium flex-shrink-0">running</span>
                              : <ChevronRight className="size-3 text-transparent group-hover:text-muted-foreground/40 transition-colors flex-shrink-0" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Footer: configure ── */}
                <div className="border-t border-border">
                  <button type="button"
                    onClick={() => { localStorage.setItem('tide-settings-section', 'workspace'); useUi.getState().setScreen('settings'); setScriptsOpen(false); }}
                    className="w-full flex items-center justify-center gap-1.5 py-2 text-[0.7rem] font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors">
                    <Hammer className="size-3" />
                    Configure Scripts
                  </button>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {/* ══ Far right: open-in-app + terminal + right panel ══ */}
      <div className="flex items-center gap-1.5 flex-shrink-0 mr-2  z-50" style={{ paddingRight: CAPTION_PAD }}>
        <OpenInAppMenu />

        <Tip label="Terminal Panel">
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleTerminal}>
            <Terminal className="size-3.5" />
          </Button>
        </Tip>

        {/* Right Panel Switcher — click to switch the right panel content */}
        <ButtonGroup>
          <Tip label="Inspector">
            <Button
              variant={rpFeature === 'files' && rightPanelOpen ? 'outline' : 'outline'}
              size="sm"
              onClick={() => switchTo('files')}
            >
              <Info className="size-3.5" />
            </Button>
          </Tip>
          <Tip label="Explorer">
            <Button
              variant={rpFeature === 'files' && rightPanelOpen ? 'outline' : 'outline'}
              size="sm"
              onClick={() => switchTo('files')}
            >
              <FolderTree className="size-3.5" />
            </Button>
          </Tip>
          <Tip label="Git">
            <Button
              variant={rpFeature === 'git' && rightPanelOpen ? 'outline' : 'outline'}
              size="sm"
              onClick={() => switchTo('git')}
            >
              <GitPullRequestArrow className="size-3.5" />
            </Button>
          </Tip>
        </ButtonGroup>

        <Tip label="Right Panel">
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleRightPanel}>
            <PanelRight className="size-3.5" />
          </Button>
        </Tip>
      </div>
    </div>
  );
}
