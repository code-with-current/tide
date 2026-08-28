/** ReleaseNotice — the shared body behind the update flow's release
 *  details: version transition, changelog rendered as markdown (the GitHub
 *  Release body fetched via updaterReleaseNotes), and the consent actions
 *  for the current phase. Used by both the main-screen UpdateAvailableDialog
 *  and the Settings → Updates release-notice section so the two surfaces
 *  never drift. Falls back to an intentional "details unavailable" note
 *  when the release body can't be fetched (offline, missing release) —
 *  the version + Download affordance stay fully functional. */

import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Download, FileText, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { SimpleMarkdownRenderer } from '@/components/chat/timeline/markdown/markdown-renderer';
import { useUpdateStore, type UpdateStatusWire } from '@/lib/stores/update-store';
import { getReleaseNotes } from '@/lib/api/client';

/** Fetch-once-per-version changelog lookup (main process caches per
 *  version, so remounts are cheap). */
export function useReleaseNotes(version: string | null): { markdown: string | null; loading: boolean } {
  const [state, setState] = useState<{ markdown: string | null; loading: boolean }>({
    markdown: null,
    loading: !!version,
  });

  useEffect(() => {
    if (!version) {
      setState({ markdown: null, loading: false });
      return;
    }
    let alive = true;
    setState({ markdown: null, loading: true });
    getReleaseNotes(version)
      .then((markdown) => { if (alive) setState({ markdown, loading: false }); })
      .catch(() => { if (alive) setState({ markdown: null, loading: false }); });
    return () => { alive = false; };
  }, [version]);

  return state;
}

function VersionTransition({ from, to }: { from: string; to: string }) {
  return (
    <div className="flex items-center gap-2 text-[0.7857rem]">
      <code className="font-mono text-muted-foreground/70">v{from}</code>
      <ArrowRight className="size-3 text-muted-foreground/40" />
      <code className="font-mono font-semibold text-primary">v{to}</code>
    </div>
  );
}

function ChangelogArea({ version, fill }: { version: string; fill?: boolean }) {
  const { markdown, loading } = useReleaseNotes(version);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-[0.7857rem] text-muted-foreground/60">
        <Loader2 className="size-3.5 animate-spin" />
        Fetching release notes…
      </div>
    );
  }

  if (markdown === null) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3.5 py-3.5 flex items-start gap-2.5">
        <FileText className="size-4 mt-0.5 text-muted-foreground/50 flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-[0.8rem] font-medium text-muted-foreground">Release details unavailable</div>
          <div className="text-[0.75rem] text-muted-foreground/60 mt-0.5">
            Notes for v{version} couldn't be fetched — you may be offline. The update itself downloads normally.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        fill
          ? 'changelog-md min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border border-border bg-muted/10 px-3.5 py-2.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_code]:break-words [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto'
          : 'changelog-md max-h-[300px] min-w-0 overflow-y-auto rounded-lg border border-border bg-muted/10 px-3.5 py-2.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_code]:break-words [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto'
      }
    >
      <SimpleMarkdownRenderer content={markdown} variant="tool" enableFileReferences={false} />
    </div>
  );
}

/** Compact phase-driven progress strip (settings inline + progress dialog
 *  reuse the same shape). Determinate via the shadcn Progress primitive
 *  when the backend reports bytes; indeterminate pulse otherwise. */
function DownloadProgress({ status }: { status: UpdateStatusWire }) {
  const percent = status.percent;
  const determinate = typeof percent === 'number';
  return (
    <div>
      {determinate ? (
        <Progress value={Math.max(0, Math.min(100, percent!))} />
      ) : (
        <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20">
          <div className="h-full w-full bg-primary/50 animate-pulse-soft" />
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-[0.75rem] text-muted-foreground/60">
        {determinate && <span className="tabular-nums font-semibold text-primary">{percent}%</span>}
        <span className="truncate">{status.message || 'Preparing download…'}</span>
      </div>
    </div>
  );
}

export function ReleaseNotice({
  status,
  onLater,
  fill = false,
}: {
  status: UpdateStatusWire;
  /** "Later" — dismiss the notice. Defaults to closing the dialog; the
   *  settings section passes its own collapse. */
  onLater?: () => void;
  /** Dialog mode — the changelog fills the dialog's remaining height and
   *  scrolls inside it (the settings section keeps its own cap). */
  fill?: boolean;
}) {
  const download = useUpdateStore((s) => s.download);
  const applyNow = useUpdateStore((s) => s.applyNow);
  const closeDialog = useUpdateStore((s) => s.closeDialog);
  const later = onLater ?? closeDialog;

  const { phase, version, currentVersion, error, message } = status;
  const target = version ?? '—';

  return (
    <div className={fill ? 'flex min-h-0 flex-1 flex-col gap-3.5' : 'flex flex-col gap-3.5'}>
      <VersionTransition from={currentVersion || '—'} to={target} />

      {phase === 'downloading' && <DownloadProgress status={status} />}

      {phase === 'downloaded' && (
        <div className="rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-2.5 text-[0.7857rem] text-muted-foreground">
          Downloaded and verified. Tide will restart to finish installing v{target}.
        </div>
      )}

      {phase === 'applying' && (
        <div className="flex items-center gap-2 text-[0.7857rem] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-primary" />
          {message || 'Restarting — Tide will be back in a moment.'}
        </div>
      )}

      {phase === 'error' && version && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3.5 py-2.5">
          <AlertCircle className="size-3.5 mt-0.5 text-destructive flex-shrink-0" />
          <div className="text-[0.7857rem] text-muted-foreground min-w-0">
            {error || message || 'The update could not be downloaded.'}
          </div>
        </div>
      )}

      {phase !== 'downloading' && phase !== 'applying' && <ChangelogArea version={target} fill={fill} />}

      {/* Consent actions — Download only downloads; nothing applies until
          Restart Now. Later never touches the prepared bundle. */}
      <div className="flex items-center justify-end gap-2">
        {phase === 'downloaded' && (
          <Button variant="secondary" size="sm" className="text-xs h-8" onClick={later}>
            Later
          </Button>
        )}
        {phase === 'available' && (
          <Button variant="default" size="sm" className="text-xs h-8 gap-1.5" onClick={download}>
            <Download className="size-3.5" />
            Download
          </Button>
        )}
        {phase === 'downloaded' && (
          <Button variant="default" size="sm" className="text-xs h-8 gap-1.5" onClick={applyNow}>
            <RefreshCw className="size-3.5" />
            Restart Now
          </Button>
        )}
        {phase === 'error' && version && (
          <Button variant="default" size="sm" className="text-xs h-8 gap-1.5" onClick={download}>
            <Download className="size-3.5" />
            Retry download
          </Button>
        )}
      </div>
    </div>
  );
}
