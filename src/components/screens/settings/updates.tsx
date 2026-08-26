/** UpdatesSection — in-app updater UI backed by the Electrobun Updater
 *  (patch-chain updates from the release bucket; GitHub Releases stays the
 *  manual-download page). Consent-driven: checks run automatically, the
 *  Release notice's Download button stages the bundle (progress dialog),
 *  and Restart Now applies + relaunches. "Later" collapses the notice —
 *  the prepared update stays on disk and the pill re-prompts. Shares
 *  status with the sidebar UpdatePill and the update dialogs via the
 *  singleton update-store. */
import * as api from '@/lib/api/client';
import { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Download,
  ExternalLink,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';
import { ReleaseNotice } from '@/components/updates/release-notice';
import { useUpdateStore, type UpdateStatusWire } from '@/lib/stores/update-store';

const GITHUB_RELEASES = 'https://github.com/code-with-current/tide/releases';

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function UpdatesSection() {
  const init = useUpdateStore((s) => s.init);
  const status = useUpdateStore((s) => s.status);
  const [autoCheck, setAutoCheck] = useState(true);
  const [checking, setChecking] = useState(false);
  /** Version the user dismissed with "Later" — the notice stays collapsed
   *  for it while the bundle sits ready (a different version re-shows). */
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  useEffect(() => {
    init();
    api
      .getGeneralSettings()
      .then((s) => setAutoCheck(s?.autoUpdateCheck ?? true))
      .catch(() => {});
  }, [init]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    await api.checkForUpdates().catch(() => {});
    setTimeout(() => setChecking(false), 800);
  }, []);

  const handleToggleAutoCheck = useCallback((v: boolean) => {
    setAutoCheck(v);
    void api.updateGeneralSettings({ autoUpdateCheck: v });
  }, []);

  const openExternal = (url: string) => window.open(url, '_blank', 'noopener');

  const phase = status?.phase ?? 'idle';
  const isBusy = checking || phase === 'checking' || phase === 'downloading' || phase === 'applying';
  const currentVersion = status?.currentVersion ?? '—';

  const noticeWaiting =
    !!status && (phase === 'available' || phase === 'downloaded' || (phase === 'error' && !!status.version));
  const noticeDismissed = phase === 'downloaded' && !!status?.version && status.version === dismissedVersion;

  return (
    <>
      <SettingsHeader
        title="Updates"
        description="Tide checks for updates automatically and notifies you when one is available. Nothing downloads until you approve it — updates arrive as small, verified patches."
        action={
          <Button
            variant="default"
            size="sm"
            className="text-xs h-7"
            onClick={handleCheck}
            disabled={isBusy}
          >
            {checking || phase === 'checking' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Check now
          </Button>
        }
      />

      {/* ── Release notice — details + changelog + consent actions ── */}
      {noticeWaiting && !noticeDismissed && (
        <SettingsGroup title="Release notice">
          <Card className="px-5 py-4">
            <ReleaseNotice
              status={status}
              onLater={() => { if (status?.version) setDismissedVersion(status.version); }}
            />
          </Card>
        </SettingsGroup>
      )}

      {/* ── Status hero (download/apply progress, check failures, idle) ── */}
      {noticeWaiting && !noticeDismissed ? null : noticeDismissed ? (
        <SettingsGroup title="Release notice">
          <Card className="px-5 py-4">
            <DismissedReadyNotice
              version={status?.version ?? ''}
              onShow={() => setDismissedVersion(null)}
              onDownloadManual={() => openExternal(GITHUB_RELEASES)}
            />
          </Card>
        </SettingsGroup>
      ) : (
        <StatusHero status={status} checking={checking} onDownloadManual={() => openExternal(GITHUB_RELEASES)} />
      )}

      {/* ── Preferences ── */}
      <SettingsGroup title="Preferences">
        <Card>
          <SettingsRow
            title="Check for updates automatically"
            description="Check for updates on app launch and periodically, then notify when one is available."
            last
          >
            <Switch checked={autoCheck} onCheckedChange={handleToggleAutoCheck} />
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* ── Manual download ── */}
      <SettingsGroup title="Manual download">
        <Card>
          <SettingsRow
            title="GitHub releases"
            description="Download the latest installer directly from the releases page."
            last
          >
            <Button
              variant="secondary"
              size="sm"
              className="text-xs h-7 gap-1.5"
              onClick={() => openExternal(GITHUB_RELEASES)}
            >
              <ExternalLink className="size-3" /> Open
            </Button>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* ── Version footer ── */}
      <div className="flex items-center gap-2 text-[0.7857rem] text-muted-foreground/50 pt-1">
        <ShieldCheck className="size-3" />
        <span>Current version</span>
        <code className="font-mono text-muted-foreground/70">v{currentVersion}</code>
        {status?.lastCheckedAt && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span>Last checked {timeAgo(status.lastCheckedAt)}</span>
          </>
        )}
      </div>
    </>
  );
}

/** Collapsed ready state after "Later": the update stays on disk, so keep
 *  a quiet affordance to bring the notice back (or grab it from the pill). */
function DismissedReadyNotice({
  version,
  onShow,
  onDownloadManual,
}: {
  version: string;
  onShow: () => void;
  onDownloadManual: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-primary/12 border border-primary/25 flex items-center justify-center flex-shrink-0">
        <ShieldCheck className="size-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">v{version || '—'} is ready whenever you are</div>
        <div className="text-[0.7857rem] text-muted-foreground/60">
          The update is kept on disk — install it from here or the sidebar pill.
        </div>
      </div>
      <Button variant="secondary" size="sm" className="text-xs h-7" onClick={onShow}>
        View details
      </Button>
      <Button variant="secondary" size="sm" className="text-xs h-7 gap-1.5" onClick={onDownloadManual}>
        <ExternalLink className="size-3" /> Download
      </Button>
    </div>
  );
}

/** The hero status card for phases the release notice doesn't own:
 *  downloading, applying, check errors, checking, idle. */
function StatusHero({
  status,
  checking,
  onDownloadManual,
}: {
  status: UpdateStatusWire | null;
  checking: boolean;
  onDownloadManual: () => void;
}) {
  const phase = status?.phase ?? 'idle';
  const version = status?.version;
  const currentVersion = status?.currentVersion ?? '—';
  const error = status?.error;
  const message = status?.message;

  // ── Downloading — progress bar hero ──
  if (phase === 'downloading') {
    const percent = status?.percent;
    const pct = Math.max(0, Math.min(100, percent ?? 0));
    return (
      <Card className="mb-5 overflow-hidden">
        <div className="relative px-5 py-4">
          {/* Subtle gradient backdrop */}
          <div className="absolute inset-0 bg-gradient-to-br from-primary/8 to-transparent pointer-events-none" />
          <div className="relative flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-primary/12 border border-primary/25 flex items-center justify-center flex-shrink-0">
              <Download className="size-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">
                Downloading{version ? ` v${version}` : '' }
              </div>
              <div className="text-[0.7857rem] text-muted-foreground/60 truncate">
                {message || 'Fetching update bundle…'}
              </div>
            </div>
            <div className="text-2xl font-bold tabular-nums text-primary">
              {pct}
              <span className="text-sm text-muted-foreground/50">%</span>
            </div>
          </div>
          <div className="relative h-2 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </Card>
    );
  }

  // ── Applying — the update is being swapped in / relaunched ──
  if (phase === 'applying') {
    return (
      <Card className="mb-5 border-primary/30 overflow-hidden">
        <div className="relative px-5 py-4">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent pointer-events-none" />
          <div className="relative flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
              <Loader2 className="size-5 text-primary animate-spin" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-primary">
                Applying update{version ? ` — v${version}` : ''}…
              </div>
              <div className="text-[0.7857rem] text-muted-foreground/60 truncate">
                {message || 'Tide will restart when the new version is in place.'}
              </div>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  // ── Error (check failures — consent failures render in the notice) ──
  if (phase === 'error') {
    return (
      <Card className="mb-5 border-destructive/30 overflow-hidden">
        <div className="relative px-5 py-4">
          <div className="absolute inset-0 bg-gradient-to-br from-destructive/8 to-transparent pointer-events-none" />
          <div className="relative flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-destructive/10 border border-destructive/25 flex items-center justify-center flex-shrink-0">
              <AlertCircle className="size-5 text-destructive" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">Update check failed</div>
              <div className="text-[0.7857rem] text-muted-foreground/60 truncate">
                {error || message || 'An error occurred. You can download manually.'}
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="text-xs h-7 gap-1.5"
              onClick={onDownloadManual}
            >
              <ExternalLink className="size-3" /> Download
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // ── Checking — spinner ──
  if (phase === 'checking' || checking) {
    return (
      <Card className="mb-5">
        <div className="px-5 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-secondary border border-border flex items-center justify-center flex-shrink-0">
            <Loader2 className="size-5 text-muted-foreground animate-spin" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">Checking for updates…</div>
            <div className="text-[0.7857rem] text-muted-foreground/60">Contacting the update server</div>
          </div>
        </div>
      </Card>
    );
  }

  // ── Idle / not-available — up to date ──
  return (
    <Card className="mb-5 overflow-hidden">
      <div className="relative px-5 py-4">
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--success)]/6 to-transparent pointer-events-none" />
        <div className="relative flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--success)]/10 border border-[var(--success)]/25 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 className="size-5 text-[var(--success)]" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              {phase === 'not-available' ? "You're up to date" : 'Tide is ready'}
              <code className="font-mono text-[0.7857rem] text-muted-foreground">v{currentVersion}</code>
            </div>
            <div className="text-[0.7857rem] text-muted-foreground/60 flex items-center gap-1 mt-0.5">
              <ShieldCheck className="size-3" />
              {status?.lastCheckedAt
                ? `Last checked ${timeAgo(status.lastCheckedAt)}`
                : 'Auto-update is active'}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
