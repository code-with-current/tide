import { useState, useCallback } from "react";
import {
  ArrowLeft,
  KeyRound,
  Shield,
  Palette,
  Keyboard,
  Info,
  FolderGit2,
  Bot,
  Sparkles,
  Plug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "AI",
    items: [
      { id: "providers", label: "LLM Providers", icon: KeyRound },
      { id: "autonomy", label: "Permissions & caps", icon: Shield },
    ],
  },
  {
    label: "Project",
    items: [{ id: "workspace", label: "Workspaces", icon: FolderGit2 }],
  },
  {
    label: "App",
    items: [
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
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
      {/* Drag region — covers the main content area's top strip only. It
          intentionally does NOT span over the sidebar: the sidebar holds the
          Back button + nav at the top, and an overlay there would sit above
          them in z-order and intercept clicks (siblings aren't covered by the
          .no-drag button exception, which only applies to descendants).
          left:200 matches the sidebar width below. */}
      <div
        className="drag-region absolute top-0 right-0 h-10 z-50"
        style={{ left: 200 }}
      />

      {/* Sidebar */}
      <aside className="flex flex-col flex-shrink-0 p-2" style={{ width: 200 }}>
        {/* mt-10 clears the macOS traffic lights (top-LEFT over this sidebar).
            Windows/Linux caption buttons are top-RIGHT, so no clearance here. */}
        <div
          className={cn("border-b border-input px-3 py-2.5", isMac && "mt-10")}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setScreen("main")}
            className="w-full justify-start"
          >
            <ArrowLeft className="size-4" /> Back
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto scroll p-2">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? "mt-4" : ""}>
              <div className="px-2.5 py-1 text-[0.8rem] uppercase tracking-wider text-muted-foreground/60 font-semibold">
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
