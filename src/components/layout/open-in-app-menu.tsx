/** OpenInAppMenu: sticky top-bar split-button opening the active session's folder in an external app. Picking an app promotes it to the persisted default. */
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUi } from "@/lib/stores/ui";
import { useExternalApps } from "@/lib/use-external-apps";
import { Tip } from "../ui/quick-tooltip";

export function OpenInAppMenu() {
  const activeSessionId = useUi((s) => s.activeSessionId);
  const {
    visibleApps,
    loading,
    defaultApp,
    pickApp,
    openDefault,
    renderAppIcon,
  } = useExternalApps();

  // Disable only when there's no active session. Don't disable during initial detection load (visibleApps=[] until apps arrive) — that would gray the button prematurely; the primary button shows its own spinner and the chevron's menu shows "No apps available" when empty.
  const disabled = !activeSessionId;

  return (
  <Tip
    label={`Open with`}
  >
    <ButtonGroup>
      {/* Primary: open in the default app immediately. */}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => activeSessionId && openDefault(activeSessionId)}
      >
        {loading && visibleApps.length === 0 ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          renderAppIcon(defaultApp, "size-3.5")
        )}
      </Button>

      {/* Chevron: open the menu; selecting an item promotes it to default. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            className="p-0"
            disabled={disabled}
          >
            <ChevronDown className="size-2.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="w-48">
          <DropdownMenuLabel>Open with</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {visibleApps.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No apps available
            </div>
          ) : (
            visibleApps.map((app) => (
              <DropdownMenuItem
                key={app.id}
                onSelect={(e) => {
                  e.preventDefault();
                  if (activeSessionId) pickApp(app.id, activeSessionId);
                }}
                className="gap-2"
              >
                {renderAppIcon(app, "size-3.5")}
                <span className="flex-1">{app.label}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      </ButtonGroup>
  </Tip>
  );
}
