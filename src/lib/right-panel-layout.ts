import { useSyncExternalStore } from 'react';

// Single source of truth for when the right panel switches from inline (in-flow,
// resizable) to overlay (Sheet). Below this width the chat column needs its full
// floor, so the right panel stops competing for in-flow space. Measured on the
// window via matchMedia — consistent at mount, not just on resize events.
export const RIGHT_PANEL_INLINE_MEDIA_QUERY = '(max-width: 1199px)';

function subscribe(onChange: () => void) {
  const query = window.matchMedia(RIGHT_PANEL_INLINE_MEDIA_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function useRightPanelOverlay(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(RIGHT_PANEL_INLINE_MEDIA_QUERY).matches,
    () => false,
  );
}
