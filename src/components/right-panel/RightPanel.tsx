import { useState } from 'react';
import {
  Info,
  FolderTree,
  GitCompareArrows,
  GitPullRequestArrow,
  Terminal,
  Plus,
  Lock,
  X,
} from 'lucide-react';
import type { RightTab, RightTabKind } from '@/types';
import { useUi } from '@/lib/stores/ui';
import { useTabs } from '@/lib/stores/tabs';
import { useSession } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { ScrollTabs, ScrollTabsList, ScrollTabsTrigger } from '@/components/ui/scroll-tabs';
import { Tip } from '@/components/ui/quick-tooltip';
import { InspectorTab } from './tabs/InspectorTab';
import { FileExplorerTab } from './tabs/FileExplorerTab';
import { SourceControlPanel } from '@/components/source-control/SourceControlPanel';
import { TerminalTab } from './tabs/TerminalTab';
import { Button } from '@/components/ui/button';

/** Module-level stable arrays — avoids the Zustand selector infinite-loop. */
const DEFAULT_INSPECTOR_TABS: RightTab[] = [{ kind: 'inspector', locked: true }];

const TAB_META: Record<RightTabKind, { label: string; icon: React.ReactNode }> = {
  inspector: { label: 'Inspector', icon: <Info className="size-4" /> },
  files: { label: 'File Explorer', icon: <FolderTree className="size-4" /> },
  review: { label: 'Review', icon: <GitCompareArrows className="size-4" /> },
  changes: { label: 'Source Control', icon: <GitPullRequestArrow className="size-4" /> },
  terminal: { label: 'Terminal', icon: <Terminal className="size-4" /> },
};

const ADDABLE: { kind: RightTabKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'files', label: 'File Explorer', icon: <FolderTree className="size-3.5 text-muted-foreground/60" /> },
  { kind: 'changes', label: 'Source Control', icon: <GitPullRequestArrow className="size-3.5 text-muted-foreground/60" /> },
];

export function RightPanel() {
  const [pickerOpen, setPickerOpen] = useState(false);
  const sessionId = useUi((s) => s.activeSessionId ?? 'default');
  const activeSessionId = useUi((s) => s.activeSessionId);
  const { data: session } = useSession(activeSessionId);
  // True when there's a pending permission prompt for this session — used to
  // dim the panel content so the floating permission card stands out.
  const hasPermissionPending = useUi((s) =>
    !!(activeSessionId && s.streams[activeSessionId]?.permissionRequest?.toolCalls.length),
  );

  const tabs = useTabs((s) => s.bySession[sessionId] ?? DEFAULT_INSPECTOR_TABS);
  const featureActive = useTabs((s) => s.active[sessionId] ?? 'inspector');
  const addTab = useTabs((s) => s.addTab);
  const removeTab = useTabs((s) => s.removeTab);
  const setFeatureActive = useTabs((s) => s.setActive);

  // (Files are handled by the dedicated FileViewerPanel now — this panel only
  //  manages feature tabs: inspector, explorer, terminal, etc. Files no longer
  //  hijack a tab slot.)
  const activeId = featureActive;

  // Feature tabs only — files live in the dedicated FileViewerPanel.
  const items: Array<{ id: string; label: string; icon: React.ReactNode; locked?: boolean; title?: string }> = [
    ...tabs.map((t) => ({
      id: t.kind,
      label: TAB_META[t.kind].label,
      icon: TAB_META[t.kind].icon,
      locked: t.locked,
    })),
  ];

  const handleSelect = (id: string) => setFeatureActive(sessionId, id as RightTabKind);
  const handleClose = (id: string) => removeTab(sessionId, id as RightTabKind);

  const addedKinds = new Set(tabs.map((t) => t.kind));

  // Resolve what to render in the content area.
  const activeFeature = activeId as RightTabKind;

  return (
    <aside className="@container bg-card flex flex-col h-full w-full min-w-0 overflow-hidden">
      {hasPermissionPending && (
        <div className="absolute inset-0 z-40 bg-background/60 backdrop-blur-[2px] pointer-events-none" />
      )}
      <ScrollTabs
        value={activeId}
        onValueChange={handleSelect}
        orientation="horizontal"
        className="flex flex-col gap-0 flex-1 min-h-0"
      >
        <ScrollTabsList
          className="h-10"
          onClick={(e) => {
            const t = e.target as HTMLElement;
            if (!t.closest('#rtab-picker') && !t.closest('#rtab-add')) {
              setPickerOpen(false);
            }
          }}
          trailing={
            <div className="relative flex items-center flex-none pr-1">
              <Tip label="Add Tab" side="bottom">
                <Button
                  id="rtab-add"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setPickerOpen((o) => !o)}
                >
                  <Plus className="size-3.5" />
                </Button>
              </Tip>
              {pickerOpen && (
                <div
                  id="rtab-picker"
                  className="absolute top-full right-0 mt-1 z-50 rounded-md py-1 bg-secondary border border-border shadow-[0_10px_30px_-8px_rgba(0,0,0,0.6)] animate-slide-up"
                  style={{ width: 200 }}
                >
                  <div className="px-2.5 py-1.5 text-[0.8rem] uppercase tracking-wider text-muted-foreground/60 font-semibold">
                    Add Tab
                  </div>
                  {ADDABLE.map((opt) => {
                    const added = addedKinds.has(opt.kind);
                    return (
                      <Button
                        key={opt.kind}
                        variant="ghost"
                        size="icon-sm"
                        disabled={added}
                        onClick={() => {
                          addTab(sessionId, opt.kind);
                          setPickerOpen(false);
                        }}
                        className={cn(
                          'w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent',
                          added && 'opacity-50 pointer-events-none',
                        )}
                      >
                        {opt.icon}
                        <span className="text-[0.8rem] flex-1">{opt.label}</span>
                        <Plus className="size-3 text-muted-foreground/60" />
                      </Button>
                    );
                  })}
                  <div className="px-2.5 py-1.5 mt-1 border-t border-input">
                    <div className="text-[0.8rem] text-muted-foreground/60 flex items-center gap-1">
                      <Lock className="size-3" /> Inspector is always present
                    </div>
                  </div>
                </div>
              )}
            </div>
          }
        >
          {items.map((item) => (
            <ScrollTabsTrigger
              key={item.id}
              value={item.id}
              title={item.title}
              className="px-2.5 h-[2rem] gap-1.5 text-xs"
            >
              {item.icon}
              <span className="truncate text-[0.8rem] max-w-[13rem]">{item.label}</span>
              {!item.locked && (
                // Span (not button) so we don't nest <button> in the
                // Radix TabsTrigger (which is itself a button). Stop
                // propagation so closing doesn't also select the tab.
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClose(item.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      e.preventDefault();
                      handleClose(item.id);
                    }
                  }}
                  className={cn(
                    'ml-0.5 inline-flex items-center justify-center rounded size-3.5 flex-none transition-colors',
                    'text-muted-foreground/60 hover:bg-accent hover:text-foreground',
                  )}
                  title="Close tab"
                  aria-label={`Close ${item.label}`}
                >
                  <X className="size-3 pointer-events-none" />
                </span>
              )}
            </ScrollTabsTrigger>
          ))}
        </ScrollTabsList>

        {/* Tab content — bg-card so the active tab's curved bottom
            flows into the content body without a visible seam.
            Conditionally rendered (not via TabsContent) since several
            panes have their own mount/scroll containers. */}
        <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col bg-card relative">
          {/* Dim overlay when a permission prompt is pending — focuses attention
              on the floating permission card at the bottom of the panel. */}

          {activeFeature === 'inspector' && session ? (
            <div className="flex-1 min-h-0 min-w-0 flex flex-col">
              <InspectorTab session={session} />
            </div>
          ) : activeFeature === 'inspector' ? (
            <div className="flex-1 min-w-0 flex items-center justify-center text-xs text-muted-foreground/60 p-4 text-center">
              Select a session to inspect.
            </div>
          ) : activeFeature === 'files' ? (
            <div className="flex-1 min-w-0 min-h-0 overflow-hidden"><FileExplorerTab /></div>
          ) : activeFeature === 'review' ? (
            <div className="flex-1 min-w-0 flex items-center justify-center text-xs text-muted-foreground p-4 text-center">
              Review is now part of the Inspector tab.
            </div>
          ) : activeFeature === 'changes' ? (
            <div className="flex-1 min-w-0 overflow-y-auto scroll"><SourceControlPanel /></div>
          ) : activeFeature === 'terminal' ? (
            <TerminalTab />
          ) : null}
        </div>
      </ScrollTabs>
    </aside>
  );
}
