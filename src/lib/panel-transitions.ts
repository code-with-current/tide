/** Edge-triggered panel auto-visibility on session availability transitions.
 *  The right panel is only ever auto-COLLAPSED — it never auto-expands:
 *  opening it is exclusively the user's call (fresh sessions and app
 *  restarts must leave it closed). */
export function panelTransition(input: {
  hasSessions: boolean;
  hasActive: boolean;
  prevHadSession: boolean;
}): { sessionsPanel: 'expand' | 'collapse' | 'keep'; rightPanel: 'collapse' | 'keep' } {
  const shouldShow = input.hasSessions && input.hasActive;
  if (shouldShow && !input.prevHadSession) {
    return { sessionsPanel: 'expand', rightPanel: 'keep' };
  }
  if (!shouldShow && input.prevHadSession) {
    return { sessionsPanel: 'collapse', rightPanel: 'collapse' };
  }
  return { sessionsPanel: 'keep', rightPanel: 'keep' };
}
