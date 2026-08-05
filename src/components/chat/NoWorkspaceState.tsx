import { FolderGit2, Plus, ArrowLeft } from 'lucide-react';
import { useUi } from '@/lib/stores/ui';
import { useWorkspaces } from '@/lib/queries';
import { Tag } from '@/components/primitives';
import { Button } from '@/components/ui/button';

/** Shown when no workspace is selected (startup or deselected). Distinct from EmptyChatState (which assumes a workspace is active). */
export function NoWorkspaceState() {
  const openDialog = useUi((s) => s.openDialog);
  const setActive = useUi((s) => s.setActiveWorkspace);
  const { data: workspaces } = useWorkspaces();
  const hasWorkspaces = !!workspaces && workspaces.length > 0;

  return (
    <div className="flex-1 overflow-y-auto scroll">
      <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 gap-6 min-h-full">
        <div className="flex items-center gap-2 text-muted-foreground/60">
          <Tag className="inline-flex items-center gap-1">
            <FolderGit2 className="size-3" /> No workspace
          </Tag>
        </div>

        <div className="flex flex-col items-center gap-3">
          <div className="size-12 rounded-2xl bg-secondary border border-input flex items-center justify-center">
            <FolderGit2 className="size-5 text-muted-foreground/60" />
          </div>
          <div className="text-center">
            <h2 className="text-xl font-semibold tracking-tight">
              {hasWorkspaces ? 'Select a workspace' : 'Add a workspace to begin'}
            </h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              {hasWorkspaces
                ? 'Pick one from the sidebar, or add another folder.'
                : 'Tide works on a local folder. Add one to start chatting — reads run freely, first edit creates a worktree.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => openDialog('addWorkspace')}
            className="inline-flex items-center gap-2 rounded-lg bg-primary text-white text-sm font-medium px-4 py-2 hover:bg-accent/90 transition-colors"
          >
            <Plus className="size-4" /> Add Workspace
          </Button>
          {hasWorkspaces && (
            <Button
              onClick={() => {
                // Select the first workspace — user has them but none active.
                const first = workspaces?.[0];
                if (first) setActive(first.id);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-border text-muted-foreground text-sm px-3 py-2 hover:bg-secondary hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-4" /> Use first workspace
            </Button>
          )}
        </div>

        <div className="text-[11px] text-muted-foreground/60 max-w-md text-center">
          Tide never edits your working tree directly. Each session gets an
          isolated worktree under <Tag>.agent/worktrees/&lt;session&gt;</Tag>.
        </div>
      </div>
    </div>
  );
}
