/** IntegratedSidebar — sessions nested inside workspace items.
 *  Full context menus (right-click + ⋯ dropdown) matching dual panel. */

import { useState, useMemo, useEffect, useRef } from 'react';
import {
  ChevronRight, FolderCode, Plus,
  Loader2, Settings as SettingsIcon, Archive as ArchiveIcon,
  Pencil, GitFork, Archive, ArchiveRestore,
  Trash2, FolderOpen,
  ChevronDown,
  FolderLock,
} from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { useWorkspaces, useSessions, useArchivedSessions } from '@/lib/queries';
import {
  useRenameWorkspace, useArchiveWorkspace, useUnarchiveWorkspace, useDeleteWorkspace,
  useRenameSession, useArchiveSession, useUnarchiveSession, useDeleteSession,
  initiateFork,
} from '@/lib/queries';
import { useExternalApps } from '@/lib/use-external-apps';
import * as api from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Dot } from '@/components/primitives';
import { Tip } from '@/components/ui/quick-tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent,
  ContextMenuItem, ContextMenuSeparator, ContextMenuSub,
  ContextMenuSubTrigger, ContextMenuSubContent,
} from '@/components/ui/context-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface SessionLite { id: string; title: string; updatedAt: string; createdAt: string; }

function workspaceStatus(sessions: SessionLite[] | undefined, runningIds: string[], unreadIds: string[]): 'in_progress' | 'unread' | 'idle' {
  if (!sessions?.length) return 'idle';
  if (sessions.some((s) => runningIds.includes(s.id))) return 'in_progress';
  if (sessions.some((s) => unreadIds.includes(s.id))) return 'unread';
  return 'idle';
}

function IntegratedSidebarImpl() {
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const setScreen = useUi((s) => s.setScreen);
  const runningSessionIds = useUi((s) => s.runningSessionIds);
  const unreadSessionIds = useUi((s) => s.unreadSessionIds);
  const openDialog = useUi((s) => s.openDialog);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
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

  const selectWorkspace = async (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) { toggleExpand(workspaceId); return; }
    setSwitchingTo(workspaceId);
    const sessions = await api.listSessions(workspaceId);
    const latest = sessions.length > 0 ? sessions.reduce((a, b) => ((a.updatedAt ?? '') > (b.updatedAt ?? '') ? a : b)) : null;
    useUi.setState({ activeWorkspaceId: workspaceId, activeSessionId: latest?.id ?? null, mainView: latest ? 'chat' : 'new', sessionsPanelOpen: true });
    setSwitchingTo(null);
  };

  const selectSession = (workspaceId: string, sessionId: string) => {
    useUi.setState({ activeWorkspaceId: workspaceId, activeSessionId: sessionId, mainView: 'chat' });
  };

  const newSession = (workspaceId: string) => {
    useUi.setState({ activeWorkspaceId: workspaceId, activeSessionId: null, mainView: 'new', sessionsPanelOpen: true });
  };

  return (
    <aside style={{ width: sidebarWidth }} className="flex flex-col h-full overflow-hidden flex-shrink-0 p-2">
      {isMac && <div className="h-8 flex-shrink-0 drag-region" />}
      <div className={cn("px-3 py-2.5 flex items-center justify-between border-b border-foreground flex-shrink-0", !isMac && "drag-region")}>
        <div className="text-[1rem] uppercase tracking-wider text-sidebar-foreground font-bold font-stretch-semi-expanded">Workspaces</div>
        <Tip label="Add Workspace" side="bottom">
          <Button variant="default" size="icon-sm" onClick={() => openDialog('addWorkspace')}><Plus /></Button>
        </Tip>
      </div>

      <div className="flex-1 overflow-y-auto scroll p-2 space-y-1">
        {active.map((ws) => (
          <WorkspaceTreeItem key={ws.id} ws={ws}
            isActive={ws.id === activeWorkspaceId} isExpanded={ws.id === activeWorkspaceId || expanded.has(ws.id)}
            isSwitching={switchingTo === ws.id} activeSessionId={activeSessionId}
            runningIds={runningSessionIds} unreadIds={unreadSessionIds}
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
  );
}

function WorkspaceTreeItem({
  ws, isActive, isExpanded, isSwitching, activeSessionId, runningIds, unreadIds,
  onToggle, onSelect, onSelectSession, onNewSession,
}: {
  ws: { id: string; name: string; path: string };
  isActive: boolean; isExpanded: boolean; isSwitching: boolean;
  activeSessionId: string | null; runningIds: string[]; unreadIds: string[];
  onToggle: () => void; onSelect: () => void;
  onSelectSession: (sessionId: string) => void; onNewSession: () => void;
}) {
  const { data: sessions } = useSessions(ws.id);
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
  const doRename = () => { if (renameValue.trim() && renameValue !== ws.name) renameWs.mutate({ id: ws.id, name: renameValue.trim() }); setIsRenaming(false); };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div role="button" onClick={onSelect}
            className={cn('group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors min-w-0', !isActive && 'hover:bg-secondary/10')}>
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
            {status === 'in_progress' && <Dot tone="warn" pulse="heartbeat" />}
            {status === 'unread' && <Dot tone="ok" />}
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <Tip label="New Session" side="bottom">
                <Button variant="ghost" size="icon-xs" className="p-0.5 rounded hover:bg-background text-muted-foreground/60 hover:text-sidebar-foreground cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); onNewSession(); }} aria-label="New Session">
                  <Plus className="size-3.5" />
                </Button>
              </Tip>
              {/*<DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" className="p-0.5 rounded hover:bg-background text-muted-foreground/60 hover:text-sidebar-foreground cursor-pointer"
                    onClick={(e) => e.stopPropagation()} aria-label="Workspace actions">
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={onNewSession}><Plus className="size-3.5" /> New Session</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setIsRenaming(true)}><Pencil className="size-3.5" /> Rename</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => archiveWs.mutate(ws.id)}><Archive className="size-3.5" /> Archive</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>*/}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem onClick={(e) => { e.stopPropagation(); onNewSession(); }} ><Plus className="size-3.5" /> New Session</ContextMenuItem>
          <ContextMenuItem onClick={() => setIsRenaming(true)}><Pencil className="size-3.5" /> Rename</ContextMenuItem>
          <ContextMenuItem onClick={() => archiveWs.mutate(ws.id)}><Archive className="size-3.5" /> Archive</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isExpanded && sorted.length > 0 && (
        <div className="mt-1 mb-1 space-y-0.5">
          {sorted.slice(0, 20).map((s, idx) => (
            <SessionTreeItem key={s.id} session={s} workspaceId={ws.id}
              isLast={idx === Math.min(sorted.length, 20) - 1}
              isActive={s.id === activeSessionId} isRunning={runningIds.includes(s.id)} isUnread={unreadIds.includes(s.id)}
              onSelect={() => onSelectSession(s.id)} />
          ))}
          {sorted.length > 20 && <div style={{ paddingLeft: '25px' }} className="py-0.5 text-[0.7rem] text-muted-foreground/40">+{sorted.length - 20} more</div>}
          <ArchivedSessionsSection workspaceId={ws.id} />
        </div>
      )}
    </div>
  );
}

function SessionTreeItem({
  session, workspaceId, isLast, isActive, isRunning, isUnread, onSelect,
}: {
  session: SessionLite; workspaceId: string; isLast: boolean; isActive: boolean; isRunning: boolean; isUnread: boolean; onSelect: () => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const renameSession = useRenameSession(workspaceId);
  const archiveSession = useArchiveSession(workspaceId);
  const { visibleApps, pickApp, renderAppIcon } = useExternalApps();
  const doRename = () => { if (renameValue.trim() && renameValue !== session.title) renameSession.mutate({ id: session.id, title: renameValue.trim() }); setIsRenaming(false); };

  // Track when this session started running — resets when isRunning flips to true.
  const runningSinceRef = useRef<number>(0);
  useEffect(() => {
    if (isRunning && runningSinceRef.current === 0) {
      runningSinceRef.current = Date.now();
    } else if (!isRunning) {
      runningSinceRef.current = 0;
    }
  }, [isRunning]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="button" onClick={onSelect}
          className={cn('group/s flex items-center pr-1 py-2 rounded-md cursor-pointer transition-colors min-w-0',
            isActive ? 'text-sidebar-foreground font-medium' : 'hover:bg-secondary/40 text-muted-foreground')}
          style={{ paddingLeft: '25px' }}>
          <span className={cn("text-muted-foreground/30 text-[0.7rem] font-mono select-none flex-shrink-0 leading-none mr-1.5", isActive && 'text-sidebar-foreground font-medium')}>{isLast ? '└─' : '├─'}</span>
          {isRenaming ? (
            <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onBlur={doRename}
              onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(session.title); } }}
              autoFocus className="flex-1 h-5 text-[0.78rem] bg-input border border-input rounded px-1 py-1 outline-none focus:border-primary/60" />
          ) : (
            <span className={cn('text-[0.85rem] truncate flex-1 pr-2', isActive && 'text-sidebar-foreground font-medium')}>{session.title || 'Untitled'}</span>
          )}
          {isRunning && <ElapsedBadge startedAt={runningSinceRef.current} />}
          {!isRunning && isUnread && <span className="size-1.5 rounded-full bg-success flex-shrink-0" />}
          {!isRunning && <span className="text-[0.7rem] font-mono text-muted-foreground/40 flex-shrink-0 tabular-nums">{formatLastChat(session.updatedAt)}</span>}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={() => setIsRenaming(true)}><Pencil className="size-3.5" /> Rename</ContextMenuItem>
        <ContextMenuItem onClick={() => initiateFork(session.id)}><GitFork className="size-3.5" /> Fork…</ContextMenuItem>
        <ContextMenuItem onClick={() => archiveSession.mutate(session.id)}><Archive className="size-3.5" /> Archive</ContextMenuItem>
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const unarchiveWs = useUnarchiveWorkspace(ws.id);
  const deleteWs = useDeleteWorkspace(ws.id);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors min-w-0 hover:bg-secondary/60">
            <FolderLock className="size-4 flex-shrink-0 text-muted-foreground" />
            <span className="text-[0.9rem] truncate flex-1 text-muted-foreground">{ws.name}</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem onClick={() => unarchiveWs.mutate(ws.id)}><ArchiveRestore className="size-3.5" /> Unarchive</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 className="size-3.5" /> Delete…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete "{ws.name}"?</AlertDialogTitle><AlertDialogDescription>Permanently deletes the workspace and all its sessions.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => { deleteWs.mutate(ws.id); setConfirmDelete(false); }}><Trash2 className="size-3.5" /> Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const unarchiveSession = useUnarchiveSession(workspaceId);
  const deleteSession = useDeleteSession(workspaceId);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/s flex items-center pr-1 py-2 rounded-md cursor-pointer transition-colors min-w-0 hover:bg-secondary/40 text-muted-foreground"
            style={{ paddingLeft: '15px' }}>
            <span className="text-[0.8rem] truncate flex-1">{session.title || 'Untitled'}</span>
            {/*{session.updatedAt && <span className="text-[0.6rem] font-mono text-muted-foreground/40 flex-shrink-0 tabular-nums">{formatLastChat(session.updatedAt)}</span>}*/}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-40">
          <ContextMenuItem onClick={() => unarchiveSession.mutate(session.id)}><ArchiveRestore className="size-3.5" /> Unarchive</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 className="size-3.5" /> Delete…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete session?</AlertDialogTitle><AlertDialogDescription>Permanently delete "{session.title}".</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => { deleteSession.mutate(session.id); setConfirmDelete(false); }}><Trash2 className="size-3.5" /> Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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

function ElapsedBadge({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => { const i = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  const elapsed = Date.now() - startedAt;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const label = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
  return <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[0.7rem] font-mono tabular-nums bg-warning/15 text-warning/90">{label}</span>;
}

export const IntegratedSidebar = IntegratedSidebarImpl;
