import { Search, Plus, MoreHorizontal, Pencil, Archive, ArchiveRestore, Trash2, ArchiveIcon, ChevronDown } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useSessions, useArchivedSessions, useRenameSession, useArchiveSession, useUnarchiveSession, useDeleteSession } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';
import { Dot } from '@/components/primitives';
import { bucketByRecency, cn, formatRelative } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { Session, ArchivedHeader } from '@/types';
import { Kbd } from "@/components/ui/kbd"

const modelLabel: Record<string, string> = {
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-opus-4-1': 'Opus 4.1',
  'claude-haiku-4': 'Haiku 4',
  'gpt-5': 'GPT-5',
  o3: 'o3',
  llama3_3: 'Llama 3.3',
};

export function SessionsPanel() {
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeSessionId = useUi((s) => s.activeSessionId);
  const setActiveSession = useUi((s) => s.setActiveSession);
  const setMainView = useUi((s) => s.setMainView);
  const runningSessionIds = useUi((s) => s.runningSessionIds);
  const unreadSessionIds = useUi((s) => s.unreadSessionIds);
  const { data: sessions, isLoading } = useSessions(activeWorkspaceId);

  const buckets = sessions ? bucketByRecency(sessions) : [];

  return (
    <aside className="bg-background flex flex-col h-full overflow-hidden">
      {/* Workspace context removed — the ChatSubBar now shows workspace name,
          git branch, and file info. This panel is just the sessions list. */}

      <div className="p-2 flex flex-col gap-2 flex-shrink-0 space-y-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground bg-card">
          <Search className="size-3.5" />
          <span className="flex-1">Search sessions…</span>
          <Kbd>⌘ K</Kbd>
        </div>
        <Button
          size="sm"
          className="w-full"
          onClick={() => {
            setActiveSession(null);
            setMainView('new');
          }}
        >
          <Plus className="size-3.5" /> New session
           <Kbd className='ml-auto'>⌘ N</Kbd>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto scroll px-2 pb-2">
        {isLoading && <div className="text-xs text-muted-foreground/60 px-2 py-1">Loading…</div>}
        {!isLoading && sessions?.length === 0 && (
          <div className="text-xs text-muted-foreground/60 px-2 py-4 text-center">
            No sessions yet. Click "New session" to start.
          </div>
        )}
        {buckets.map((bucket) => (
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
        ))}

        {activeWorkspaceId && <ArchivedSessionsSection workspaceId={activeWorkspaceId} />}
      </div>
    </aside>
  );
}

/**
 * SessionItem — sidebar row for one session.
 *
 * Outer element is a `<div role="button">` rather than a `<Button>` so we can
 * nest the ⋯ menu trigger without HTML-invalid button-in-button. The `group`
 * class on the row lets the trigger fade in on hover.
 *
 * `archived` flips which menu items appear (active = Rename + Archive;
 * archived = Rename + Unarchive + Delete). Delete is gated on archive state
 * at the storage layer too — it throws if the session isn't archived first,
 * so we hide the menu item entirely for active rows.
 *
 * Inline rename: clicking Rename swaps the title `<div>` for an `<Input>`,
 * auto-focuses + selects, and commits on Enter or blur (Esc cancels).
 */
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
  const renameSession = useRenameSession(workspaceId);
  const archiveSession = useArchiveSession(workspaceId);
  const unarchiveSession = useUnarchiveSession(workspaceId);
  const deleteSession = useDeleteSession(workspaceId);

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
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  const title = session.title;
  const modelId = 'modelId' in session ? session.modelId : undefined;
  const updatedAt = session.updatedAt;
  // ArchivedHeader is a strict subset of Session (no exposedPorts), so the
  // cast is safe inside `!archived` gates. Kept inline so we don't need a
  // user-defined guard function for a single field access.
  const exposedPorts = !archived ? (session as Session).exposedPorts : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { if (!isRenaming) onClick(); }}
      onKeyDown={handleRowKeyDown}
      className={cn(
        'group w-full px-2.5 py-1.5 rounded-md text-left flex flex-col gap-0.5 transition-colors cursor-default outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary',
      )}
    >
      <div className="flex items-center gap-2">
        {/* Precedence: running > unread > idle. The green dot is an unread
            badge that clears when the user views the session — not a
            permanent "has messages" marker. */}
        {!archived && (isRunning ? (
          <Dot tone="warn" pulse="heartbeat" />
        ) : isUnread ? (
          <Dot tone="ok" />
        ) : (
          <Dot tone="muted" />
        ))}
        {archived && <Archive className="size-3 text-muted-foreground/60 flex-shrink-0" />}
        {isRenaming ? (
          <Input
            ref={inputRef}
            className="h-5 text-xs font-medium px-1 py-0 flex-1"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
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
              'font-medium flex-1 truncate',
              active && 'text-foreground',
              archived && 'text-muted-foreground/60',
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
                    'p-1 rounded hover:bg-accent text-muted-foreground/60 hover:text-foreground transition-opacity',
                    active ? 'opacity-60' : 'opacity-0 group-hover:opacity-100',
                  )}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Session actions"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onClick={() => { setIsRenaming(true); }}>
                  <Pencil className="size-3.5" /> Rename
                </DropdownMenuItem>
                {!archived ? (
                  <DropdownMenuItem onClick={() => archiveSession.mutate(session.id)}>
                    <Archive className="size-3.5" /> Archive
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem onClick={() => unarchiveSession.mutate(session.id)}>
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
        <div className="text-[0.7143rem] text-muted-foreground/60 flex items-center gap-1.5 pl-4">
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
            "{title}" and all its messages will be removed from disk. This can't be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
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
  );
}

/**
 * Collapsible "Archived" section at the bottom of the SessionsPanel.
 * Defaults closed; shows a count so users know there's something to expand.
 * Each archived row reuses <SessionItem archived /> so the menu and inline
 * rename are identical to the active view.
 */
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
        <ArchiveIcon className='size-3'/>
        Archived ({count})

        <ChevronDown className={cn('size-3 transition-transform ml-auto', open && 'rotate-180')} />

      </Button>
      {open && (
        <div className="space-y-0.5 mt-1">
          {archived!.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              archived
              active={false}
              onClick={() => { /* archived rows aren't selectable */ }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
