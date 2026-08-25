/** Ported from upstream project (MIT, see THIRD_PARTY_NOTICES.md): packages/ui/src/components/chat/message/parts/ToolPartDiffPreview.tsx.
 *  Adaptations:
 *  - Theme seam (same as T3's tool-output-dialog.tsx): upstream's
 *    `useOptionalThemeSystem`/`ensurePierreThemeRegistered`/`getDefaultTheme`
 *    registry is replaced by Task 2's registered CSS-variable Shiki theme
 *    (`tide-md` via `ensureMarkdownShikiTheme`) plus a next-themes
 *    `resolveDark` for `themeType` — both theme ids point at the same
 *    CSS-variable theme so it follows Tide's light/dark toggle.
 *  - `DiffViewMode` comes from `../diff-view-toggle`; `PlainDiffFallback` from
 *    the T3 port. Re-indented 4-space → 2-space; named export added for the
 *    lazy import site (default export kept).
 */

import React from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import { useTheme } from 'next-themes';

import { ensureMarkdownShikiTheme } from '../../markdown/markdown-theme';
import { MARKDOWN_SHIKI_THEME } from '../../markdown/markdown-shiki-theme-definition';
import type { DiffViewMode } from '../diff-view-toggle';
import { PlainDiffFallback } from './plain-diff-fallback';

// Loaded lazily from ToolPart: this is the only part of the tool card that
// needs @pierre/diffs' rendering stack (Shiki core + regex engines), so the
// eager chat graph stays free of it and the chunk downloads on the first
// rendered tool diff.

const TOOL_DIFF_UNSAFE_CSS = `
  [data-diff-header],
  [data-diff] {
    [data-separator] {
      height: 24px !important;
    }
  }
`;

const TOOL_DIFF_METRICS = {
  hunkLineCount: 50,
  lineHeight: 24,
  diffHeaderHeight: 44,
  hunkSeparatorHeight: 24,
  spacing: 0,
};

type PierreThemeConfig = {
  pierreTheme: { light: string; dark: string };
  pierreThemeType: 'light' | 'dark';
};

/** Tide theme seam — see file header. */
const resolveDark = (resolvedTheme: string | undefined): boolean => {
  if (resolvedTheme === 'dark') return true;
  if (resolvedTheme === 'light') return false;
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const usePierreThemeConfig = (): PierreThemeConfig => {
  const { resolvedTheme } = useTheme();

  React.useEffect(() => {
    ensureMarkdownShikiTheme();
  }, []);

  return React.useMemo(() => ({
    pierreTheme: { light: MARKDOWN_SHIKI_THEME, dark: MARKDOWN_SHIKI_THEME },
    pierreThemeType: resolveDark(resolvedTheme) ? ('dark' as const) : ('light' as const),
  }), [resolvedTheme]);
};

class DiffPreviewErrorBoundary extends React.Component<{
  resetKey: string;
  fallback: React.ReactNode;
  children: React.ReactNode;
}, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      // oxlint-disable-next-line react/no-did-update-set-state -- upstream error-boundary reset: clears the fallback only when the resetKey (diff) changed, so it cannot loop.
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('Tool diff preview failed; rendering raw patch instead.', error);
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export interface ToolPartDiffPreviewProps {
  diff: string;
  diffViewMode: DiffViewMode;
}

const ToolPartDiffPreview: React.FC<ToolPartDiffPreviewProps> = React.memo(({ diff, diffViewMode }) => {
  const { pierreTheme, pierreThemeType } = usePierreThemeConfig();
  const options = React.useMemo(
    () => ({
      diffStyle: diffViewMode === 'side-by-side' ? 'split' as const : 'unified' as const,
      diffIndicators: 'none' as const,
      hunkSeparators: 'line-info-basic' as const,
      lineDiffType: 'none' as const,
      disableFileHeader: true,
      maxLineDiffLength: 1000,
      expansionLineCount: 20,
      overflow: 'wrap' as const,
      theme: pierreTheme,
      themeType: pierreThemeType,
      unsafeCSS: TOOL_DIFF_UNSAFE_CSS,
    }),
    [diffViewMode, pierreTheme, pierreThemeType]
  );

  const fallback = <PlainDiffFallback diff={diff} />;

  return (
    <div className="typography-code px-1 pb-1 pt-0">
      <DiffPreviewErrorBoundary resetKey={diff} fallback={fallback}>
        <PatchDiff
          patch={diff}
          metrics={TOOL_DIFF_METRICS}
          options={options}
          className="block w-full"
        />
      </DiffPreviewErrorBoundary>
    </div>
  );
});

ToolPartDiffPreview.displayName = 'ToolPartDiffPreview';

export { ToolPartDiffPreview };
export default ToolPartDiffPreview;
