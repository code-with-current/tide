import { useState, useCallback } from "react";
import {
  ArrowLeft,
  KeyRound,
  Shield,
  Settings,
  Keyboard,
  Info,
  Bot,
  Sparkles,
  Plug,
  FolderCode,
  Palette,
  DownloadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/quick-tooltip";
import { useUi } from "@/lib/stores/ui";
import { cn, isMac } from "@/lib/utils";
import { ProvidersSection } from "./settings/providers/providers";
import { AutonomyCapsSection } from "./settings/permissions";
import { AppearanceSection } from "./settings/appearance";
import { GeneralSection } from "./settings/general";
import { ShortcutsSection } from "./settings/shortcuts";
import { AboutSection } from "./settings/about";
import { UpdatesSection } from "./settings/updates";
import { WorkspaceSettingsSection } from "./settings/workspace/workspace";
import { AgentsSection } from "./settings/extensions/agents";
import { SkillsSection } from "./settings/extensions/skills";
import { McpSection } from "./settings/mcp/mcp";

type SectionId =
  | "providers"
  | "autonomy"
  | "workspace"
  | "general"
  | "appearance"
  | "shortcuts"
  | "updates"
  | "advanced"
  | "agents"
  | "skills"
  | "mcp"
  | "about";

type NavItem = { id: SectionId; label: string; icon: typeof KeyRound };
type NavGroup = { label?: string | undefined; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { id: "general", label: "General", icon: Settings },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
    ],
  },
  {
    label: "Project",
    items: [{ id: "workspace", label: "Workspaces", icon: FolderCode }],
  },
  {
    label: "AI",
    items: [
      { id: "providers", label: "LLM Providers", icon: KeyRound },
      { id: "autonomy", label: "Permissions & Caps", icon: Shield },
    ],
  },
  {
    label: "Extensions",
    items: [
      { id: "agents", label: "Agents", icon: Bot },
      { id: "skills", label: "Skills", icon: Sparkles },
      { id: "mcp", label: "MCP", icon: Plug },
    ],
  },
  {
    label: "System",
    items: [
      { id: "updates", label: "Updates", icon: DownloadCloud },
      { id: "about", label: "About", icon: Info },
    ],
  },
];

const STORAGE_KEY = "tide-settings-section";

function getSavedSection(): SectionId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && NAV_GROUPS.some((g) => g.items.some((i) => i.id === saved))) {
      return saved as SectionId;
    }
  } catch {
    /* */
  }
  return "providers";
}

export function SettingsScreen() {
  const [section, setSection] = useState<SectionId>(getSavedSection);
  const setScreen = useUi((s) => s.setScreen);
  const isFullScreen = useUi((s) => s.isFullScreen);

  const handleSelect = useCallback((id: SectionId) => {
    setSection(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* */
    }
  }, []);

  return (
    <div className="flex-1 flex overflow-hidden bg-sidebar relative">

      <div
        className="drag-region absolute top-0 right-0 h-10 z-50"
        style={{ left: 220 }}
      />

      {/* Sidebar */}
      <aside className="flex flex-col flex-shrink-0 p-2" style={{ width: 300 }}>
        {/* Spacer clearing the native macOS traffic lights (top-left, 12,12).
            Collapses to zero while fullscreen — the buttons hide there. */}
        {isMac && (
          <div
            className={cn(
              "flex-shrink-0 drag-region",
              isFullScreen ? "h-0" : "h-6",
            )}
          />
        )}
<div className={cn("px-3 py-4 flex items-center justify-between border-foreground flex-shrink-0 border-b ", !isMac && "drag-region")}>
          <div className="text-[1rem] uppercase tracking-wider text-sidebar-foreground font-bold font-stretch-semi-expanded">
            Settings
          </div>

          <Tip label="Back to Main" side="bottom">
            <Button
              variant="default"
              size="icon-sm"
              className="z-50"
              onClick={() => setScreen("main")}

            >
              <ArrowLeft />

            </Button>
          </Tip>


        </div>

        <nav className="flex-shrink-0 flex-1 p-2 justify-between">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label ?? `group-${gi}`} className={gi > 0 ? "mt-4" : ""}>
              <div className="px-2.5 py-1 text-[0.7rem] uppercase tracking-wider text-sidebar-foreground/30 font-semibold">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active = section === item.id;
                  return (
                    <Button
                      key={item.id}
                      size="lg"
                      variant={active ? "secondary" : "ghost"}
                      onClick={() => handleSelect(item.id)}
                      className={cn(
                        "w-full justify-start transition-colors",
                        active ? "" : "text-muted-foreground",
                      )}
                    >
                      <item.icon className="size-4" /> {item.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}

        </nav>

      </aside>

      <main className={cn("flex-1 overflow-y-auto scroll bg-background border border-l")}>
        {section === "workspace" || section === "providers" ? (
          <div className="h-full">
            {section === "workspace" && <WorkspaceSettingsSection />}
            {section === "providers" && <ProvidersSection />}
          </div>
        ) : (
          <div className="max-w-5xl mx-auto px-8 py-6">
            {section === "autonomy" && <AutonomyCapsSection />}
            {section === "general" && <GeneralSection />}
            {section === "appearance" && <AppearanceSection />}
            {section === "shortcuts" && <ShortcutsSection />}
            {section === "agents" && <AgentsSection />}
            {section === "skills" && <SkillsSection />}
            {section === "mcp" && <McpSection />}
            {section === "updates" && <UpdatesSection />}
            {section === "about" && <AboutSection />}
          </div>
        )}
      </main>
    </div>
  );
}
