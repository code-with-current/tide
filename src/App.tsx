import { isFullScreen } from '@/lib/api/client';
import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUi } from '@/lib/stores/ui';
import { queryClient } from '@/lib/queries';
import { SHORTCUTS, comboMatches, getEffectiveKeys } from '@/lib/shortcuts';
import { dispatchShortcut } from '@/lib/shortcutActions';
import { SplashScreen } from '@/components/screens/splash-screen';
import { OnboardingScreen } from '@/components/screens/onboarding-screen';
import { ConsentScreen } from '@/components/screens/consent-screen';
import { MainScreen } from '@/components/screens/main-screen';
import { SettingsScreen } from '@/components/screens/settings-screen';
import { AddWorkspaceDialog } from '@/components/modals/add-workspace-dialog';
import { UpdateAvailableDialog } from '@/components/updates/update-available-dialog';
import { UpdateProgressDialog } from '@/components/updates/update-progress-dialog';
import { Toaster } from '@/components/ui/sonner';

function App() {
  const screen = useUi((s) => s.screen);

  // Apply persisted appearance settings on mount.
  const fontScale = useUi((s) => s.fontScale);
  const reduceMotion = useUi((s) => s.reduceMotion);
  const appTheme = useUi((s) => s.appTheme);
  const toolColorMode = useUi((s) => s.toolColorMode);
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontScale}px`;
    document.documentElement.setAttribute('data-theme', appTheme);
    document.documentElement.setAttribute('data-tool-colors', toolColorMode === 'monochrome' ? 'off' : 'on');
    document.documentElement.classList.toggle('reduce-motion', reduceMotion);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate shortcut overrides + platform defaults from settings.json (one
  // IPC round-trip at startup). Until this resolves the registry uses its
  // hardcoded macOS fallback; afterwards Windows/Linux see Ctrl correctly.
  useEffect(() => {
    useUi.getState().loadShortcuts();
  }, []);

  // Native fullscreen state — collapses the macOS traffic-light spacer in the
  // sidebars/settings. Invoke covers the initial state (relaunch-while-
  // fullscreen, where no transition event fires). The devkit has no
  // fullscreen-change push, so the queried value stands until a re-query.
  useEffect(() => {
    isFullScreen()
      .then((v) => useUi.setState({ isFullScreen: v }))
      .catch(() => { /* bridge unavailable (plain browser dev) */ });
  }, []);

  // Global keyboard shortcuts: on match (user override → platform default → hardcoded fallback), dispatch the action. Reads overrides fresh per-event; field-typed inputs are skipped (Esc/⌘-combos still get through).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const overrides = useUi.getState().shortcutOverrides;
      for (const s of SHORTCUTS) {
        if (!comboMatches(getEffectiveKeys(s.id, overrides), e)) continue;
        // Allow Esc through even in fields (composer uses it to dismiss
        // pickers; dismissPrompt handles the rest). Other bindings skip
        // while typing — typing "J" in the composer shouldn't cycle sessions.
        if (inField && s.id !== 'dismissPrompt') continue;
        if (dispatchShortcut(s.id)) {
          e.preventDefault();
          e.stopPropagation();
          break; // first match wins; no double-dispatch on conflicts
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <div className="h-screen w-screen flex flex-col overflow-hidden">
          {/* Drag strip for non-main screens. On main, the WindowTopBar
              inside MainScreen provides the drag region. */}

          <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
            {screen === 'splash' && <SplashScreen />}
            {screen === 'onboarding' && <OnboardingScreen />}
            {screen === 'consent' && <ConsentScreen />}
            {/* MainScreen is ALWAYS MOUNTED (CSS-hidden when not active). It
                owns the TerminalPanel + xterm canvases — unmounting it on
                every screen switch (e.g. to Settings) destroys the terminal
                state, scrollback, and input wiring, causing "can't type" and
                "state lost" jank. display:none keeps it alive; the guards in
                MainScreen no-op its effects while hidden to avoid wasted work. */}
            <div className={`flex-1 flex min-h-0 min-w-0 overflow-hidden ${screen === 'main' ? '' : 'hidden'}`}>
              <MainScreen />
            </div>
            {screen === 'settings' && <SettingsScreen />}
          </div>

          {/* Global dialogs (rendered above whatever screen is active). */}
          <AddWorkspaceDialog />
          {/* Update flow: release details + progress dialogs (drive
              themselves off the update-store; render nothing when idle). */}
          <UpdateAvailableDialog />
          <UpdateProgressDialog />
          {/* Global toast surface. bottom-right clears the macOS traffic
              lights + top bar. The primitive is theme-aware (themed
              success/info/warning/error/loading icons + CSS-var colors). */}
          <Toaster position="bottom-right" theme="dark" />
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
