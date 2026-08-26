/** UpdatePill — compact animated banner shown at the top of the sidebar when
 *  an update is available, downloading, or ready to install. Clicking it
 *  opens the update flow's dialogs (never Settings directly): available →
 *  the release-details dialog; downloading → the progress dialog; ready →
 *  the progress dialog parked on its final step (Later / Restart Now).
 *  Nothing downloads or applies without those explicit consent actions. */

import { useEffect } from 'react';
import { ArrowUpToLine, Download, Loader2 } from 'lucide-react';
import { useUpdateStore, hasUpdate } from '@/lib/stores/update-store';
import { cn } from '@/lib/utils';

export function UpdatePill() {
  const init = useUpdateStore((s) => s.init);
  const status = useUpdateStore((s) => s.status);
  const openReleaseDialog = useUpdateStore((s) => s.openReleaseDialog);
  const openProgressDialog = useUpdateStore((s) => s.openProgressDialog);

  useEffect(() => { init(); }, [init]);

  if (!hasUpdate(status)) return null;

  const { phase, version, percent } = status!;
  const isAvailable = phase === 'available';
  const isDownloading = phase === 'downloading';
  const isReady = phase === 'downloaded';
  const isApplying = phase === 'applying';

  const onClick = () => {
    if (isAvailable) openReleaseDialog();
    else openProgressDialog();
  };

  return (
    <div className="px-2 pt-1 pb-0.5 flex-shrink-0">
      <div
        role="button"
        onClick={onClick}
        className={cn(
          'group relative w-full flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all',
          'bg-primary/10 hover:bg-primary/15 border border-primary/25',
        )}
      >
        {/* Animated glow accent */}
        <span className="absolute inset-0 rounded-lg bg-primary/5 animate-pulse-soft pointer-events-none" />

        {/* Icon */}
        <div className="relative flex-shrink-0 w-7 h-7 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center">
          {isDownloading || isApplying ? (
            <Loader2 className="size-3.5 text-primary animate-spin" />
          ) : isReady ? (
            <ArrowUpToLine className="size-3.5 text-primary" />
          ) : (
            <Download className="size-3.5 text-primary" />
          )}
        </div>

        {/* Label */}
        <div className="relative flex-1 min-w-0">
          {isDownloading ? (
            <>
              <div className="text-[0.78rem] font-semibold text-primary leading-tight">
                Downloading{version ? ` v${version}` : ''}…
              </div>
              <div className="mt-1 h-1 rounded-full bg-primary/20 overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="text-[0.78rem] font-semibold text-primary leading-tight">
                {isReady ? 'Restart to update' : isApplying ? 'Restarting…' : 'Update available'}
              </div>
              <div className="text-[0.68rem] text-primary/60 leading-tight mt-px">
                {isReady
                  ? `v${version} — ready to install`
                  : isApplying
                    ? `v${version} — applying update`
                    : version
                      ? `v${version} — tap to view`
                      : 'Tap to view'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
