import { useState, useCallback } from "react";
import {
  ArrowLeft,
  KeyRound,
  Shield,
  Palette,
  Keyboard,
  Info,
  Bot,
  Sparkles,
  Plug,
  FolderCode,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/quick-tooltip";
import { useUi } from "@/lib/stores/ui";
import { cn, isMac } from "@/lib/utils";
import { ProvidersSection } from "./settings/ProvidersSection";
import { AutonomyCapsSection } from "./settings/AutonomyCapsSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { ShortcutsSection } from "./settings/ShortcutsSection";
import { AboutSection } from "./settings/AboutSection";
import { WorkspaceSettingsSection } from "./settings/WorkspaceSettingsSection";
import { AgentsSection } from "./settings/AgentsSection";
import { SkillsSection } from "./settings/SkillsSection";
import { McpSection } from "./settings/McpSection";

type SectionId =
  | "providers"
  | "autonomy"
  | "workspace"
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
      // Updates + Advanced are intentionally hidden until their controls are
      // wired (autoUpdater integration / live diagnostics + working buttons).
      // The component files are kept so they can be re-enabled as-is.
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

  const handleSelect = useCallback((id: SectionId) => {
    setSection(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* */
    }
  }, []);

  return (
    <div className="flex-1 flex overflow-hidden frosted bg-transparent relative">

      <div
        className="drag-region absolute top-0 right-0 h-10 z-50"
        style={{ left: 220 }}
      />

      {/* Sidebar */}
      <aside className="flex flex-col flex-shrink-0 p-2" style={{ width: 220 }}>
{isMac && <div className="h-8 flex-shrink-0 drag-region" />}
<div className={cn("px-3 py-2.5 flex items-center justify-between border-input flex-shrink-0 border-b ", !isMac && "drag-region")}>
          <div className="text-[1rem] uppercase tracking-wider text-foreground/80 font-bold font-stretch-semi-expanded">
            Settings
          </div>

          <Tip label="Back to Main" side="bottom">
            <Button
              variant="default"
              size="icon-sm"
              onClick={() => setScreen("main")}

            >
              <ArrowLeft />

            </Button>
          </Tip>


        </div>

        <nav className="flex-shrink-0 flex-1 p-2 justify-between">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? "mt-4" : ""}>
              <div className="px-2.5 py-1 text-[0.7rem] uppercase tracking-wider text-muted-foreground/60 font-semibold">
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
                        active ? "text-foreground" : "text-muted-foreground",
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

      <main className="flex-1 overflow-y-auto scroll rounded-2xl bg-card border border-input">
        {section === "workspace" || section === "providers" ? (
          <div className="h-full">
            {section === "workspace" && <WorkspaceSettingsSection />}
            {section === "providers" && <ProvidersSection />}
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-8 py-6">
            {section === "autonomy" && <AutonomyCapsSection />}
            {section === "appearance" && <AppearanceSection />}
            {section === "shortcuts" && <ShortcutsSection />}
            {section === "agents" && <AgentsSection />}
            {section === "skills" && <SkillsSection />}
            {section === "mcp" && <McpSection />}
            {/* Updates + Advanced hidden until wired — see NAV_GROUPS comment */}
            {section === "about" && <AboutSection />}
          </div>
        )}
      </main>
    </div>
  );
}
