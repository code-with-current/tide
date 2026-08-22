/**
 * RightPanel — renders the active right-panel tab (files / git / browser /
 * agents / terminal), with NO tab strip. The view is switched from the top
 * bar's "Right Panel Switcher" buttons.
 */
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { FileExplorerTab } from './tabs/file-explorer-tab';
import { GitTab } from './tabs/git-tab';
import { BrowserTab } from './tabs/browser-tab';
import { AgentsTab } from './tabs/agents-tab';
import { PanelLanding } from './panel-landing';
import { TerminalPanel } from '@/components/terminal/terminal-panel';

export function RightPanel() {
  const sessionId = useUi((s) => s.activeSessionId ?? 'default');
  const activeSessionId = useUi((s) => s.activeSessionId);
  const hasPermissionPending = useUi((s) =>
    !!(activeSessionId && s.streams[activeSessionId]?.permissionRequest?.toolCalls.length),
  );

  const feature = useTabs((s) => s.active[sessionId] ?? 'files');

  return (
    <aside className="bg-card flex flex-col h-full w-full min-w-0 overflow-hidden relative z-40">
      {hasPermissionPending && (
        <div className="absolute inset-0 z-40 bg-background/60 backdrop-blur-[2px] pointer-events-none" />
      )}

      <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
        {feature === 'home' ? (
          <PanelLanding />
        ) : feature === 'files' ? (
          <FileExplorerTab />
        ) : feature === 'git' ? (
          <GitTab />
        ) : feature === 'browser' ? (
          <BrowserTab />
        ) : feature === 'terminal' ? (
          <TerminalPanel />
        ) : feature === 'agents' && activeSessionId ? (
          <AgentsTab sessionId={activeSessionId} />
        ) : null}
      </div>
    </aside>
  );
}


