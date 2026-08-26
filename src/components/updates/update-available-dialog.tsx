/** UpdateAvailableDialog — the main-screen release-details dialog opened
 *  from the update pill while an update waits for consent (or a
 *  consent-driven download failed and offers a retry). Shows the release
 *  notice (version transition + markdown changelog + Download); clicking
 *  Download swaps to the progress dialog via the shared store. Mounted
 *  once at the App level alongside the other global dialogs. */

import { Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUpdateStore } from '@/lib/stores/update-store';
import { ReleaseNotice } from './release-notice';

export function UpdateAvailableDialog() {
  const dialog = useUpdateStore((s) => s.dialog);
  const status = useUpdateStore((s) => s.status);
  const closeDialog = useUpdateStore((s) => s.closeDialog);

  const phase = status?.phase;
  const open =
    dialog === 'release' &&
    !!status &&
    (phase === 'available' || (phase === 'error' && !!status.version));

  if (!status || !open) return null;

  const title =
    phase === 'available'
      ? 'Update available'
      : status.version
        ? `Couldn't download v${status.version}`
        : 'Update';

  return (
    <Dialog open onOpenChange={(o) => { if (!o) closeDialog(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>
            {phase === 'available'
              ? 'A new version of Tide is ready to download.'
              : 'The download failed — you can retry or come back later.'}
          </DialogDescription>
        </DialogHeader>
        <ReleaseNotice status={status} fill />
      </DialogContent>
    </Dialog>
  );
}
