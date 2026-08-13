/** UpdatesSection — in-app auto-updater backed by electron-updater (GitHub releases).
 *  Shares status with the sidebar UpdatePill via the singleton update-store. */
import { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Download,
  ArrowUpToLine,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';
import { useUpdateStore, type UpdateStatus } from '@/lib/stores/update-store';

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

  useEffect(() => {
    init();
    window.tideIpc
      ?.getGeneralSettings()
      .then((s) => setAutoCheck(s.autoUpdateCheck))
      .catch(() => {});
  }, [init]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    await window.tideIpc?.updater.checkForUpdates();
    setTimeout(() => setChecking(false), 800);
  }, []);

  const handleInstall = useCallback(() => {
    window.tideIpc?.updater.installUpdate();
  }, []);

  const handleToggleAutoCheck = useCallback((v: boolean) => {
    setAutoCheck(v);
    window.tideIpc?.updateGeneralSettings({ autoUpdateCheck: v });
  }, []);

  const openExternal = (url: string) => window.open(url, '_blank', 'noopener');

  const state = status?.state ?? 'idle';
  const isBusy = checking || state === 'checking' || state === 'downloading';
  const version = status?.version;
  const currentVersion = status?.currentVersion ?? '—';

  return (
    <>
      <SettingsHeader
        title="Updates"
        description="Tide checks GitHub releases for new versions. Updates are downloaded in the background and verified before installing."
        action={
          <Button
            variant="default"
            size="sm"
            className="text-xs h-7"
            onClick={handleCheck}
            disabled={isBusy}
          >
            {checking || state === 'checking' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Check now
          </Button>
        }
      />

      {/* ── Status hero ── */}
      <StatusHero
        status={status}
        checking={checking}
        onInstall={handleInstall}
        onDownloadManual={() => openExternal(GITHUB_RELEASES)}
      />

      {/* ── Release notes ── */}
      {version && status?.releaseNotes && (
        <SettingsGroup title={`Release notes — v${version}`}>
          <Card>
            <div className="px-4 py-3 max-h-64 overflow-y-auto scroll text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {status.releaseNotes}
            </div>
          </Card>
        </SettingsGroup>
      )}

      {/* ── Preferences ── */}
      <SettingsGroup title="Preferences">
        <Card>
          <SettingsRow
            title="Check for updates automatically"
            description="Check GitHub releases on app launch and notify when an update is available."
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
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/50 pt-1">
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

/** The hero status card. Adapts layout, color, and actions to the current state. */
function StatusHero({
  status,
  checking,
  onInstall,
  onDownloadManual,
}: {
  status: UpdateStatus | null;
  checking: boolean;
  onInstall: () => void;
  onDownloadManual: () => void;
}) {
  const state = status?.state ?? 'idle';
  const version = status?.version;
  const currentVersion = status?.currentVersion ?? '—';
  const percent = status?.percent;
  const error = status?.error;

  // ── Downloading — progress bar hero ──
  if (state === 'downloading') {
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
                Downloading v{version}
              </div>
              <div className="text-[11px] text-muted-foreground/60">
                {pct}% · installs automatically on quit
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

  // ── Downloaded — ready to install ──
  if (state === 'downloaded') {
    return (
      <Card className="mb-5 border-primary/30 overflow-hidden">
        <div className="relative px-5 py-4">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent pointer-events-none" />
          <div className="relative flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
              <ArrowUpToLine className="size-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-primary">
                Update ready — v{version}
              </div>
              <div className="text-[11px] text-muted-foreground/60">
                Restart Tide to apply the update.
              </div>
            </div>
            <Button variant="default" size="sm" className="text-xs h-7" onClick={onInstall}>
              <ArrowUpToLine className="size-3" /> Restart
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // ── Error ──
  if (state === 'error') {
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
              <div className="text-[11px] text-muted-foreground/60 truncate">
                {error || 'An error occurred. You can download manually.'}
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
  if (state === 'checking' || checking) {
    return (
      <Card className="mb-5">
        <div className="px-5 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-secondary border border-border flex items-center justify-center flex-shrink-0">
            <Loader2 className="size-5 text-muted-foreground animate-spin" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">Checking for updates…</div>
            <div className="text-[11px] text-muted-foreground/60">Contacting GitHub releases</div>
          </div>
        </div>
      </Card>
    );
  }

  // ── Available (download hasn't started — brief transitional state) ──
  if (state === 'available') {
    return (
      <Card className="mb-5 overflow-hidden">
        <div className="relative px-5 py-4">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/8 to-transparent pointer-events-none" />
          <div className="relative flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/12 border border-primary/25 flex items-center justify-center flex-shrink-0">
              <Sparkles className="size-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold flex items-center gap-2">
                v{version} is available
                <ArrowRight className="size-3 text-muted-foreground/40" />
                <code className="font-mono text-[11px] text-muted-foreground/60">v{currentVersion}</code>
              </div>
              <div className="text-[11px] text-muted-foreground/60">Starting download…</div>
            </div>
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
              {state === 'not-available' ? "You're up to date" : 'Tide is ready'}
              <code className="font-mono text-[11px] text-muted-foreground">v{currentVersion}</code>
            </div>
            <div className="text-[11px] text-muted-foreground/60 flex items-center gap-1 mt-0.5">
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
