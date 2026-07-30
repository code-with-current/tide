import { PanelLeft, PanelRight, Terminal, PanelRightClose, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/quick-tooltip';
import { useUi } from '@/lib/stores/ui';
import { OpenInAppMenu } from './OpenInAppMenu';

/**
 * Unified window top bar — frosted, 40px, spans the full width above all
 * panels. This is the window's drag region. Contains:
 *   Left:   workspace panel toggle + sessions panel toggle icons
 *   Center: empty (drag area for moving the window)
 *   Right:  open-in-app menu + terminal toggle + right panel toggle + file viewer
 *
 * No model/permission/thinking controls (those live in the composer).
 * No breadcrumb (that's in ChatSubBar). No scripts (also ChatSubBar).
 */
export function WindowTopBar() {
  const toggleTerminal = useUi((s) => s.toggleTerminal);
  const toggleRightPanel = useUi((s) => s.toggleRightPanel);
  const toggleFileViewer = useUi((s) => s.toggleFileViewer);
  const toggleLeftPanel = useUi((s) => s.toggleLeftPanel);
  const toggleSessionsPanel = useUi((s) => s.toggleSessionsPanel);
  const terminalOpen = useUi((s) => s.terminalOpen);
  const rightPanelOpen = useUi((s) => s.rightPanelOpen);
  const fileViewerOpen = useUi((s) => s.fileViewerOpen);
  const leftPanelOpen = useUi((s) => s.leftPanelOpen);
  const sessionsPanelOpen = useUi((s) => s.sessionsPanelOpen);

  return (
    <div
      className="drag-region bg-card h-10 flex items-center px-2 gap-1 border-b border-input flex-shrink-0"
    >
      {/* Left: panel toggle icons. Width matches sessions panel column
          below so the icons sit naturally above it. */}
      <div className="flex items-center gap-0.5" style={{ width: 220 }}>
        <Tip label={`Workspaces panel (${leftPanelOpen ? 'visible' : 'hidden'})`}>
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleLeftPanel}>
            <PanelLeft className="size-3.5" />
          </Button>
        </Tip>
        <Tip label={`Sessions panel (${sessionsPanelOpen ? 'visible' : 'hidden'})`}>
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleSessionsPanel}>
            <PanelRightClose className="size-3.5" />
          </Button>
        </Tip>
      </div>

      {/* Center: empty drag region — the frosted bar is the drag handle. */}
      <div className="flex-1" />

      {/* Right: open-in-app menu + terminal + right panel toggles */}
      <div className="flex items-center gap-0.5">
        <OpenInAppMenu />
        <Tip label={`Terminal (${terminalOpen ? 'open' : 'closed'}) · T`}>
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleTerminal}>
            <Terminal className="size-3.5" />
          </Button>
        </Tip>
        <Tip label={`Right panel (${rightPanelOpen ? 'open' : 'closed'}) · R`}>
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleRightPanel}>
            <PanelRight className="size-3.5" />
          </Button>
        </Tip>
        <Tip label={`File viewer (${fileViewerOpen ? 'open' : 'closed'})`}>
          <Button variant="outline" size="sm" className="p-1.5" onClick={toggleFileViewer}>
            <FileText className="size-3.5" />
          </Button>
        </Tip>
      </div>
    </div>
  );
}
