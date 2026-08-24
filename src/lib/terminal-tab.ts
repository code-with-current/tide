import { useUi, isRightPanelOpen, terminalScopeKey } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';

/** Switch the unified right panel to the active scope's terminal tab and
 *  open the panel. Seeds a first terminal when the scope has none (mirrors
 *  the old bottom-dock toggle's auto-seed). */
export function openTerminalTab() {
  const s = useUi.getState();
  const scope = terminalScopeKey(s);
  if (s.activeSessionId && (s.terminals[scope] ?? []).length === 0) {
    s.addTerminal(scope);
  }
  useTabs.getState().addTab(s.activeSessionId ?? 'default', 'terminal');
  s.setRightPanel(true);
}

/** True toggle for the Terminal button / 'T' shortcut: focus the terminal
 *  tab (opening the panel if needed), or close the panel when it is
 *  already showing it. */
export function toggleTerminalTab() {
  const s = useUi.getState();
  const onTerminalTab =
    useTabs.getState().active[s.activeSessionId ?? 'default'] === 'terminal';
  if (isRightPanelOpen(s) && onTerminalTab) {
    s.setRightPanel(false);
    return;
  }
  openTerminalTab();
}
