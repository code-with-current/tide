/**
 * OpenInAppMenu — sticky split-button in the top bar that opens the active
 * session's project folder in an external app.
 *
 * Behavior:
 *   - Primary click opens in the **default** app (Finder/File Explorer on
 *     first run).
 *   - Chevron opens the full menu; picking an app opens it **and** promotes
 *     it to the new default, persisted in localStorage so the choice survives
 *     reload. This matches the "open with → becomes default" UX of OS menus.
 *
 * Detection, icon rendering, and the open handler live in the shared
 * `useExternalApps` hook (src/lib/useExternalApps.ts) so the SessionItem
 * "Open with…" context-menu submenu can reuse them.
 *
 * The path is resolved server-side from `activeSessionId` (worktree →
 * workspace → HOME; mirrors terminal.ts). The renderer never passes an
 * arbitrary path.
 */
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
import { useExternalApps } from "@/lib/useExternalApps";

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

  // Disable only when there's no active session. Don't disable during the
  // initial detection load (visibleApps is [] until apps arrives) — that
  // would gray the button via disabled:opacity-50 even though we're about
  // to have apps. The primary button already shows a spinner while loading;
  // the chevron's menu handles the empty case with a "No apps available" row.
  const disabled = !activeSessionId;

  return (
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
  );
}
