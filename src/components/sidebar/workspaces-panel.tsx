import {
  FolderCode,
  Plus,
  Settings,
  MoreHorizontal,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  ChevronDown,
  ArchiveIcon,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import {
  useWorkspaces,
  useSessions,
  useRenameWorkspace,
  useArchiveWorkspace,
  useUnarchiveWorkspace,
  useDeleteWorkspace,
} from "@/lib/queries";
import { useUi } from "@/lib/stores/ui";
import * as api from "@/lib/api/client";
import { Dot } from "@/components/primitives";
import { Tip } from "@/components/ui/quick-tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, isMac } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { Workspace } from "@/types";
import { toast } from "@/lib/toast";

/** Derive a workspace's aggregate status from live signals: in_progress (at least one session running a turn), unread (no sessions running but at least one has unread output), or idle (nothing to show). */
function workspaceStatus(
  sessions: { id: string }[] | undefined,
  runningSessionIds: string[],
  unreadSessionIds: string[],
): "in_progress" | "unread" | "idle" {
  if (!sessions || sessions.length === 0) return "idle";
  if (sessions.some((s) => runningSessionIds.includes(s.id)))
    return "in_progress";
  if (sessions.some((s) => unreadSessionIds.includes(s.id))) return "unread";
  return "idle";
}

export function WorkspacesPanel() {
  const { data: workspaces, isLoading } = useWorkspaces();
  const activeId = useUi((s) => s.activeWorkspaceId);
  const openDialog = useUi((s) => s.openDialog);
  const setScreen = useUi((s) => s.setScreen);
  const runningSessionIds = useUi((s) => s.runningSessionIds);
  const unreadSessionIds = useUi((s) => s.unreadSessionIds);

  const active = workspaces?.filter((w) => !w.archivedAt) ?? [];
  const archived = workspaces?.filter((w) => w.archivedAt) ?? [];

  // Liveness probe: which workspace folders still exist on disk? Batched in
  // one IPC call whenever the workspace list changes. Drives the "missing"
  // indicator so a deleted/moved project folder is visible at a glance
  // rather than only surfacing when a tool fails mid-turn.
  const [missingPaths, setMissingPaths] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) {
      setMissingPaths(new Set());
      return;
    }
    let cancelled = false;
    window.tideIpc?.workspacesExist(workspaces.map((w) => w.path)).then((map) => {
      if (cancelled) return;
      const missing = new Set<string>();
      for (const w of workspaces) {
        if (map[w.path] === false) missing.add(w.path);
      }
      setMissingPaths(missing);
    }).catch(() => { /* probe failure — don't mark anything missing */ });
    return () => { cancelled = true; };
  }, [workspaces]);

  /**
   * Switch to a workspace and restore its most-recent session in one shot. Bypasses setActiveWorkspace (which would clear the session) — instead fetch the workspace's sessions, pick the latest by updatedAt, and set both ids together via direct setState. Sessions exist → activeWorkspaceId + activeSessionId + mainView 'chat'; no sessions → activeWorkspaceId + activeSessionId null + mainView 'new' (composer shows empty state; panel stays open so the user sees the workspace is selected). Sessions panel is always kept open — that's the dual-panel browsing concept.
   */
  // The workspace whose sessions are currently loading (during a switch).
  // Drives a per-row spinner so a slow load reads as "switching," not frozen.
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const handleSelect = async (workspaceId: string) => {
    // Optimistically set the workspace so the highlight follows immediately;
    // the session id resolves a tick later.
    useUi.setState({ activeWorkspaceId: workspaceId, sessionsPanelOpen: true });
    setSwitchingTo(workspaceId);
    try {
      const sessions = await api.listSessions(workspaceId);
      // Pick the latest by updatedAt (or fall back to createdAt). Sessions
      // are persisted with updatedAt bumped on every message add, so this is
      // a stable "most recently active" signal.
      const latest =
        sessions.length > 0
          ? sessions.reduce((a, b) =>
              (a.updatedAt ?? a.createdAt ?? "") >
              (b.updatedAt ?? b.createdAt ?? "")
                ? a
                : b,
            )
          : null;
      if (latest) {
        useUi.setState({
          activeWorkspaceId: workspaceId,
          activeSessionId: latest.id,
          mainView: "chat",
          sessionsPanelOpen: true,
        });
      } else {
        // Empty workspace — start fresh. Session id stays null so the
        // composer's empty state shows; the next send creates a session.
        useUi.setState({
          activeWorkspaceId: workspaceId,
          activeSessionId: null,
          mainView: "new",
          sessionsPanelOpen: true,
        });
      }
    } catch (e) {
      // Network/IPC failure — leave the workspace selected with no session
      // rather than blocking the click. Toast so the user can tell a failure
      // apart from a legitimately empty workspace.
      toast.error("Couldn't load sessions", {
        description: e instanceof Error ? e.message : "IPC call failed",
      });
      useUi.setState({
        activeWorkspaceId: workspaceId,
        activeSessionId: null,
        mainView: "new",
        sessionsPanelOpen: true,
      });
    } finally {
      setSwitchingTo(null);
    }
  };

  return (
    <aside className="flex flex-col h-full w-full overflow-hidden p-2">
      {/* Top spacer — clears the native macOS traffic lights, which render at
          the top-LEFT (over this sidebar) at (12, 12). On Windows/Linux the
          caption buttons sit at the top-RIGHT, so this sidebar needs no
          clearance and the spacer is omitted to avoid a wasted gap. */}
      {isMac && <div className="h-8 flex-shrink-0 drag-region" />}
      <div className={cn("px-3 py-2.5 flex items-center justify-between border-accent-foreground flex-shrink-0 border-b ", !isMac && "drag-region")}>
        <div className="text-[1rem] uppercase tracking-wider text-accent-foreground font-bold font-stretch-semi-expanded">
          Workspaces
        </div>
        <Tip label="Add Workspace" side="bottom">
          <Button
            variant="default"
            size="icon-sm"
            onClick={() => openDialog("addWorkspace")}
          >
            <Plus />
          </Button>
        </Tip>
      </div>

      <div className="flex-shrink-0 flex-1">
        <div className="flex-1 overflow-y-auto scroll p-2 space-y-1">
          {isLoading && (
            <div className="text-xs text-muted-foreground/60 px-2 py-1">
              Loading…
            </div>
          )}

          {active.map((ws) => (
            <WorkspaceItem
              key={ws.id}
              workspace={ws}
              active={ws.id === activeId}
              switching={switchingTo === ws.id}
              missing={missingPaths.has(ws.path)}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelect={() => handleSelect(ws.id)}
            />
          ))}
        </div>


      </div>
      <div className="flex-shrink-0 border-t border-accent-foreground">
      <ArchivedWorkspacesSection
        workspaces={archived}
        runningSessionIds={runningSessionIds}
        unreadSessionIds={unreadSessionIds}
      />
      </div>
      <div className="p-2 border-t border-accent-foreground space-y-2">
        <Button
          variant="secondary"
          onClick={() => openDialog("addWorkspace")}
          className="w-full flex items-center"
          >
          <FolderCode className="size-4" /> Add Workspace
        </Button>
        <Button
          variant="secondary"
          onClick={() => setScreen("settings")}
          className="w-full flex items-center"
        >
          <Settings className="size-4" /> Settings
        </Button>
      </div>
    </aside>
  );
}

/** WorkspaceItem — sidebar row for one workspace. Outer element is a `<div role="button">` (not `<Button>`) so we can nest the ⋯ menu trigger without an HTML-invalid button-in-button; `group` lets the trigger fade in on hover. `archived` (derived from `workspace.archivedAt`) flips which menu items appear; Delete is gated on archive state at the storage layer too, so it's hidden entirely for active rows. */
function WorkspaceItem({
  workspace,
  active,
  switching,
  missing,
  runningSessionIds,
  unreadSessionIds,
  onSelect,
}: {
  workspace: Workspace;
  active: boolean;
  switching?: boolean;
  missing?: boolean;
  runningSessionIds: string[];
  unreadSessionIds: string[];
  onSelect: () => void;
}) {
  const { data: sessions } = useSessions(workspace.id);
  const status = workspaceStatus(sessions, runningSessionIds, unreadSessionIds);
  const archived = !!workspace.archivedAt;

  const renameWorkspace = useRenameWorkspace();
  const archiveWorkspace = useArchiveWorkspace(workspace.id);
  const unarchiveWorkspace = useUnarchiveWorkspace(workspace.id);
  const deleteWorkspace = useDeleteWorkspace(workspace.id);

  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(workspace.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    if (!isRenaming) setDraftName(workspace.name);
  }, [workspace.name, isRenaming]);

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== workspace.name) {
      renameWorkspace.mutate({ id: workspace.id, name: trimmed });
    }
    setIsRenaming(false);
  };

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (isRenaming) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!isRenaming) onSelect();
          }}
          onKeyDown={handleRowKeyDown}
          className={cn(
            "group w-full px-2.5 py-1.5 rounded-md text-left flex flex-col gap-0.5 transition-colors cursor-default outline-none focus-visible:ring-1 focus-visible:ring-ring",
            active
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-secondary",
            archived && "opacity-60",
            missing && "ring-1 ring-warning/30",
          )}
          title={missing ? `Folder missing: ${workspace.path}` : undefined}
        >
          <div className="flex items-center gap-2">
            {missing ? (
              <AlertTriangle
                className="size-3.5 flex-shrink-0 text-warning"
                aria-label="Folder missing"
              />
            ) : (
              <FolderCode
                className={cn(
                  "size-3.5 flex-shrink-0",
                  active ? "text-primary" : "text-muted-foreground/60",
                )}
              />
            )}
            {isRenaming ? (
              <Input
                ref={inputRef}
                className="h-5 text-xs font-medium px-1 py-0 flex-1"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setDraftName(workspace.name);
                    setIsRenaming(false);
                  }
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div
                className={cn(
                  "text-[0.9rem] flex-1 truncate",
                  active && "text-accent-foreground",
                )}
              >
                {workspace.name || workspace.id}
              </div>
            )}
            {!isRenaming && (
              <>
                {/* Switching spinner — replaces the status dots while this
                    workspace's sessions load, so a slow switch reads as
                    "loading" rather than "selected + idle." */}
                {switching && (
                  <Loader2 className="size-3 animate-spin text-muted-foreground shrink-0" />
                )}
                {!switching && status === "in_progress" && (
                  <span title="Session in progress">
                    <Dot tone="warn" pulse="heartbeat" />
                  </span>
                )}
                {!switching && status === "unread" && (
                  <span title="Unread session output">
                    <Dot tone="ok" />
                  </span>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={cn(
                        "p-1 -mr-1 rounded hover:bg-accent text-muted-foreground/60 hover:text-foreground transition-opacity",
                        active
                          ? "opacity-60"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Workspace actions"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem onClick={() => setIsRenaming(true)}>
                      <Pencil className="size-3.5" /> Rename
                    </DropdownMenuItem>
                    {!archived ? (
                      <DropdownMenuItem
                        onClick={() => archiveWorkspace.mutate(workspace.id)}
                      >
                        <Archive className="size-3.5" /> Archive
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          onClick={() =>
                            unarchiveWorkspace.mutate(workspace.id)
                          }
                        >
                          <ArchiveRestore className="size-3.5" /> Unarchive
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setConfirmDelete(true)}
                        >
                          <Trash2 className="size-3.5" /> Delete…
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
          <div className="text-[0.7rem] text-muted-foreground/60 font-mono pl-5 truncate">
            {shortenPath(workspace.path)}
          </div>

          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Delete workspace permanently?</DialogTitle>
              </DialogHeader>
              <p className="text-xs text-muted-foreground px-1 -mt-1">
                "{workspace.name}" will be removed from Tide. All its archived
                sessions will be permanently deleted from disk. The repository
                folder on disk is not touched. This can't be undone.
              </p>
              <DialogFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    deleteWorkspace.mutate(workspace.id);
                    setConfirmDelete(false);
                  }}
                >
                  <Trash2 className="size-3.5" /> Delete
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </ContextMenuTrigger>
      {/* Right-click context menu — mirrors the ⋯ dropdown actions 1:1
        (same handlers, same archived gating, same delete-confirmation flow). */}
      <ContextMenuContent className="w-40">
        <ContextMenuItem onClick={() => setIsRenaming(true)}>
          <Pencil className="size-3.5" /> Rename
        </ContextMenuItem>
        {!archived ? (
          <ContextMenuItem
            onClick={() => archiveWorkspace.mutate(workspace.id)}
          >
            <Archive className="size-3.5" /> Archive
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem
              onClick={() => unarchiveWorkspace.mutate(workspace.id)}
            >
              <ArchiveRestore className="size-3.5" /> Unarchive
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5" /> Delete…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Collapsible "Archived" section at the bottom of WorkspacesPanel. Defaults closed; renders only when there are archived workspaces. Reuses WorkspaceItem (which derives archived state from workspace.archivedAt) so menu items and inline rename are identical. */
function ArchivedWorkspacesSection({
  workspaces,
  runningSessionIds,
  unreadSessionIds,
}: {
  workspaces: Workspace[];
  runningSessionIds: string[];
  unreadSessionIds: string[];
}) {
  const [open, setOpen] = useState(false);
  if (workspaces.length === 0) return null;

  return (
  <div className="flex-shrink-0">
      <button type="button"
        onClick={() => setOpen((o) => !o)}
      className="w-full flex items-center gap-1.5 px-3 py-2 text-[0.7rem] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer">
      <ArchiveIcon className="size-3.5" />
      <span className="uppercase tracking-wider text-[0.8rem] font-medium">Archived</span>
      <span className="text-muted-foreground/40">({workspaces.length})</span>
      <span className='flex-1'></span>
      <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />


      </button>

      {open && (
        <div className="px-2 mb-2">
          {workspaces.map((ws) => (
            <WorkspaceItem
              key={ws.id}
              workspace={ws}
              active={false}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelect={() => {
                /* archived workspaces aren't selectable */
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Render an absolute path as `~/foo/bar` when under the user's home dir.
 */
let cachedHome: string | null = null;

function shortenPath(p: string): string {
  if (!p) return "";
  if (cachedHome && p.startsWith(cachedHome))
    return "~" + p.slice(cachedHome.length);
  const m = p.match(/^(\/(?:Users|home)\/[^/]+)/);
  if (m) {
    cachedHome = m[1];
    return "~" + p.slice(cachedHome.length);
  }
  return p;
}
