/**
 * OpenInAppMenu — sticky split-button in the top bar that opens the active
 * session's project folder in an external app.
 *
 * Behavior:
 *   - Primary click opens in the **default** app (Finder/File Explorer on
 *     first run).
 *   - Chevron opens the full menu; picking an app opens it **and** promotes
 *     it to the new default, persisted in localStorage so the choice survives
 *     reload. This matches the "open with → becomes default" UX of OS menus.
 *
 * Icons: the backend returns each app's actual OS icon as a data URL (via
 * Electron's app.getFileIcon). We render <img> when present and fall back to
 * a generic lucide icon when null (e.g. a Linux CLI-only install with no
 * bundle to read).
 *
 * The path is resolved server-side from `activeSessionId` (worktree →
 * workspace → HOME; mirrors terminal.ts). The renderer never passes an
 * arbitrary path.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, FolderOpen, Loader2, Terminal as TerminalIcon, Code2, Zap } from 'lucide-react';
import type { ExternalApp, ExternalAppTarget } from '@/types';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import { createLogger } from '@/lib/logger';

const log = createLogger('openInApp');

// Lucide fallbacks per target — used when iconDataUrl is null.
const FALLBACK_ICON = {
  finder: FolderOpen,
  terminal: TerminalIcon,
  vscode: Code2,
  zed: Zap,
} as const;

const STORAGE_KEY = 'tide:openInApp:default';

/** Read the persisted default from localStorage; falls back to 'finder'. */
function readDefault(): ExternalAppTarget {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'finder' || v === 'terminal' || v === 'vscode' || v === 'zed') return v;
  } catch { /* localStorage disabled / Safari private */ }
  return 'finder';
}

export function OpenInAppMenu() {
  const activeSessionId = useUi((s) => s.activeSessionId);
  const [apps, setApps] = useState<ExternalApp[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [defaultTarget, setDefaultTarget] = useState<ExternalAppTarget>(readDefault);

  // Lazy-detect on mount; cached in main-process for the run.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (apps || loading) return;
      setLoading(true);
      try {
        const list = await window.tideIpc?.detectExternalApps();
        if (!cancelled) setApps(list ?? []);
      } catch {
        if (!cancelled) setApps([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleApps = useMemo(() => (apps ?? []).filter((a) => a.available), [apps]);

  // If the persisted default isn't available on this machine (e.g. user
  // picked VSCode on another box), fall back to Finder so the primary
  // button always does something useful.
  const effectiveDefault: ExternalAppTarget =
    visibleApps.some((a) => a.id === defaultTarget) ? defaultTarget : 'finder';
  const defaultApp = visibleApps.find((a) => a.id === effectiveDefault);

  const openIn = async (target: ExternalAppTarget) => {
    if (!activeSessionId) return;
    try {
      const result = await window.tideIpc?.openInApp(target, activeSessionId);
      if (result && !result.ok) log.warn('openInApp failed', target, result.error);
    } catch (e) {
      log.warn('openInApp threw', target, e);
    }
  };

  const pickApp = (target: ExternalAppTarget) => {
    setDefaultTarget(target);
    try { localStorage.setItem(STORAGE_KEY, target); } catch { /* ignore */ }
    openIn(target);
  };

  // Icon renderer: prefer the OS icon data URL, fall back to lucide.
  // opacity-100 + no filter ensures the colorful PNG isn't dimmed by a
  // disabled/muted parent (ghost buttons inherit muted text color, which
  // is fine for SVG icons that use currentColor but would wash out an image
  // if any parent applied opacity).
  const renderIcon = (app?: ExternalApp, size = 'size-5') => {
    if (app?.iconDataUrl) {
      return (
        <img
          src={app.iconDataUrl}
          alt=""
          className={cn(size, 'object-contain opacity-100')}
          draggable={false}
        />
      );
    }
    const id = app?.id ?? effectiveDefault;
    const Icon = FALLBACK_ICON[id];
    return <Icon className={size} />;
  };

  // Disable only when there's no active session. Don't disable during the
  // initial detection load (visibleApps is [] until apps arrives) — that
  // would gray the button via disabled:opacity-50 even though we're about
  // to have apps. The primary button already shows a spinner while loading;
  // the chevron's menu handles the empty case with a "No apps available" row.
  const disabled = !activeSessionId;

  return (
    <ButtonGroup>
      {/* Primary: open in the default app immediately. */}
        <Button
          variant="outline"
          size="sm"
          className="p-1.5 pr-2"
          disabled={disabled}
          onClick={() => openIn(effectiveDefault)}
        >
          {loading && !apps ? <Loader2 className="size-3.5 animate-spin" /> : renderIcon(defaultApp)}
        </Button>

      {/* Chevron: open the menu; selecting an item promotes it to default. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-sm" className="px-1 [&_svg]:size-3" disabled={disabled}>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="w-48">
          <DropdownMenuLabel>Open project in</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {visibleApps.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No apps available</div>
          ) : (
            visibleApps.map((app) => {
              const isDefault = app.id === effectiveDefault;
              return (
                <DropdownMenuItem
                  key={app.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    pickApp(app.id);
                  }}
                  className="gap-2"
                >
                  {renderIcon(app)}
                  <span className="flex-1">{app.label}</span>
                  {/* Marker for the current default — subtle, not a check icon
                      that could imply "toggle". Text keeps it unambiguous. */}
                  {isDefault && <span className="text-[10px] text-muted-foreground">default</span>}
                </DropdownMenuItem>
              );
            })
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
