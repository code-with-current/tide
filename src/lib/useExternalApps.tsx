/**
 * useExternalApps — shared hook for detecting which external apps (Finder/File
 * Explorer, Terminal, VSCode, Zed) are installed and opening a session's
 * project folder in one.
 *
 * Extracted from OpenInAppMenu so the SessionItem "Open with…" context-menu
 * submenu can reuse the same detection + icon rendering + open handler without
 * duplicating the lazy-detect effect and fallback logic.
 *
 * The backend (`detectExternalApps`) caches its result for the process
 * lifetime, so calling this hook from multiple components is cheap — each
 * mount fires one IPC that returns the cached list.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  FolderOpen,
  Terminal as TerminalIcon,
  Code2,
  Zap,
} from "lucide-react";
import type { ExternalApp, ExternalAppTarget } from "@/types";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { toast } from "@/lib/toast";

const log = createLogger("openInApp");

/** Lucide fallbacks per target — used when iconDataUrl is null
 *  (e.g. a Linux CLI-only install with no bundle to read an icon from). */
const FALLBACK_ICON = {
  finder: FolderOpen,
  terminal: TerminalIcon,
  vscode: Code2,
  zed: Zap,
} as const;

const STORAGE_KEY = "tide:openInApp:default";

/** Read the persisted default from localStorage; falls back to 'finder'. */
function readDefault(): ExternalAppTarget {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (
      v === "finder" ||
      v === "terminal" ||
      v === "vscode" ||
      v === "zed"
    )
      return v;
  } catch {
    /* localStorage disabled / Safari private */
  }
  return "finder";
}

export interface UseExternalAppsResult {
  /** Apps detected as installed (available === true). Empty until detection resolves. */
  visibleApps: ExternalApp[];
  /** True while the first detection IPC is in flight. */
  loading: boolean;
  /** The currently-persisted default target (falls back to 'finder' if the
   *  persisted one isn't available on this machine). */
  effectiveDefault: ExternalAppTarget;
  /** The default app object (for rendering its icon), or undefined. */
  defaultApp?: ExternalApp;
  /** Open `sessionId`'s project folder in `target`, promoting `target` to the
   *  persisted default (matches the OpenInAppMenu "open with → becomes default" UX). */
  pickApp: (target: ExternalAppTarget, sessionId: string) => void;
  /** Open `sessionId`'s folder in the effective default app. */
  openDefault: (sessionId: string) => void;
  /** Render an app's icon: the OS data URL when present, else the lucide fallback. */
  renderAppIcon: (app?: ExternalApp, size?: string) => ReactNode;
}

/**
 * Detect installed external apps once (cached by the backend for the process
 * lifetime) and expose helpers to open a session's folder in one. The default
 * target is persisted in localStorage and shared across all callers, so picking
 * an app anywhere updates the default everywhere.
 */
export function useExternalApps(): UseExternalAppsResult {
  const [apps, setApps] = useState<ExternalApp[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [defaultTarget, setDefaultTarget] =
    useState<ExternalAppTarget>(readDefault);

  // Lazy-detect on mount; the backend caches the result for the run, so this
  // is one IPC per mount that returns near-instantly after the first call.
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
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleApps = useMemo(
    () => (apps ?? []).filter((a) => a.available),
    [apps],
  );

  // If the persisted default isn't available on this machine (e.g. user picked
  // VSCode on another box), fall back to the OS file manager ('finder' id —
  // Finder/File Explorer/Files per platform) so the primary action always works.
  const effectiveDefault: ExternalAppTarget = visibleApps.some(
    (a) => a.id === defaultTarget,
  )
    ? defaultTarget
    : "finder";
  const defaultApp = visibleApps.find((a) => a.id === effectiveDefault);

  const openIn = async (target: ExternalAppTarget, sessionId: string) => {
    if (!sessionId) return;
    try {
      const result = await window.tideIpc?.openInApp(target, sessionId);
      if (result && !result.ok) {
        log.warn("openInApp failed", target, result.error);
        // Surface the failure — a silent spawn fail otherwise looks like
        // nothing happened, and the user clicks repeatedly.
        toast.error(`Couldn't open in ${target}`, {
          description: result.error,
        });
      }
    } catch (e) {
      log.warn("openInApp threw", target, e);
      toast.error(`Couldn't open in ${target}`, {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const pickApp = (target: ExternalAppTarget, sessionId: string) => {
    setDefaultTarget(target);
    try {
      localStorage.setItem(STORAGE_KEY, target);
    } catch {
      /* ignore */
    }
    openIn(target, sessionId);
  };

  const openDefault = (sessionId: string) => openIn(effectiveDefault, sessionId);

  // Icon renderer: prefer the OS icon data URL, fall back to lucide.
  // opacity-100 ensures the colorful PNG isn't dimmed by a muted parent.
  const renderAppIcon = (app?: ExternalApp, size = "size-3.5") => {
    if (app?.iconDataUrl) {
      return (
        <img
          src={app.iconDataUrl}
          alt=""
          className={cn(size, "object-contain opacity-100")}
          draggable={false}
        />
      );
    }
    const id = app?.id ?? effectiveDefault;
    const Icon = FALLBACK_ICON[id];
    return <Icon className={size} />;
  };

  return {
    visibleApps,
    loading,
    effectiveDefault,
    defaultApp,
    pickApp,
    openDefault,
    renderAppIcon,
  };
}
