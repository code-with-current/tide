/** MissingWorkspaceScreen: shown when the active workspace's folder is gone. Offers Delete or "I've restored it" (re-probe, no silent mkdir). */
import { useState } from 'react';
import { FolderX, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUi } from '@/lib/stores/ui';
import { useDeleteWorkspace, useArchiveWorkspace } from '@/lib/queries';
import { toast } from '@/lib/toast';
import type { Workspace } from '@/types';

export function MissingWorkspaceScreen({
  workspace,
  onRestored,
}: {
  workspace: Workspace;
  /** Called after the user clicks "I've restored it" AND the folder re-check
   *  succeeds. MainScreen uses it to clear its missing-flag + return to the
   *  normal chat/new view. */
  onRestored: () => void;
}) {
  const archiveWorkspace = useArchiveWorkspace(workspace.id);
  const deleteWorkspace = useDeleteWorkspace(workspace.id);
  const [checking, setChecking] = useState(false);

  const handleDelete = () => {
    // The storage layer requires a workspace be archived before it can be
    // deleted (configStore throws "Workspace must be archived before
    // deletion" for active workspaces). MissingWorkspaceScreen offers delete
    // on an active-but-missing workspace, so archive first, then delete.
    archiveWorkspace.mutate(workspace.id, {
      onSuccess: () => {
        deleteWorkspace.mutate(workspace.id, {
          onSuccess: () => {
            // Clear the active selection; MainScreen falls back to no-workspace.
            useUi.setState({ activeWorkspaceId: null, activeSessionId: null, mainView: 'new' });
          },
        });
      },
    });
  };

  const handleRecheck = async () => {
    setChecking(true);
    try {
      const map = await window.tideIpc?.workspacesExist([workspace.path]);
      if (map?.[workspace.path]) {
        toast.success('Workspace folder found');
        onRestored();
      } else {
        toast.error('Folder still missing', {
          description: `Create or restore the folder at:\n${workspace.path}`,
        });
      }
    } catch {
      toast.error("Couldn't verify the folder", {
        description: 'The existence probe failed. Try again or delete the workspace.',
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 text-center">
      {/* Warning icon tile — matches the brand-tile treatment, warning-tinted. */}
      <div className="rounded-2xl flex items-center justify-center mb-5 p-2 border border-warning/25 bg-warning/10">
        <FolderX className="size-15 text-warning" />
      </div>

      <h2 className="text-[17px] font-semibold tracking-tight">Workspace folder is Missing</h2>
      <p className="text-[12px] text-muted-foreground/70 mt-1.5 max-w-[380px] leading-relaxed">
        The folder for <span className="font-medium text-foreground">{workspace.name}</span> can't
        be found. It may have been moved, renamed, or deleted.
      </p>

      <code className="mt-3 text-[11px] font-mono text-muted-foreground/55 bg-secondary/60 border border-border rounded-md px-2.5 py-1.5 max-w-[440px] truncate block">
        {workspace.path}
      </code>

      {/* Recovery options */}
      <div className="flex flex-col sm:flex-row items-center gap-2.5 mt-7 w-full max-w-[420px]">
        <Button
          variant="default"
          size="sm"
          className="gap-1.5 flex-1 w-full sm:w-auto"
          onClick={handleRecheck}
          disabled={checking}
        >
          {checking ? 'Checking…' : "I've restored it"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className='flex-1 w-full'
          onClick={handleDelete}
          disabled={archiveWorkspace.isPending || deleteWorkspace.isPending}
        >
          Delete Workspace
        </Button>
      </div>

      {/* Helper copy explaining the manual-restore flow. */}
      <div className="mt-7 flex items-start gap-2 text-left rounded-lg border border-border/60 bg-secondary/30 px-3.5 py-3 max-w-[440px]">
        <CheckCircle2 className="size-3.5 text-muted-foreground/50 mt-px shrink-0" />
        <p className="text-[11px] leading-relaxed text-muted-foreground/65">
          Recreate or copy the project folder to the path above, then click{' '}
          <span className="font-medium text-foreground">“I’ve restored it”</span> to re-check and
          continue. The workspace record (sessions, scripts, settings) is preserved.
        </p>
      </div>
    </div>
  );
}
