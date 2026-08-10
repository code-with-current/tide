import {
  Search,
  Plus,
  MoreHorizontal,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  ArchiveIcon,
  ChevronDown,
  FolderOpen,
  GitFork,
  X,
} from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  useSessions,
  useArchivedSessions,
  useRenameSession,
  useArchiveSession,
  useUnarchiveSession,
  useDeleteSession,
} from "@/lib/queries";
import { useExternalApps } from "@/lib/useExternalApps";
import { useUi } from "@/lib/stores/ui";
import { Dot } from "@/components/primitives";
import { bucketByRecency, cn, formatRelative } from "@/lib/utils";
import { getEffectiveKeys } from "@/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { initiateFork } from "@/lib/queries";
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
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { Session, ArchivedHeader } from "@/types";
import { Kbd } from "@/components/ui/kbd";

const modelLabel: Record<string, string> = {
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-opus-4-1": "Opus 4.1",
  "claude-haiku-4": "Haiku 4",
  "gpt-5": "GPT-5",
  o3: "o3",
  llama3_3: "Llama 3.3",
};

export function SessionsPanel() {
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const setActiveSession = useUi((s) => s.setActiveSession);
  const setMainView = useUi((s) => s.setMainView);
  const runningSessionIds = useUi((s) => s.runningSessionIds);
  const unreadSessionIds = useUi((s) => s.unreadSessionIds);
  const sessionSearchFocus = useUi((s) => s.sessionSearchFocus);
  const overrides = useUi((s) => s.shortcutOverrides);
  const { data: sessions, isLoading } = useSessions(activeWorkspaceId);

  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // The ⌘K / Ctrl+K binding (honors user override + platform default) — shown
  // in the search box hint instead of a hardcoded "⌘ K".
  const searchKbd = getEffectiveKeys("commandPalette", overrides);
  // The ⌘N / Ctrl+N binding for the "New session" button hint.
  const newSessionKbd = getEffectiveKeys("newSession", overrides);

  // Focus the search input when the focusSessionSearch nonce bumps (driven by
  // the commandPalette shortcut action). Also clears the query so the user
  // starts a fresh search.
  useEffect(() => {
    if (sessionSearchFocus > 0 && searchRef.current) {
      searchRef.current.focus();
      searchRef.current.select();
    }
  }, [sessionSearchFocus]);

  // Filter sessions by the query against title (case-insensitive). When a query
  // is active we show a flat list of matches (no recency buckets) so results
  // aren't hidden under collapsed headers.
  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmed || !sessions) return null;
    return sessions.filter((s) => s.title.toLowerCase().includes(trimmed));
  }, [sessions, trimmed]);

  const buckets = !filtered && sessions ? bucketByRecency(sessions) : [];

  return (
    <aside className="bg-background flex flex-col h-full overflow-hidden">
      {/* Workspace context removed — the ChatSubBar now shows workspace name,
          git branch, and file info. This panel is just the sessions list. */}

      <div className="p-2 flex flex-col gap-2 flex-shrink-0 space-y-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs bg-card focus-within:ring-1 focus-within:ring-ring">
          <Search className="size-3.5 text-muted-foreground flex-shrink-0" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape: clear the query and blur, swallowing the keystroke so
              // the global dismissPrompt (Esc) handler doesn't also fire.
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (query) {
                  setQuery("");
                } else {
                  searchRef.current?.blur();
                }
              }
            }}
            placeholder="Search sessions…"
            className="flex-1 min-w-0 bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              className="text-muted-foreground hover:text-foreground flex-shrink-0"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            searchKbd.length > 0 && (
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {searchKbd.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </div>
            )
          )}
        </div>
        <Button
          size="sm"
          className="w-full align-middle font-medium"
          onClick={() => {
            setActiveSession(null);
            setMainView("new");
          }}
        >
          <Plus/> New Session
          <span className="ml-auto flex items-center gap-0.5 pointer-events-none">
            {newSessionKbd.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </span>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto scroll px-2 pb-2">
        {isLoading && (
          <div className="text-xs text-muted-foreground/60 px-2 py-1">
            Loading…
          </div>
        )}
        {!isLoading && sessions?.length === 0 && (
          <div className="text-xs text-muted-foreground/60 px-2 py-4 text-center">
            No sessions yet. Click "New session" to start.
          </div>
        )}

        {filtered ? (
          // Search-results mode: flat list of matches (no recency headers).
          filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground/60 px-2 py-4 text-center">
              No sessions match "{query}".
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  isRunning={runningSessionIds.includes(s.id)}
                  isUnread={unreadSessionIds.includes(s.id)}
                  onClick={() => setActiveSession(s.id)}
                />
              ))}
            </div>
          )
        ) : (
          // Default mode: sessions grouped by recency (Today / Yesterday / Older).
          buckets.map((bucket) => (
            <div key={bucket.label}>
              <div className="text-[0.7143rem] uppercase tracking-wider text-muted-foreground/60 font-semibold mt-3 mb-1 px-1">
                {bucket.label}
              </div>
              <div className="space-y-0.5">
                {bucket.items.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    isRunning={runningSessionIds.includes(s.id)}
                    isUnread={unreadSessionIds.includes(s.id)}
                    onClick={() => setActiveSession(s.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}

        {!filtered && activeWorkspaceId && (
          <ArchivedSessionsSection workspaceId={activeWorkspaceId} />
        )}
      </div>
    </aside>
  );
}

/** SessionItem: sidebar row using div role=button (so the ⋯ menu can nest inside); archived rows show Unarchive/Delete, active rows show Rename/Archive; inline rename commits on Enter/blur. */
function SessionItem({
  session,
  active,
  isRunning,
  isUnread,
  onClick,
  archived = false,
}: {
  session: Session | ArchivedHeader;
  active: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  archived?: boolean;
}) {
  // Hooks have to be unconditional, so we use the workspaceId from the
  // session itself. For active rows, Session has workspaceId; for archived
  // rows, ArchivedHeader has workspaceId. Both shapes carry it.
  const workspaceId = session.workspaceId;
  // Shimmer the title while its LLM-generated name is in flight. Subscribed
  // per-item so only the generating row re-renders.
  const titleGenerating = useUi((s) => s.titleGeneratingSessionIds.has(session.id));
  const renameSession = useRenameSession(workspaceId);
  const archiveSession = useArchiveSession(workspaceId);
  const unarchiveSession = useUnarchiveSession(workspaceId);
  const deleteSession = useDeleteSession(workspaceId);
  // "Open with…" submenu — detected apps + open handler shared with the
  // top-bar OpenInAppMenu. Opens THIS session's folder in the picked app.
  const { visibleApps, pickApp, renderAppIcon } = useExternalApps();

  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  // Reset the draft if the underlying title changes while not actively editing
  // (e.g. another tab renamed it). When entering rename mode, seed from current.
  useEffect(() => {
    if (!isRenaming) setDraftTitle(session.title);
  }, [session.title, isRenaming]);

  const commitRename = () => {
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== session.title) {
      renameSession.mutate({ id: session.id, title: trimmed });
    }
    setIsRenaming(false);
  };

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    // Don't intercept Enter/Space while the inline rename input has focus.
    if (isRenaming) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  const title = session.title;
  const modelId = "modelId" in session ? session.modelId : undefined;
  const updatedAt = session.updatedAt;
  // ArchivedHeader is a strict subset of Session (no exposedPorts), so the
  // cast is safe inside `!archived` gates. Kept inline so we don't need a
  // user-defined guard function for a single field access.
  const exposedPorts = !archived
    ? (session as Session).exposedPorts
    : undefined;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!isRenaming) onClick();
          }}
          onKeyDown={handleRowKeyDown}
          className={cn(
            "group w-full px-2.5 py-1.5 rounded-md text-left flex flex-col gap-0.5 transition-colors cursor-default outline-none focus-visible:ring-1 focus-visible:ring-ring",
            active
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary",
          )}
        >
          <div className="flex items-center gap-2">
            {/* Precedence: running > unread > idle. The green dot is an unread
            badge that clears when the user views the session — not a
            permanent "has messages" marker. */}
            {!archived &&
              (isRunning ? (
                <Dot tone="warn" pulse="heartbeat" />
              ) : isUnread ? (
                <Dot tone="ok" />
              ) : (
                <Dot tone="muted" />
              ))}
            {archived && (
              <Archive className="size-3 text-muted-foreground/60 flex-shrink-0" />
            )}
            {isRenaming ? (
              <Input
                ref={inputRef}
                className="h-5 text-xs font-medium px-1 py-0 flex-1"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setDraftTitle(session.title);
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
                  active && "text-foreground",
                  archived && "text-muted-foreground/60",
                  titleGenerating && "animate-shimmer-title",
                )}
              >
                {title}
              </div>
            )}
            {!isRenaming && (
              <div className="relative flex items-center">
                {/* ⋯ menu trigger — invisible until row hover. opacity transition
                keeps the sidebar visually quiet. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={cn(
                        "p-1 rounded hover:bg-accent text-muted-foreground/60 hover:text-foreground transition-opacity",
                        active
                          ? "opacity-60"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Session actions"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem
                      onClick={() => {
                        setIsRenaming(true);
                      }}
                    >
                      <Pencil className="size-3.5" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => initiateFork(session.id)}>
                      <GitFork className="size-3.5" /> Fork…
                    </DropdownMenuItem>
                    {!archived ? (
                      <DropdownMenuItem
                        onClick={() => archiveSession.mutate(session.id)}
                      >
                        <Archive className="size-3.5" /> Archive
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem
                          onClick={() => unarchiveSession.mutate(session.id)}
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
              </div>
            )}
          </div>
          {!isRenaming && (
            <div className="text-[0.7rem] text-muted-foreground/60 flex items-center gap-1.5 pl-4">
              {modelId && (
                <>
                  <span>{modelLabel[modelId] ?? modelId}</span>
                  <span>·</span>
                </>
              )}
              <span>{formatRelative(updatedAt)}</span>
              {exposedPorts && exposedPorts.length > 0 && (
                <>
                  <span>·</span>
                  {exposedPorts.map((p) => (
                    <a
                      key={p.port}
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-0.5 text-success hover:underline font-mono"
                      title={`${p.label} — ${p.url}`}
                    >
                      :{p.port}
                    </a>
                  ))}
                </>
              )}
              {archived && <span className="italic">archived</span>}
            </div>
          )}

          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Delete session permanently?</DialogTitle>
              </DialogHeader>
              <p className="text-xs text-muted-foreground px-1 -mt-1">
                "{title}" and all its messages will be removed from disk. This
                can't be undone.
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
                    deleteSession.mutate(session.id);
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
        (same handlers, same archived gating, same delete-confirmation flow),
        plus an "Open with" submenu listing detected external apps. */}
      <ContextMenuContent className="w-40">
        {/* Open with — submenu of detected apps (Finder/File Explorer,
          Terminal, VSCode, Zed). Opens THIS session's folder; picking one
          promotes it to the persisted default (shared with the top-bar menu). */}

        <ContextMenuItem
          onClick={() => {
            setIsRenaming(true);
          }}
        >
          <Pencil className="size-3.5" /> Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={() => initiateFork(session.id)}>
          <GitFork className="size-3.5" /> Fork…
        </ContextMenuItem>
        {!archived ? (
          <ContextMenuItem onClick={() => archiveSession.mutate(session.id)}>
            <Archive className="size-3.5" /> Archive
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem
              onClick={() => unarchiveSession.mutate(session.id)}
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
        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2">
            <FolderOpen className="size-3.5" />
            <span>Open with</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {visibleApps.length === 0 ? (
              <ContextMenuItem disabled>No apps available</ContextMenuItem>
            ) : (
              visibleApps.map((app) => (
                <ContextMenuItem
                  key={app.id}
                  onSelect={() => pickApp(app.id, session.id)}
                  className="gap-2"
                >
                  {renderAppIcon(app, "size-3.5")}
                  <span className="flex-1">{app.label}</span>
                </ContextMenuItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Collapsible "Archived" section at the bottom of the SessionsPanel; defaults closed, shows a count, and reuses <SessionItem archived />. */
function ArchivedSessionsSection({ workspaceId }: { workspaceId: string }) {
  const { data: archived } = useArchivedSessions(workspaceId);
  const [open, setOpen] = useState(false);
  const count = archived?.length ?? 0;
  if (count === 0) return null;

  return (
    <div className="mt-4">
      <Button
        variant="secondary"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2 py-1 flex items-center gap-1.5 text-[0.7143rem] uppercase justify-start"
      >
        <ArchiveIcon className="size-3" />
        Archived ({count})
        <ChevronDown
          className={cn(
            "size-3 transition-transform ml-auto",
            open && "rotate-180",
          )}
        />
      </Button>
      {open && (
        <div className="space-y-0.5 mt-1">
          {archived!.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              archived
              active={false}
              onClick={() => {
                /* archived rows aren't selectable */
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
