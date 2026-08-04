import { useEffect, useRef, useState } from 'react';
import { Logo } from '@/components/primitives';
import { useUi } from '@/lib/stores/ui';
import { useProviders, useWorkspaces } from '@/lib/queries';
import * as api from '@/lib/api/client';
import { Spinner } from '../ui/spinner';
import tideLogoUrl from '@/assets/logo.png';
import { Badge } from '../ui/badge';

export function SplashScreen() {
  const setScreen = useUi((s) => s.setScreen);
  const { data: providers } = useProviders();
  const { data: workspaces } = useWorkspaces();
  const routedRef = useRef(false);
  const [version, setVersion] = useState('—');

  // Fetch the live app version for the splash badge. Reads app.getVersion()
  // via the diagnostics IPC so it stays in sync with package.json (the single
  // source of truth) rather than drifting as a hardcoded constant.
  useEffect(() => {
    window.tideIpc?.getDiagnostics().then((d) => setVersion(d.appVersion)).catch(() => {});
  }, []);

  // Whether the last-session restore IPC has resolved (success OR failure).
  // Routing to MainScreen is gated on this so MainScreen never mounts with
  // stale null state — without the gate, a slow IPC roundtrip could land
  // AFTER the 800ms routing timeout, leaving the restored session invisible
  // and getting immediately overwritten by MainScreen's first effect run.
  const [restored, setRestored] = useState(false);

  const hasProviders = (providers?.length ?? 0) > 0;
  const hasWorkspaces = (workspaces?.length ?? 0) > 0;

  // Restore last session from the main-process config (survives restarts
  // independent of renderer localStorage, which is scoped to the dev
  // server port). Runs once before routing.
  useEffect(() => {
    let cancelled = false;
    api.getLastSession()
      .then(({ sessionId, workspaceId }) => {
        if (cancelled) return;
        if (workspaceId) {
          // Use a direct set instead of setActiveWorkspace because the latter
          // clears activeSessionId — we want both restored together.
          useUi.setState({
            activeWorkspaceId: workspaceId,
            activeSessionId: sessionId,
            mainView: sessionId ? 'chat' : 'new',
          });
        }
      })
      .catch(() => { /* IPC failure — route with default null state */ })
      .finally(() => {
        if (!cancelled) setRestored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Only route once per splash mount — prevents re-triggering when
    // TanStack Query data arrives asynchronously.
    if (routedRef.current) return;

    // Wait for both queries to finish loading AND for the last-session
    // restore to resolve. Routing before the restore completes leaves
    // MainScreen mounting against stale null state.
    if (providers === undefined || workspaces === undefined) return;
    if (!restored) return;

    const t = setTimeout(() => {
      routedRef.current = true;
      if (hasProviders && hasWorkspaces) {
        // Before going to main, check whether macOS permissions need consent.
        // Cheap native call (instant-false on non-mac); shows the consent
        // screen once if Accessibility/Full Disk Access aren't authorized yet.
        api.shouldShowConsent().then((showConsent) => {
          setScreen(showConsent ? 'consent' : 'main');
        });
      } else {
        setScreen('onboarding');
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [setScreen, hasProviders, hasWorkspaces, providers, workspaces, restored]);

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-7 relative"
         style={{ background: 'linear-gradient(180deg, #0d0f13 0%, #08090c 100%)' }}

    >

      {/* Giant logo watermark — bleeds left, ultra-subtle */}
      <div
        className="absolute pointer-events-none"
        style={{ top: '-10%', right: '-20%', opacity: 0.01 }}
      >
        <img src={tideLogoUrl} alt="" style={{ height: '500%', objectFit: 'contain' }} />
      </div>
      {/* Grain texture */}
      <div
        className="absolute inset-0 opacity-[0.02] pointer-events-none z-0"
        style={{
          backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
        }}
      />
      <div className="relative">
        <div
          className="absolute inset-0 -m-5 blur-2xl"
        />
        <div className="relative">
          <Logo size={88} />
        </div>
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="text-3xl font-semibold tracking-tight">Tide</div>
        <div className="text-sm text-muted-foreground/60">Code with the current</div>
      </div>

      <div className="flex flex-col items-center gap-4 mt-4">
        <Spinner className='size-8 text-primary' />
      </div>


      <Badge variant="outline" className="absolute bottom-8">
        <span>v{version}</span>
      </Badge>
    </div>
  );
}
