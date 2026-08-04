import {
  PanelLeft,
  PanelRight,
  Terminal,
  PanelRightClose,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/quick-tooltip";
import { useUi } from "@/lib/stores/ui";
import { isMac } from "@/lib/utils";
import { OpenInAppMenu } from "./OpenInAppMenu";
/** Windows/Linux caption buttons (titleBarOverlay) need right-side clearance. */
const CAPTION_PAD = isMac ? 0 : 140;

export function WindowTopBar() {
  const toggleTerminal = useUi((s) => s.toggleTerminal);
  const toggleRightPanel = useUi((s) => s.toggleRightPanel);
  const toggleLeftPanel = useUi((s) => s.toggleLeftPanel);
  const toggleSessionsPanel = useUi((s) => s.toggleSessionsPanel);
  // const terminalOpen = useUi((s) => s.terminalOpen);
  // const rightPanelOpen = useUi((s) => s.rightPanelOpen);
  // const leftPanelOpen = useUi((s) => s.leftPanelOpen);
  // const sessionsPanelOpen = useUi((s) => s.sessionsPanelOpen);

  return (
    <div
      className="drag-region bg-card flex items-center px-2 gap-2 border-b border-input flex-shrink-0"
      style={{ height: 40 }}
    >
      {/* Left: panel toggle icons. Width matches sessions panel column
          below so the icons sit naturally above it. On macOS the traffic
          lights render at (12,12) over the far left — but the panel
          column starts at 220px so there's no collision. */}
      <div className="flex items-center gap-1.5" style={{ width: 220 }}>
        <Tip
          label={`Workspaces Panel`}
        >
          <Button
            variant="outline"
            size="sm"
            className="p-1.5"
            onClick={toggleLeftPanel}
          >
            <PanelLeft className="size-3.5" />
          </Button>
        </Tip>
        <Tip
          label={`Sessions Panel`}
        >
          <Button
            variant="outline"
            size="sm"
            className="p-1.5"
            onClick={toggleSessionsPanel}
          >
            <PanelRightClose className="size-3.5" />
          </Button>
        </Tip>
      </div>

      {/* Center: empty drag region — the frosted bar is the drag handle. */}
      <div className="flex-1" />

      {/* Right: open-in-app menu + terminal + right panel toggles.
          paddingRight reserves space for the native Windows/Linux caption
          buttons rendered by titleBarOverlay. */}
      <div
        className="flex items-center gap-1.5"
        style={{ paddingRight: CAPTION_PAD }}
      >
        <OpenInAppMenu />
        <Tip label={`Terminal Panel`}>
          <Button
            variant="outline"
            size="sm"
            className="p-1.5"
            onClick={toggleTerminal}
          >
            <Terminal className="size-3.5" />
          </Button>
        </Tip>
        <Tip label={`Right Panel`}>
          <Button
            variant="outline"
            size="sm"
            className="p-1.5"
            onClick={toggleRightPanel}
          >
            <PanelRight className="size-3.5" />
          </Button>
        </Tip>
        {/*<Tip label={`File viewer (${fileViewerOpen ? "open" : "closed"})`}>
          <Button
            variant="outline"
            size="sm"
            className="p-1.5"
            onClick={toggleFileViewer}
          >
            <FileText className="size-3.5" />
          </Button>
        </Tip>*/}
      </div>
    </div>
  );
}
