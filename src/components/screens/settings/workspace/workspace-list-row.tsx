import { useState } from "react";
import {
  Trash2,
  Pencil,
  Archive,
  ArchiveRestore,
  GitBranch,
  Database,
  FileCode2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useArchiveWorkspace,
  useUnarchiveWorkspace,
  useDeleteWorkspace,
} from "@/lib/queries";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { Workspace } from "@/types";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/quick-tooltip";


// =============================================================
// SIDEBAR ROW — one workspace in the list with right-click context menu (Archive / Unarchive / Delete). Rename selects the workspace; hooks live here per row.
// =============================================================

export function WorkspaceListRow({
  workspace,
  active,
  isEnabled,
  onSelect,
}: {
  workspace: Workspace;
  active: boolean;
  isEnabled: boolean;
  onSelect: (id: string) => void;
}) {
  const archived = !!workspace.archivedAt;
  const archiveWorkspace = useArchiveWorkspace(workspace.id);
  const unarchiveWorkspace = useUnarchiveWorkspace(workspace.id);
  const deleteWorkspace = useDeleteWorkspace(workspace.id);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Rename = select the workspace; the detail column's Name <Input> is where
  // the actual edit happens (single source of truth for the save logic).
  const handleRename = () => onSelect(workspace.id);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* div role="button" (not <button>) so the ContextMenu trigger nests
            cleanly and matches the sidebar row pattern. Keyboard-accessible. */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(workspace.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(workspace.id);
            }
          }}
          className={cn(
            "w-full flex flex-col gap-1 rounded-md px-2.5 py-[7px] text-left text-[0.8571rem] transition-colors cursor-default outline-none focus-visible:ring-1 focus-visible:ring-ring",
            active
              ? "bg-secondary text-foreground"
              : "text-foreground hover:bg-secondary/50 hover:text-foreground/90",
            archived && "opacity-60",
          )}
        >
          <span className="truncate flex-1 leading-tight">{workspace.name}</span>
          {/* Feature icons — always shown, grayed out when the feature is off.
              Git: on when the workspace tracks a branch.
              RAG: on when enabled for this workspace (isEnabled from ragStatus).
              Script: on when at least one lifecycle script is defined. */}
          <div className="flex items-center gap-1.5">
            <Tip label={workspace.branch ? `Git · ${workspace.branch}` : "Git · not initialized"} side="bottom">
              <GitBranch
                className={cn(
                  "size-3 transition-opacity",
                  workspace.branch ? "text-muted-foreground/70" : "text-muted-foreground/20",
                )}
                aria-label="git"
              />
            </Tip>
            <Tip label={isEnabled ? "RAG · enabled" : "RAG · disabled"} side="bottom">
              <Database
                className={cn(
                  "size-3 transition-opacity",
                  isEnabled ? "text-muted-foreground/70" : "text-muted-foreground/20",
                )}
                aria-label="rag"
              />
            </Tip>
            <Tip
              label={
                workspace.scripts && workspace.scripts.length > 0
                  ? `Scripts · ${workspace.scripts.length}`
                  : "Scripts · none"
              }
              side="bottom"
            >
              <FileCode2
                className={cn(
                  "size-3 transition-opacity",
                  workspace.scripts && workspace.scripts.length > 0
                    ? "text-muted-foreground/70"
                    : "text-muted-foreground/20",
                )}
                aria-label="scripts"
              />
            </Tip>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onSelect={handleRename}>
          <Pencil className="size-3.5" /> Rename
        </ContextMenuItem>
        {!archived ? (
          <ContextMenuItem onSelect={() => archiveWorkspace.mutate(workspace.id)}>
            <Archive className="size-3.5" /> Archive
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem onSelect={() => unarchiveWorkspace.mutate(workspace.id)}>
              <ArchiveRestore className="size-3.5" /> Unarchive
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5" /> Delete…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>

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
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
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
    </ContextMenu>
  );
}
