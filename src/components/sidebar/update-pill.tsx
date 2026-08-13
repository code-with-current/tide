/** UpdatePill — compact animated banner shown at the top of the sidebar when
 *  an update is available, downloading, or ready to install. Clicking it opens
 *  Settings → Updates. When the update is downloaded, a inline Restart button
 *  is offered so the user never has to leave the main screen. */

import { useEffect } from 'react';
import { ArrowUpToLine, Loader2, Sparkles } from 'lucide-react';
import { useUpdateStore, hasUpdate } from '@/lib/stores/update-store';
import { useUi } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';

const SETTINGS_SECTION_KEY = 'tide-settings-section';

function openUpdatesSettings() {
  try { localStorage.setItem(SETTINGS_SECTION_KEY, 'updates'); } catch { /* */ }
  useUi.getState().setScreen('settings');
}

export function UpdatePill() {
  const init = useUpdateStore((s) => s.init);
  const status = useUpdateStore((s) => s.status);

  useEffect(() => { init(); }, [init]);

  if (!hasUpdate(status)) return null;

  const { state, version, percent } = status!;
  const isDownloading = state === 'downloading';
  const isReady = state === 'downloaded';

  return (
    <div className="px-2 pt-1 pb-0.5 flex-shrink-0">
      <div
        role="button"
        onClick={!isReady ? openUpdatesSettings : undefined}
        className={cn(
          'group relative w-full flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all',
          'bg-primary/10 hover:bg-primary/15 border border-primary/25',
        )}
      >
        {/* Animated glow accent */}
        <span className="absolute inset-0 rounded-lg bg-primary/5 animate-pulse-soft pointer-events-none" />

        {/* Icon */}
        <div className="relative flex-shrink-0 w-7 h-7 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center">
          {isDownloading ? (
            <Loader2 className="size-3.5 text-primary animate-spin" />
          ) : isReady ? (
            <ArrowUpToLine className="size-3.5 text-primary" />
          ) : (
            <Sparkles className="size-3.5 text-primary" />
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
                {isReady ? 'Ready to restart' : 'New version available'}
              </div>
              <div className="text-[0.68rem] text-primary/60 leading-tight mt-px">
                {isReady
                  ? `v${version} — restart to apply`
                  : version
                    ? `v${version} — tap to update`
                    : 'Tap to view'}
              </div>
            </>
          )}
        </div>

        {/* Quick restart when downloaded */}
        {isReady && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              window.tideIpc?.updater.installUpdate();
            }}
            className="relative flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[0.68rem] font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <ArrowUpToLine className="size-3" />
            Restart
          </button>
        )}
      </div>
    </div>
  );
}
