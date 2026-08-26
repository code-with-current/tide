/** UpdateProgressDialog — the consent-flow progress dialog. Opened when the
 *  user clicks Download (release dialog or Settings), when the pill is
 *  clicked mid-download, or when the pill re-prompts "Restart to update"
 *  on a prepared bundle. Shows live download progress, and once the
 *  download finishes its final step: Later (dismiss — the update stays
 *  ready on disk and survives restarts) and Restart Now (apply → relaunch).
 *  Mounted once at the App level alongside the other global dialogs. */

import { ArrowUpToLine, Download, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpdateStore } from '@/lib/stores/update-store';
import { ReleaseNotice } from './release-notice';

export function UpdateProgressDialog() {
  const dialog = useUpdateStore((s) => s.dialog);
  const status = useUpdateStore((s) => s.status);
  const closeDialog = useUpdateStore((s) => s.closeDialog);

  const phase = status?.phase;
  const open =
    dialog === 'progress' &&
    !!status &&
    (phase === 'downloading' || phase === 'downloaded' || phase === 'applying' || (phase === 'error' && !!status.version));

  if (!status || !open) return null;

  const version = status.version ?? '';
  const title =
    phase === 'downloading'
      ? 'Downloading update'
      : phase === 'downloaded'
        ? 'Update ready'
        : phase === 'applying'
          ? 'Restarting…'
          : 'Update failed';
  const description =
    phase === 'downloading'
      ? `Tide v${version} is downloading. You can keep working — this dialog stays up to date.`
      : phase === 'downloaded'
        ? `v${version} is downloaded and verified. Restart now or later — the update is kept on disk.`
        : phase === 'applying'
          ? 'Applying the update and relaunching Tide.'
          : 'The download failed — retry or come back later.';

  return (
    <Dialog open onOpenChange={(o) => { if (!o) closeDialog(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {phase === 'downloading' && <Download className="size-4 text-primary" />}
            {phase === 'downloaded' && <ArrowUpToLine className="size-4 text-primary" />}
            {phase === 'applying' && <Loader2 className="size-4 animate-spin text-primary" />}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ReleaseNotice status={status} fill />
      </DialogContent>
    </Dialog>
  );
}
