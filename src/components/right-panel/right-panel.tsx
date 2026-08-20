/**
 * RightPanel — renders content based on the active feature (inspector / files /
 * git), with NO tab strip. The view is switched from the top bar's 3-button
 * "Right Panel Switcher" (Info / Explorer / Git).
 */
import type { RightTabKind } from '@/types';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { useSession } from '@/lib/queries';
import { InspectorTab } from './tabs/inspector-tab';
import { FileExplorerTab } from './tabs/file-explorer-tab';
import { GitPanel } from '@/components/git/git-panel';
import { InspectorSkeleton } from './inspector-skeleton';

export function RightPanel() {
  const sessionId = useUi((s) => s.activeSessionId ?? 'default');
  const activeSessionId = useUi((s) => s.activeSessionId);
  const { data: session, isLoading: sessionLoading } = useSession(activeSessionId);
  const hasPermissionPending = useUi((s) =>
    !!(activeSessionId && s.streams[activeSessionId]?.permissionRequest?.toolCalls.length),
  );

  const feature = useTabs((s) => s.active[sessionId] ?? 'inspector') as RightTabKind;

  return (
    <aside className="bg-card flex flex-col h-full w-full min-w-0 overflow-hidden relative z-40">
      {hasPermissionPending && (
        <div className="absolute inset-0 z-40 bg-background/60 backdrop-blur-[2px] pointer-events-none" />
      )}

      <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
        {feature === 'inspector' && session ? (
          <InspectorTab session={session} />
        ) : feature === 'inspector' ? (
          sessionLoading ? (
            <InspectorSkeleton />
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/60 p-4 text-center">
              Select a session to inspect.
            </div>
          )
        ) : feature === 'files' ? (
          <FileExplorerTab />
        ) : feature === 'changes' ? (
          <div className="flex-1 overflow-y-auto scroll"><GitPanel /></div>
        ) : null}
      </div>
    </aside>
  );
}


