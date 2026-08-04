import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUi } from '@/lib/stores/ui';
import { queryClient } from '@/lib/queries';
import { SHORTCUTS, comboMatches, getEffectiveKeys } from '@/lib/shortcuts';
import { dispatchShortcut } from '@/lib/shortcutActions';
import { SplashScreen } from '@/components/screens/SplashScreen';
import { OnboardingScreen } from '@/components/screens/OnboardingScreen';
import { ConsentScreen } from '@/components/screens/ConsentScreen';
import { MainScreen } from '@/components/screens/MainScreen';
import { SettingsScreen } from '@/components/screens/SettingsScreen';
import { AddWorkspaceDialog } from '@/components/modals/AddWorkspaceDialog';
import { Toaster } from '@/components/ui/sonner';

function App() {
  const screen = useUi((s) => s.screen);

  // Apply persisted appearance settings on mount.
  const { fontScale, reduceMotion, appTheme } = useUi();
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontScale}px`;
    document.documentElement.setAttribute('data-theme', appTheme);
    document.documentElement.classList.toggle('reduce-motion', reduceMotion);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate shortcut overrides + platform defaults from settings.json (one
  // IPC round-trip at startup). Until this resolves the registry uses its
  // hardcoded macOS fallback; afterwards Windows/Linux see Ctrl correctly.
  useEffect(() => {
    useUi.getState().loadShortcuts();
  }, []);

  // Global keyboard shortcuts. For each registered shortcut, check whether
  // the event matches its effective binding (user override → platform default
  // → hardcoded fallback) and, on first match, dispatch the action. Reads
  // overrides fresh per-event so rebinding via Settings → Shortcuts takes
  // effect immediately. Field-typed inputs are skipped so chat typing
  // doesn't trigger J/K etc.; Esc/⌘-combos still get through because they're
  // either not typeable or are app-level.
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

          <div className="flex-1 flex min-h-0">
            {screen === 'splash' && <SplashScreen />}
            {screen === 'onboarding' && <OnboardingScreen />}
            {screen === 'consent' && <ConsentScreen />}
            {/* MainScreen is ALWAYS MOUNTED (CSS-hidden when not active). It
                owns the TerminalPanel + xterm canvases — unmounting it on
                every screen switch (e.g. to Settings) destroys the terminal
                state, scrollback, and input wiring, causing "can't type" and
                "state lost" jank. display:none keeps it alive; the guards in
                MainScreen no-op its effects while hidden to avoid wasted work. */}
            <div className={`flex-1 flex min-h-0 ${screen === 'main' ? '' : 'hidden'}`}>
              <MainScreen />
            </div>
            {screen === 'settings' && <SettingsScreen />}
          </div>

          {/* Global dialogs (rendered above whatever screen is active). */}
          <AddWorkspaceDialog />
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
