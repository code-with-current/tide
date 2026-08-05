import { useEffect, useState, useCallback } from 'react';
import { TideBrandMark } from '@/components/primitives/TideBrandMark';
import {
  Accessibility, HardDrive, FolderLock, CheckCircle2, AlertTriangle,
  Loader2, ArrowRight, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useUi } from '@/lib/stores/ui';
import * as api from '@/lib/api/client';
import type { PermissionStatus, PermissionType } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/** macOS Permissions consent screen. Shown when Accessibility / Full Disk Access isn't granted; not a hard gate — opens System Settings and re-checks on focus. */
export function ConsentScreen() {
  const setScreen = useUi((s) => s.setScreen);
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const [busy, setBusy] = useState<PermissionType | null>(null);

  // Load the live status once on mount.
  const refresh = useCallback(() => {
    api.getPermissionStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Re-check when the window regains focus — the user just came back from
    // System Settings, so their toggles are now reflected. If everything is
    // authorized, auto-advance to main (no need to make them click Continue).
    const onFocus = () => {
      api.getPermissionStatus().then((s) => {
        setStatus(s);
        if (s.accessibility === 'authorized' && s.fullDiskAccess === 'authorized') {
          setScreen('main');
        }
      });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh, setScreen]);

  const handleRequest = async (type: PermissionType) => {
    setBusy(type);
    try {
      await api.requestPermission(type);
    } finally {
      // Give the OS a beat to open System Settings before clearing busy.
      setTimeout(() => setBusy(null), 600);
    }
  };

  // Non-mac should never reach here (routing gates on shouldShowConsent), but
  // guard anyway — if status is 'other', just continue.
  const isMac = status?.platform === 'mac';
  const accessibilityOk = status?.accessibility === 'authorized';
  const fullDiskOk = status?.fullDiskAccess === 'authorized';

  return (
    <div
      className="flex-1 flex overflow-hidden flex-col"
      style={{ background: 'linear-gradient(165deg, #0d0f13 0%, #08090c 100%)' }}
    >
      <div
        className="absolute inset-0 opacity-[0.02] pointer-events-none z-0"
        style={{
          backgroundImage:
            'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
        }}
      />
      <div className="drag-region h-10 flex-shrink-0 bg-transparent" />

      <div className="flex-1 flex items-center justify-center relative z-10 px-6">
        <div className="w-full max-w-xl flex flex-col items-center gap-6">
          {/* Brand mark */}
          <TideBrandMark size="md" />

          {/* Heading */}
          <div className="text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground flex items-center justify-center gap-2">
              <ShieldCheck className="size-6 text-primary" />
              Grant macOS permissions
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-md">
              A couple of system permissions make Tide work smoothly — global shortcuts and reading
              your project files. Grant what you're comfortable with; the app works either way.
            </p>
          </div>

          {/* Permission rows */}
          <Card className="w-full bg-card/60 backdrop-blur-sm border-border/60 py-0 gap-0">
            <PermissionRow
              icon={<Accessibility className="size-4" />}
              title="Accessibility"
              description="Global keyboard shortcuts and light automation."
              granted={accessibilityOk}
              loading={busy === 'accessibility'}
              onRequest={() => handleRequest('accessibility')}
              disabled={!isMac}
            />
            <div className="h-px bg-border/50 mx-4" />
            <PermissionRow
              icon={<HardDrive className="size-4" />}
              title="Full Disk Access"
              description="Read project files anywhere on disk."
              granted={fullDiskOk}
              loading={busy === 'fullDiskAccess'}
              onRequest={() => handleRequest('fullDiskAccess')}
              disabled={!isMac}
            />
            <div className="h-px bg-border/50 mx-4" />
            <PermissionRow
              icon={<FolderLock className="size-4" />}
              title="Protected Folders"
              description="Desktop, Documents, and Downloads (sandboxed by macOS even with Full Disk Access)."
              // Folders have no status check — show neutral state once the
              // others are granted, otherwise the row reads as actionable.
              granted={null}
              loading={busy === 'folders'}
              onRequest={() => handleRequest('folders')}
              disabled={!isMac}
            />
          </Card>

          {/* Continue */}
          <Button
            size="lg"
            onClick={() => setScreen('main')}
            className="gap-2 min-w-[10rem]"
          >
            Continue
            <ArrowRight className="size-4" />
          </Button>
          <p className="text-[11px] text-muted-foreground/60 -mt-3">
            You can change these later in System Settings.
          </p>
        </div>
      </div>
    </div>
  );
}

/** A single permission row with status badge + open-Settings button. */
function PermissionRow({
  icon,
  title,
  description,
  granted,
  loading,
  onRequest,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  /** true = authorized, false = not granted, null = unknown (folders). */
  granted: boolean | null;
  loading: boolean;
  onRequest: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span className="flex items-center justify-center size-8 rounded-md bg-muted text-muted-foreground shrink-0">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground flex items-center gap-1.5">
          {title}
          {granted === true && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-500">
              <CheckCircle2 className="size-3" />
              Authorized
            </span>
          )}
          {granted === false && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-500">
              <AlertTriangle className="size-3" />
              Not granted
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground/70 leading-snug">{description}</div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRequest}
        disabled={disabled || loading}
        className={cn('gap-1.5 shrink-0', granted === true && 'opacity-50')}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : granted === true ? (
          'Granted'
        ) : (
          'Open Settings'
        )}
      </Button>
    </div>
  );
}
