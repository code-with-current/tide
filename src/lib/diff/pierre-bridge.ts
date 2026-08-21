import PierreDiffWorker from '@pierre/diffs/worker/worker.js?worker&inline';
import { Virtualizer, registerCustomTheme } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from '@pierre/diffs/worker';
import type { CustomThemeLoader, ThemesType } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import { useUi } from '@/lib/stores/ui';

/**
 * Bridge between Tide's `data-theme` token system and @pierre/diffs.
 *
 * Tide has no `.dark` class strategy — every app theme is a `[data-theme]`
 * block that redefines the shadcn custom properties on `:root`, and all
 * shipped themes are dark. The bridge measures the resolved tokens at runtime
 * and registers a shiki theme pair (`tide-light` / `tide-dark`) that Pierre
 * consumes via `theme: { light, dark }` + `themeType`. Syntax token colors
 * are baked at first registration (Pierre refuses duplicate theme names), so
 * per-appTheme palette drift within a session is accepted; the light/dark
 * flip itself stays live through `setThemeType`.
 */

export const PIERRE_THEME_LIGHT = 'tide-light';
export const PIERRE_THEME_DARK = 'tide-dark';
export const PIERRE_THEMES: ThemesType = { light: PIERRE_THEME_LIGHT, dark: PIERRE_THEME_DARK };

/** Tide's only light palette — used to measure the light-side tokens. */
const LIGHT_APP_THEME = 'bright';

/** Nearest real equivalent of a "large content" ladder in Pierre: a single
 *  tokenize budget (`tokenizeMaxLength`, default 100_000) beyond which
 *  highlighting degrades to plain text. */
export const LARGE_CONTENT_BYTES = 500_000;

type PierreThemeRegistration = Awaited<ReturnType<CustomThemeLoader>>;

interface PierreTokens {
  background: string;
  foreground: string;
  mutedForeground: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  reasoning: string;
  ring: string;
  fontMono: string;
}

function readTokens(): PierreTokens {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim();
    return value.length > 0 ? value : fallback;
  };
  return {
    background: read('--background', '#0a0a0a'),
    foreground: read('--foreground', '#f5f5f5'),
    mutedForeground: read('--muted-foreground', '#a3a3a3'),
    success: read('--success', '#22c55e'),
    warning: read('--warning', '#eab308'),
    error: read('--error', '#ef4444'),
    info: read('--info', '#3b82f6'),
    reasoning: read('--reasoning', '#a78bfa'),
    ring: read('--ring', '#7c8aff'),
    fontMono: read('--font-mono', '"JetBrains Mono", monospace'),
  };
}

function withAppTheme<T>(appTheme: string, measure: () => T): T {
  const root = document.documentElement;
  const previous = root.getAttribute('data-theme');
  root.setAttribute('data-theme', appTheme);
  try {
    return measure();
  } finally {
    if (previous == null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', previous);
  }
}

/** Perceptual lightness in [0,1] for oklch/rgb/hex strings; null when unparseable. */
function colorLightness(color: string): number | null {
  const value = color.trim();
  if (value.startsWith('oklch(')) {
    const match = value.match(/oklch\(\s*([\d.]+)%?/);
    return match ? Number(match[1]) / (value.includes('%') ? 100 : 1) : null;
  }
  const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return colorLightness(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`);
  }
  return null;
}

function buildShikiTheme(name: string, type: 'light' | 'dark', t: PierreTokens): PierreThemeRegistration {
  return {
    name,
    type,
    fg: t.foreground,
    bg: t.background,
    colors: {
      'editor.background': t.background,
      'editor.foreground': t.foreground,
      'terminal.ansiGreen': t.success,
      'terminal.ansiRed': t.error,
      'terminal.ansiBlue': t.info,
      'gitDecoration.addedResourceForeground': t.success,
      'gitDecoration.deletedResourceForeground': t.error,
      'gitDecoration.modifiedResourceForeground': t.ring,
    },
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: t.mutedForeground } },
      { scope: ['string', 'string.regexp'], settings: { foreground: t.success } },
      { scope: ['keyword', 'keyword.control', 'storage.type', 'storage.modifier'], settings: { foreground: t.reasoning } },
      { scope: ['entity.name.function', 'support.function'], settings: { foreground: t.info } },
      { scope: ['constant.numeric', 'constant.language'], settings: { foreground: t.warning } },
      { scope: ['entity.name.type', 'support.type', 'entity.name.class'], settings: { foreground: t.ring } },
    ],
  };
}

let themesRegistered = false;

/** Register the measured Tide theme pair with Pierre. Idempotent — Pierre
 *  keeps the first registration per name, so this bakes the palette of the
 *  app theme active at first call. */
export function registerPierreThemes(): void {
  if (themesRegistered || typeof window === 'undefined') return;
  let darkTokens = readTokens();
  let lightTokens = withAppTheme(LIGHT_APP_THEME, readTokens);
  const darkLightness = colorLightness(darkTokens.background);
  const lightLightness = colorLightness(lightTokens.background);
  if (darkLightness != null && lightLightness != null && darkLightness > lightLightness) {
    [darkTokens, lightTokens] = [lightTokens, darkTokens];
  }
  registerCustomTheme(PIERRE_THEME_DARK, () => Promise.resolve(buildShikiTheme(PIERRE_THEME_DARK, 'dark', darkTokens)));
  registerCustomTheme(PIERRE_THEME_LIGHT, () => Promise.resolve(buildShikiTheme(PIERRE_THEME_LIGHT, 'light', lightTokens)));
  themesRegistered = true;
}

let themeTypeCache: { appTheme: string; type: 'dark' | 'light' } | null = null;

/** Resolve the Pierre theme type for the active app theme. All shipped Tide
 *  themes are dark; generality comes from measuring the resolved background
 *  lightness so future light themes work without changes here. */
export function getPierreThemeType(): 'dark' | 'light' {
  const appTheme = useUi.getState().appTheme;
  if (themeTypeCache?.appTheme === appTheme) return themeTypeCache.type;
  const lightness = colorLightness(readTokens().background);
  const type = lightness != null && lightness >= 0.5 ? 'light' : 'dark';
  themeTypeCache = { appTheme, type };
  return type;
}

/** Measured mono stack — set on the diff host as `--diffs-font-family`, which
 *  Pierre's shadow DOM consumes as an inherited custom property. */
export function getPierreFontStack(): string {
  return readTokens().fontMono;
}

let workerPool: WorkerPoolManager | undefined;

/** Module-level worker pool singleton. Workers are inlined (`?worker&inline`)
 *  because the production renderer loads over file://, where external worker
 *  chunk URLs don't resolve. */
export function getPierreWorkerPool(): WorkerPoolManager | undefined {
  if (typeof window === 'undefined') return undefined;
  registerPierreThemes();
  workerPool ??= getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: () => new PierreDiffWorker(),
      poolSize: Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1)),
    },
    highlighterOptions: {
      theme: PIERRE_THEMES,
      lineDiffType: 'none',
    },
  });
  return workerPool;
}

export function terminatePierreWorkerPool(): void {
  terminateWorkerPoolSingleton();
  workerPool = undefined;
}

interface SharedVirtualizerEntry {
  virtualizer: Virtualizer;
  refCount: number;
}

const sharedVirtualizers = new WeakMap<HTMLElement, SharedVirtualizerEntry>();

/** One Virtualizer per scroll root, shared by every VirtualizedFileDiff inside
 *  it (Pierre connects instances itself during render). The first acquirer's
 *  content container is the one observed for scroll-height growth. */
export function acquireSharedVirtualizer(root: HTMLElement, contentContainer?: HTMLElement): Virtualizer {
  let entry = sharedVirtualizers.get(root);
  if (entry == null) {
    const virtualizer = new Virtualizer();
    virtualizer.setup(root, contentContainer);
    entry = { virtualizer, refCount: 0 };
    sharedVirtualizers.set(root, entry);
  }
  entry.refCount += 1;
  return entry.virtualizer;
}

export function releaseSharedVirtualizer(root: HTMLElement): void {
  const entry = sharedVirtualizers.get(root);
  if (entry == null) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.virtualizer.cleanUp();
    sharedVirtualizers.delete(root);
  }
}

/** Nudge after a diff mounts inside a freshly laid-out container: Pierre's
 *  observers usually catch this, but a synthetic scroll + resize forces the
 *  virtualizer to recompute its window immediately. */
export function wakeVirtualizer(root: HTMLElement): void {
  window.dispatchEvent(new Event('resize'));
  root.dispatchEvent(new Event('scroll'));
}

/** Stable, cheap cache key so the worker pool dedupes highlight work across
 *  re-renders of identical content. */
export function contentCacheKey(prefix: string, contents: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < contents.length; i++) {
    hash ^= contents.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}:${(hash >>> 0).toString(36)}:${contents.length}`;
}
