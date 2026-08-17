/** IntegratedSidebar — sessions nested inside workspace items.
 *  Full context menus (right-click + ⋯ dropdown) matching dual panel. */

import { useState, useMemo, useEffect, createContext, useContext, useCallback, type ReactNode } from 'react';
import {
  ChevronRight, FolderCode, Plus,
  Loader2, Settings as SettingsIcon, Archive as ArchiveIcon,
  Pencil, GitFork, Archive, ArchiveRestore,
  Trash2, FolderOpen,
  ChevronDown,
  FolderLock,
  ArrowUp,
  X,
} from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { UpdatePill } from './update-pill';
import { useWorkspaces, useSessions, useArchivedSessions } from '@/lib/queries';
import {
  useRenameWorkspace, useArchiveWorkspace, useUnarchiveWorkspace, useDeleteWorkspace,
  useRenameSession, useArchiveSession, useUnarchiveSession, useDeleteSession,
  initiateFork,
} from '@/lib/queries';
import { useExternalApps } from '@/lib/use-external-apps';
import * as api from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { ThinkingOrb } from 'thinking-orbs';
import { Tip } from '@/components/ui/quick-tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent,
  ContextMenuItem, ContextMenuSeparator, ContextMenuSub,
  ContextMenuSubTrigger, ContextMenuSubContent,
} from '@/components/ui/context-menu';

interface SessionLite { id: string; title: string; updatedAt: string; createdAt: string; }

function workspaceStatus(sessions: SessionLite[] | undefined, runningIds: string[], unreadIds: string[]): 'in_progress' | 'unread' | 'idle' {
  if (!sessions?.length) return 'idle';
  if (sessions.some((s) => runningIds.includes(s.id))) return 'in_progress';
  if (sessions.some((s) => unreadIds.includes(s.id))) return 'unread';
  return 'idle';
}

/** Inline-confirm shared state: only ONE item can be confirming at a time
 *  across the whole sidebar. Asking on a different item auto-cancels the
 *  previous one. Esc cancels the active confirm. */
const InlineConfirmCtx = createContext<{
  activeKey: string | null;
  ask: (key: string) => void;
  cancel: () => void;
}>({ activeKey: null, ask: () => {}, cancel: () => {} });

function InlineConfirmProvider({ children }: { children: ReactNode }) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const ask = useCallback((key: string) => setActiveKey(key), []);
  const cancel = useCallback(() => setActiveKey(null), []);
  // One global Esc listener while any confirm is active.
  useEffect(() => {
    if (activeKey == null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActiveKey(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeKey]);
  return <InlineConfirmCtx.Provider value={{ activeKey, ask, cancel }}>{children}</InlineConfirmCtx.Provider>;
}

/** Confirm state keyed by `key` — confirming is true only for the single active
 *  item; asking here cancels any other active item. */
function useInlineConfirm(key: string) {
  const { activeKey, ask, cancel } = useContext(InlineConfirmCtx);
  return { confirming: activeKey === key, ask: () => ask(key), cancel };
}

/** The inline "Confirm"/"Delete" pill that replaces the action icon once clicked. */
function InlineConfirmButton({ label, destructive, onConfirm }: { label: string; destructive?: boolean; onConfirm: () => void }) {
  return (
    <button type="button"
      onClick={(e) => { e.stopPropagation(); onConfirm(); }}
      className={cn(
        'inline-flex items-center h-5 px-1.5 rounded text-[0.7rem] font-medium cursor-pointer transition-colors flex-shrink-0',
        destructive ? 'bg-destructive/15 text-destructive hover:bg-destructive/25' : 'bg-primary/15 text-primary hover:bg-primary/25',
      )}>
      {label}
    </button>
  );
}

function IntegratedSidebarImpl() {
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const setScreen = useUi((s) => s.setScreen);
  const runningSessionIds = useUi((s) => s.runningSessionIds);
  const unreadSessionIds = useUi((s) => s.unreadSessionIds);
  const terminalPorts = useUi((s) => s.terminalPorts);
  const allTerminals = useUi((s) => s.terminals);
  const isFullScreen = useUi((s) => s.isFullScreen);

  // Sessions → live ports (dev servers running). Same per-session scoping as
  // the top bar's aggregatedPorts: only terminals keyed to that session count,
  // and entries die with the process (main-process reaper clears terminal:ports).
  const sessionPorts = useMemo(() => {
    const map = new Map<string, { port: number; url: string }[]>();
    for (const [sid, terms] of Object.entries(allTerminals)) {
      const seen = new Set<number>();
      const ports: { port: number; url: string }[] = [];
      for (const t of terms) {
        for (const p of terminalPorts[t.id] ?? []) {
          if (seen.has(p.port)) continue;
          seen.add(p.port);
          ports.push({ port: p.port, url: p.url });
        }
      }
      if (ports.length > 0) map.set(sid, ports.sort((a, b) => a.port - b.port));
    }
    return map;
  }, [allTerminals, terminalPorts]);
  const openDialog = useUi((s) => s.openDialog);
  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');

  const { data: workspaces } = useWorkspaces();
  const active = useMemo(() => workspaces?.filter((w) => !w.archivedAt) ?? [], [workspaces]);
  const archived = useMemo(() => workspaces?.filter((w) => w.archivedAt) ?? [], [workspaces]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const toggleExpand = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Keep the workspace we're leaving in the `expanded` set so switching away
  // doesn't auto-collapse it (a workspace otherwise stays open only while active).
  const preserveExpansion = (nextActiveId: string) => {
    if (activeWorkspaceId && activeWorkspaceId !== nextActiveId) {
      setExpanded((prev) => prev.has(activeWorkspaceId) ? prev : new Set(prev).add(activeWorkspaceId));
    }
  };

  const selectWorkspace = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) { toggleExpand(workspaceId); return; }
    preserveExpansion(workspaceId);
    setSwitchingTo(workspaceId);
    const sessions = await api.listSessions(workspaceId);
    const latest = sessions.length > 0 ? sessions.reduce((a, b) => ((a.updatedAt ?? '') > (b.updatedAt ?? '') ? a : b)) : null;
    useUi.setState({ activeWorkspaceId: workspaceId, activeSessionId: latest?.id ?? null, mainView: latest ? 'chat' : 'new', sessionsPanelOpen: true });
    setSwitchingTo(null);
  };

  const selectSession = (workspaceId: string, sessionId: string) => {
    preserveExpansion(workspaceId);
    useUi.setState({ activeWorkspaceId: workspaceId, activeSessionId: sessionId, mainView: 'chat' });
  };

  const newSession = (workspaceId: string) => {
    preserveExpansion(workspaceId);
    useUi.getState().setActiveWorkspace(workspaceId);
    useUi.getState().startNewDraft();
  };

  return (
    <InlineConfirmProvider>
    <aside className="flex flex-col h-full w-full overflow-hidden p-2">
      {/* Spacer clearing the native macOS traffic lights (top-left, 12,12).
          Collapses to zero while fullscreen — the buttons hide there. */}
      {isMac && (
        <div className={cn('flex-shrink-0 drag-region', isFullScreen ? 'h-0' : 'h-8')} />
      )}
      <UpdatePill />
      <div className={cn("px-3 py-2.5 flex items-center justify-between border-b border-foreground flex-shrink-0", !isMac && "drag-region")}>
        <div className="text-[1rem] uppercase tracking-wider text-sidebar-foreground font-bold font-stretch-semi-expanded">Workspaces</div>
        <Tip label="New Session" side="bottom">
          <Button variant="default" size="icon-sm" onClick={() => activeWorkspaceId ? newSession(activeWorkspaceId) : openDialog('addWorkspace')}><Plus /></Button>
        </Tip>
      </div>

      <div className="flex-1 overflow-y-auto scroll p-2 space-y-1">
        {active.map((ws) => (
          <WorkspaceTreeItem key={ws.id} ws={ws}
            isActive={ws.id === activeWorkspaceId} isExpanded={ws.id === activeWorkspaceId || expanded.has(ws.id)}
            isSwitching={switchingTo === ws.id} activeSessionId={activeSessionId}
            runningIds={runningSessionIds} unreadIds={unreadSessionIds} sessionPorts={sessionPorts}
            onToggle={() => toggleExpand(ws.id)} onSelect={() => selectWorkspace(ws.id)}
            onSelectSession={(sid) => selectSession(ws.id, sid)} onNewSession={() => newSession(ws.id)}
          />
        ))}
      </div>

      {/* Archived workspaces — expandable, above the footer */}
      {archived.length > 0 && (
        <div className="flex-shrink-0 border-t border-foreground">
          <button type="button" onClick={() => setShowArchived((v) => !v)}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-[0.7rem] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer">
            <ArchiveIcon className="size-3.5" />
            <span className="uppercase tracking-wider text-[0.8rem] font-medium">Archived</span>
            <span className="text-muted-foreground/40">({archived.length})</span>
            <span className='flex-1'></span>
            <ChevronDown className={cn('size-3 transition-transform', showArchived && 'rotate-180')} />

          </button>
          {showArchived && (
            <div className="px-2 pb-1 max-h-[200px] overflow-y-auto scroll">
              {archived.map((ws) => (
                <ArchivedWorkspaceRow key={ws.id} ws={ws} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="p-2 border-t border-foreground space-y-2 flex-shrink-0">
        <Button variant="secondary" onClick={() => openDialog('addWorkspace')} className="w-full flex items-center"><FolderCode className="size-4" /> Add Workspace</Button>
        <Button variant="secondary" onClick={() => setScreen('settings')} className="w-full flex items-center"><SettingsIcon className="size-4" /> Settings</Button>
      </div>
    </aside>
    </InlineConfirmProvider>
  );
}

function WorkspaceTreeItem({
  ws, isActive, isExpanded, isSwitching, activeSessionId, runningIds, unreadIds, sessionPorts,
  onToggle, onSelect, onSelectSession, onNewSession,
}: {
  ws: { id: string; name: string; path: string };
  isActive: boolean; isExpanded: boolean; isSwitching: boolean;
  activeSessionId: string | null; runningIds: string[]; unreadIds: string[]; sessionPorts: Map<string, { port: number; url: string }[]>;
  onToggle: () => void; onSelect: () => void;
  onSelectSession: (sessionId: string) => void; onNewSession: () => void;
}) {
  const { data: sessions } = useSessions(ws.id);

  const draftSessions = useUi((s) => s.draftSessions);
  const composerDrafts = useUi((s) => s.composerDrafts);
  const activeDraftId = useUi((s) => s.activeDraftId);
  const selectDraft = useUi((s) => s.selectDraft);
  const deleteDraft = useUi((s) => s.deleteDraft);
  const workspaceDrafts = useMemo(
    () => Object.values(draftSessions)
      .filter((d) => d.workspaceId === ws.id)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [draftSessions, ws.id],
  );

  // Latest first: most recently active session (by updatedAt, falling back to
  // createdAt) sits at the top. ISO strings compare chronologically.
  const sorted = useMemo(
    () =>
      (sessions ?? []).slice().sort(
        (a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''),
      ),
    [sessions],
  );
  const status = workspaceStatus(sessions, runningIds, unreadIds);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(ws.name);
  const renameWs = useRenameWorkspace();
  const archiveWs = useArchiveWorkspace(ws.id);
  const archiveConfirm = useInlineConfirm(`w:${ws.id}`);
  const doRename = () => { if (renameValue.trim() && renameValue !== ws.name) renameWs.mutate({ id: ws.id, name: renameValue.trim() }); setIsRenaming(false); };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div role="button" onClick={onSelect}
            className={cn('group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors min-w-0', !isActive && 'hover:bg-secondary/40')}>
            <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(); }} className="flex-shrink-0 p-0 text-sidebar-foreground/60 hover:text-sidebar-foreground cursor-pointer">
              <ChevronRight className={cn('size-3.5 transition-transform', isExpanded && 'rotate-90')} />
            </button>
            {isSwitching ? <Loader2 className="size-4 text-primary animate-spin flex-shrink-0" />
              : <FolderCode className={cn('size-4 flex-shrink-0', isActive ? 'text-sidebar-foreground' : 'text-muted-foreground')} />}
            {isRenaming ? (
              <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onBlur={doRename}
                onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(ws.name); } }}
                autoFocus className="flex-1 h-6 text-[0.85rem]" />
            ) : (
              <span className={cn('text-[0.9rem] truncate flex-1', isActive ? 'text-sidebar-foreground font-semibold' : 'text-muted-foreground')}>{ws.name}</span>
            )}
            {status === 'in_progress' && (
              <ThinkingOrb
                state="composing"
                size={20}
                speed={2}
                aria-label="Running"
                className="flex-shrink-0"
                style={{ filter: 'sepia(1) saturate(4) brightness(0.95)' }}
              />
            )}
            {/*{status === 'unread' && <Dot tone="ok" />}*/}
             {(status !== 'in_progress' && status !== 'unread') && <div className="flex items-center flex-shrink-0">
              {archiveConfirm.confirming ? (
                <InlineConfirmButton label="Confirm" onConfirm={() => { archiveConfirm.cancel(); archiveWs.mutate(ws.id); }} />
              ) : (
                <Tip label="Archive" side="top">
                  <button type="button" aria-label="Archive workspace"
                    onClick={(e) => { e.stopPropagation(); archiveConfirm.ask(); }}
                    className="hidden group-hover:inline-flex items-center justify-center size-5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary cursor-pointer">
                    <Archive className="size-3.5" />
                  </button>
                </Tip>
              )}

            </div>
             }
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem onClick={(e) => { e.stopPropagation(); onNewSession(); }} ><Plus className="size-3.5" /> New Session</ContextMenuItem>
          <ContextMenuItem onClick={() => setIsRenaming(true)}><Pencil className="size-3.5" /> Rename</ContextMenuItem>
          <ContextMenuItem onClick={() => archiveConfirm.ask()}><Archive className="size-3.5" /> Archive</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isExpanded && (sorted.length > 0 || workspaceDrafts.length > 0) && (
        <div className="mt-1 mb-1 space-y-0.5">
          {workspaceDrafts.map((d) => (
            <DraftTreeItem key={d.id} text={composerDrafts[d.id] ?? ''}
              isActive={d.id === activeDraftId}
              onSelectDraft={() => selectDraft(d.id)}
              onDelete={() => deleteDraft(d.id)} />
          ))}
          {sorted.slice(0, 20).map((s, idx) => (
            <SessionTreeItem key={s.id} session={s} workspaceId={ws.id}
              isLast={idx === Math.min(sorted.length, 20) - 1}
              isActive={s.id === activeSessionId} isRunning={runningIds.includes(s.id)} isUnread={unreadIds.includes(s.id)} ports={sessionPorts.get(s.id)}
              onSelect={() => onSelectSession(s.id)} />
          ))}
          {sorted.length > 20 && <div style={{ paddingLeft: '25px' }} className="py-0.5 text-[0.7rem] text-muted-foreground/40">+{sorted.length - 20} more</div>}
          <ArchivedSessionsSection workspaceId={ws.id} />
        </div>
      )}
    </div>
  );
}

function DraftTreeItem({
  text, isActive, onSelectDraft, onDelete,
}: {
  text: string; isActive: boolean; onSelectDraft: () => void; onDelete: () => void;
}) {
  const firstLine = text.split('\n')[0].trim() || 'New draft';
  return (
    <div role="button" onClick={onSelectDraft}
      className={cn('group/s rounded-md cursor-pointer transition-colors min-w-0',
        isActive ? 'bg-secondary/60 text-sidebar-foreground font-medium' : 'hover:bg-secondary/40 text-muted-foreground')}
      style={{ paddingLeft: '25px', paddingRight: '4px' }}>
      <div className="flex items-center py-1.5">
        <span className="text-muted-foreground/30 text-[0.7rem] font-mono select-none flex-shrink-0 leading-none mr-1.5">└─</span>
        <span className={cn('text-[0.85rem] truncate flex-1 pr-2 italic', !isActive && 'text-muted-foreground/80')}>
          <span className="text-muted-foreground/60 not-italic">(draft)</span>{' '}
          {firstLine}
        </span>
        <button type="button" aria-label="Discard draft"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="hidden group-hover/s:inline-flex items-center justify-center size-5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-secondary cursor-pointer">
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}

function SessionTreeItem({
  session, workspaceId, isLast, isActive, isRunning, isUnread, ports, onSelect,
}: {
  session: SessionLite; workspaceId: string; isLast: boolean; isActive: boolean; isRunning: boolean; isUnread: boolean; ports?: { port: number; url: string }[]; onSelect: () => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const renameSession = useRenameSession(workspaceId);
  const archiveSession = useArchiveSession(workspaceId);
  const archiveConfirm = useInlineConfirm(`s:${session.id}`);
  const { visibleApps, pickApp, renderAppIcon } = useExternalApps();
  const doRename = () => { if (renameValue.trim() && renameValue !== session.title) renameSession.mutate({ id: session.id, title: renameValue.trim() }); setIsRenaming(false); };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="button" onClick={onSelect}
          className={cn('group/s rounded-md cursor-pointer transition-colors min-w-0',
            isActive ? 'text-sidebar-foreground font-medium' : 'hover:bg-secondary/40 text-muted-foreground')}
          style={{ paddingLeft: '25px', paddingRight: '4px' }}>
          {/* ── Top row: tree prefix + title + status ── */}
          <div className="flex items-center py-1.5">
            <span className={cn("text-muted-foreground/30 text-[0.7rem] font-mono select-none flex-shrink-0 leading-none mr-1.5", isActive && 'text-sidebar-foreground font-medium')}>{isLast ? '└─' : '├─'}</span>
            {isRenaming ? (
              <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onBlur={doRename}
                onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(session.title); } }}
                autoFocus className="flex-1 h-5 text-[0.78rem] bg-input border border-input rounded px-1 py-1 outline-none focus:border-primary/60" />
            ) : (
              <span className={cn('text-[0.85rem] truncate flex-1 pr-2', isActive && 'text-sidebar-foreground font-medium')}>{session.title || 'Untitled'}</span>
            )}
            {isRunning ? (
              <ElapsedBadge />
            ) : archiveConfirm.confirming ? (
              <InlineConfirmButton label="Confirm" onConfirm={() => { archiveConfirm.cancel(); archiveSession.mutate(session.id); }} />
            ) : (
              <>
                {isUnread && (
                  <span aria-label="Unread" className="size-1.5 rounded-full bg-success flex-shrink-0" />
                )}
                {!isUnread && (
                  <span className="text-[0.7rem] font-mono text-muted-foreground/40 flex-shrink-0 tabular-nums group-hover/s:hidden">{formatLastChat(session.updatedAt)}</span>
                )}
                {(!(ports && ports.length > 0) && !isUnread) && (
                  <Tip label="Archive" side="top">
                    <button type="button" aria-label="Archive session"
                      onClick={(e) => { e.stopPropagation(); archiveConfirm.ask(); }}
                      className="hidden group-hover/s:inline-flex items-center justify-center size-5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary cursor-pointer">
                      <Archive className="size-3.5" />
                    </button>
                  </Tip>
                )}
              </>
            )}
          </div>
          {/* ── Bottom row: port indicators ── */}
          {ports && ports.length > 0 && (
            <div className="flex items-center gap-1.5 pb-1.5 pl-5">
              {/* Normal: just dots. Hover: full port pills. */}
              <div className="flex items-center gap-1 group-hover/s:hidden">
                {ports.map((p) => (
                  <span key={p.port} className="size-1.5 rounded-full bg-info animate-pulse" />
                ))}
              </div>
              <div className="hidden group-hover/s:flex items-center gap-1">
                {ports.map((p) => (
                  <Tip key={p.port} label={`:${p.port}`} side="top">
                    <a href={p.url} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 h-4 px-1.5 rounded-full text-[0.6rem] font-mono font-medium text-info bg-info/10 border border-info/20 hover:bg-info/20 hover:border-info/40 transition-all cursor-pointer">
                      <span className="size-1 rounded-full bg-info" />
                      :{p.port}
                    </a>
                  </Tip>
                ))}
              </div>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={() => setIsRenaming(true)}><Pencil className="size-3.5" /> Rename</ContextMenuItem>
        <ContextMenuItem onClick={() => initiateFork(session.id)}><GitFork className="size-3.5" /> Fork…</ContextMenuItem>
        <ContextMenuItem onClick={() => archiveConfirm.ask()}><Archive className="size-3.5" /> Archive</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2"><FolderOpen className="size-3.5" /><span>Open with</span></ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {visibleApps.length === 0 ? <ContextMenuItem disabled>No apps available</ContextMenuItem>
              : visibleApps.map((app) => (
                <ContextMenuItem key={app.id} onSelect={() => pickApp(app.id, session.id)} className="gap-2">
                  {renderAppIcon(app, 'size-3.5')}<span className="flex-1">{app.label}</span>
                </ContextMenuItem>
              ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Archived workspace row (Unarchive + Delete) ─────────────────────

function ArchivedWorkspaceRow({ ws }: { ws: { id: string; name: string } }) {
  const del = useInlineConfirm(`aw:${ws.id}`);
  const unarchiveWs = useUnarchiveWorkspace(ws.id);
  const deleteWs = useDeleteWorkspace(ws.id);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors min-w-0 hover:bg-secondary/60">
          <FolderLock className="size-4 flex-shrink-0 text-muted-foreground" />
          <span className="text-[0.9rem] truncate flex-1 text-muted-foreground">{ws.name}</span>
          {del.confirming ? (
            <InlineConfirmButton label="Delete" destructive onConfirm={() => { del.cancel(); deleteWs.mutate(ws.id); }} />
          ) : (
            <div className="hidden group-hover:flex items-center flex-shrink-0">
              <Tip label="Unarchive" side="top">
                <button type="button" aria-label="Unarchive workspace"
                  onClick={(e) => { e.stopPropagation(); unarchiveWs.mutate(ws.id); }}
                  className="inline-flex items-center justify-center size-5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary cursor-pointer">
                  <ArrowUp className="size-3.5" />
                </button>
              </Tip>
              <Tip label="Delete" side="top">
                <button type="button" aria-label="Delete workspace"
                  onClick={(e) => { e.stopPropagation(); del.ask(); }}
                  className="inline-flex items-center justify-center size-5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-secondary cursor-pointer">
                  <Trash2 className="size-3.5" />
                </button>
              </Tip>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={() => unarchiveWs.mutate(ws.id)}><ArchiveRestore className="size-3.5" /> Unarchive</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => del.ask()}><Trash2 className="size-3.5" /> Delete…</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Archived sessions section (per workspace) ────────────────────────

function ArchivedSessionsSection({ workspaceId }: { workspaceId: string }) {
  const { data: archived } = useArchivedSessions(workspaceId);
  const [open, setOpen] = useState(false);
  if (!archived || archived.length === 0) return null;

  return (
    <div style={{ paddingLeft: '25px' }} className="mt-0.5">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 py-0.5 text-[0.85rem] text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors cursor-pointer">
        {/*<ChevronRight className={cn('size-2.5 transition-transform', open && 'rotate-90')} />*/}
        <ArchiveIcon className="size-3 flex-shrink-0" />
        Archived ({archived.length})
      </button>
      {open && archived.map((s) => (
        <ArchivedSessionRow key={s.id} session={s} workspaceId={workspaceId} />
      ))}
    </div>
  );
}

function ArchivedSessionRow({ session, workspaceId }: { session: { id: string; title: string; updatedAt?: string }; workspaceId: string }) {
  const del = useInlineConfirm(`as:${session.id}`);
  const unarchiveSession = useUnarchiveSession(workspaceId);
  const deleteSession = useDeleteSession(workspaceId);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group/s flex items-center pr-1 py-2 rounded-md cursor-pointer transition-colors min-w-0 hover:bg-secondary/40 text-muted-foreground"
          style={{ paddingLeft: '15px' }}>
          <span className="text-[0.8rem] truncate flex-1">{session.title || 'Untitled'}</span>
          {del.confirming ? (
            <InlineConfirmButton label="Delete" destructive onConfirm={() => { del.cancel(); deleteSession.mutate(session.id); }} />
          ) : (
            <div className="hidden group-hover/s:flex items-center flex-shrink-0">
              <Tip label="Unarchive" side="top">
                <button type="button" aria-label="Unarchive session"
                  onClick={(e) => { e.stopPropagation(); unarchiveSession.mutate(session.id); }}
                  className="inline-flex items-center justify-center size-5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary cursor-pointer">
                  <ArrowUp className="size-3.5" />
                </button>
              </Tip>
              <Tip label="Delete" side="top">
                <button type="button" aria-label="Delete session"
                  onClick={(e) => { e.stopPropagation(); del.ask(); }}
                  className="inline-flex items-center justify-center size-5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-secondary cursor-pointer">
                  <Trash2 className="size-3.5" />
                </button>
              </Tip>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={() => unarchiveSession.mutate(session.id)}><ArchiveRestore className="size-3.5" /> Unarchive</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => del.ask()}><Trash2 className="size-3.5" /> Delete…</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Format last chat time: 1s, 10m, 1d, 30m */
function formatLastChat(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function ElapsedBadge() {
  // Mounted only while isRunning — mount time ≈ turn start, so the clock
  // begins at 0s instead of flashing an epoch-derived value.
  const [startedAt] = useState(() => Date.now());
  const [, force] = useState(0);
  useEffect(() => { const i = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  const elapsed = Date.now() - startedAt;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const label = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
  return <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[0.7rem] font-mono tabular-nums bg-warning/15 text-warning/90">{label}</span>;
}

export const IntegratedSidebar = IntegratedSidebarImpl;
