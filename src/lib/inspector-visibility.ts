import { useSyncExternalStore } from 'react';

// The permanent inspector column only earns its space when the window is wide
// enough that the chat column keeps its floor and the unified right panel can
// be closed without cramping. Measured on the window via matchMedia —
// consistent at mount, not just on resize events (mirrors right-panel-layout).
export const INSPECTOR_COLUMN_MIN_WIDTH = 1400;
export const INSPECTOR_COLUMN_MEDIA_QUERY = '(min-width: 1400px)';

/** The permanent inspector column shows only when there's room to spare and
 *  the unified right panel isn't occupying the right side. */
export function showInspectorColumn(input: { width: number; rightPanelOpen: boolean; hasSession: boolean }): boolean {
  return input.hasSession && !input.rightPanelOpen && input.width >= INSPECTOR_COLUMN_MIN_WIDTH;
}

function subscribe(onChange: () => void) {
  const query = window.matchMedia(INSPECTOR_COLUMN_MEDIA_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isWideEnough() {
  return window.matchMedia(INSPECTOR_COLUMN_MEDIA_QUERY).matches;
}

/** Live variant of showInspectorColumn — window width comes from matchMedia
 *  so it stays consistent at mount and updates on resize. */
export function useInspectorColumnVisible(rightPanelOpen: boolean, hasSession: boolean): boolean {
  const wide = useSyncExternalStore(subscribe, isWideEnough, () => false);
  return showInspectorColumn({
    width: wide ? INSPECTOR_COLUMN_MIN_WIDTH : INSPECTOR_COLUMN_MIN_WIDTH - 1,
    rightPanelOpen,
    hasSession,
  });
}
