import { useState } from "react";
import {
  Search,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonBar } from "@/components/ui/loading-rows";
import {
  useWorkspaces,
  useRagStatus,
} from "@/lib/queries";
import { useUi } from "@/lib/stores/ui";
import type { RagStatus } from "@/types";
import { SettingsHeader } from "../shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { WorkspaceListRow } from "./workspace-list-row";
import { WorkspaceColumn } from "./workspace-detail";
import { RagColumn } from "./workspace-rag";

const STORAGE_KEY = "tide-ws-settings-selected";


export function WorkspaceSettingsSection() {
  const { data: workspaces, isLoading } = useWorkspaces();
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const openDialog = useUi((s) => s.openDialog);
  const [query, setQuery] = useState("");

  const validIds = workspaces ? new Set(workspaces.map((w) => w.id)) : null;
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (activeWorkspaceId && (!validIds || validIds.has(activeWorkspaceId)))
      return activeWorkspaceId;
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s && (!validIds || validIds.has(s))) return s;
    } catch {
      /* */
    }
    return null;
  });

  const effectiveId =
    selectedId && validIds?.has(selectedId)
      ? selectedId
      : activeWorkspaceId && validIds?.has(activeWorkspaceId)
        ? activeWorkspaceId
        : (workspaces?.[0]?.id ?? null);

  // Filter the sidebar list by the search query (matches Provider's pattern).
  const q = query.trim().toLowerCase();
  const filtered =
    q && workspaces
      ? workspaces.filter(
          (w) =>
            w.name.toLowerCase().includes(q) ||
            w.path.toLowerCase().includes(q),
        )
      : workspaces;

  // Split active vs archived so archived workspaces collapse into their own
  // group at the bottom of the list (mirrors the main WorkspacesPanel). Each
  // group respects the search filter above.
  const active = filtered?.filter((w) => !w.archivedAt) ?? [];
  const archived = filtered?.filter((w) => w.archivedAt) ?? [];

  const selected = workspaces?.find((w) => w.id === effectiveId);
  const handleSelect = (id: string) => {
    setSelectedId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* */
    }
  };

  // RAG hooks — scoped to selected workspace
  const { data: ragData } = useRagStatus(effectiveId);
  const ragStatus: RagStatus | undefined =
    ragData && !("error" in ragData) ? (ragData as RagStatus) : undefined;
  const enabledIds = ragStatus?.enabledWorkspaces ?? [];

  return (
    <div className="h-full flex flex-col overflow-hidden p-6 gap-4">
      <SettingsHeader
        title="Workspaces"
        description="Local repos Tide operates in. Edit scripts, RAG, and worktree settings."
        action={
          <Button size="sm" onClick={() => openDialog("addWorkspace")}>
            <Plus className="size-3.5" /> Add Workspace
          </Button>
        }
      />

      {/* Master/detail — mirrors ProvidersSection: responsive CSS grid with a
          transparent sidebar (search + add + list), collapsing to one column
          under lg. Detail keeps the two-column Workspace/RAG split. */}
      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6 flex-1 min-h-0">
        {/* Sidebar */}
        <aside className="flex flex-col lg:border-r border-border lg:pr-4 min-h-0 gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/50" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces…"
              className="w-full h-7 pl-7 pr-2 text-[11.5px] bg-secondary/40 border border-border rounded-md outline-none focus:border-primary/50 transition-colors"
            />
          </div>
          <Button size="sm" onClick={() => openDialog("addWorkspace")}>
            <Plus className="size-3.5" /> Add Workspace
          </Button>
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/55 font-semibold">
              Workspaces
            </span>
            {active.length > 0 && (
              <Badge variant="secondary" className="font-mono text-[9px]">
                {active.length}
              </Badge>
            )}
          </div>
          <div className="flex-1 overflow-y-auto scroll space-y-0.5">
            {isLoading && (
              <div className="space-y-0.5" aria-hidden>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5">
                    <SkeletonBar className="size-5 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <SkeletonBar className="h-3 w-2/5" />
                      <SkeletonBar className="h-2 w-3/5" />
                    </div>
                    <SkeletonBar className="h-4 w-8 shrink-0 rounded-full" />
                  </div>
                ))}
              </div>
            )}
            {/* Active workspaces */}
            {active.map((ws) => (
              <WorkspaceListRow
                key={ws.id}
                workspace={ws}
                active={ws.id === effectiveId}
                isEnabled={enabledIds.includes(ws.id)}
                onSelect={handleSelect}
              />
            ))}

            {/* Archived — collapsed into their own group at the bottom so they
                don't clutter the active list but remain reachable. Hidden when
                a search filter yields no archived matches. */}
            {archived.length > 0 && (
              <>
                <div className="flex items-center justify-between gap-1.5 px-1 pt-3 pb-1">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/45 font-semibold">
                    Archived
                  </span>
                  <Badge variant="secondary" className="font-mono text-[9px]">
                    {archived.length}
                  </Badge>
                </div>
                {archived.map((ws) => (
                  <WorkspaceListRow
                    key={ws.id}
                    workspace={ws}
                    active={ws.id === effectiveId}
                    isEnabled={enabledIds.includes(ws.id)}
                    onSelect={handleSelect}
                  />
                ))}
              </>
            )}

            {/* Empty filter result — only when not loading + a query is set */}
            {!isLoading && q && active.length === 0 && archived.length === 0 && (
              <div className="px-2 py-3 text-[11px] text-muted-foreground/50">
                No workspaces match "{query}".
              </div>
            )}
          </div>
        </aside>

        {/* Detail — two-column Workspace/RAG split (unchanged behavior). */}
        <section className="flex min-h-0">
          <div
            className={cn(
              "overflow-y-auto scroll px-5 py-4",
              ragStatus && enabledIds.includes(effectiveId ?? "")
                ? "flex-1 border-r border-border"
                : "flex-1",
            )}
          >
            {!selected ? (
              <div className="h-full flex items-center justify-center text-[13px] text-muted-foreground/40">
                {isLoading ? "Loading…" : "Select a workspace"}
              </div>
            ) : (
              <WorkspaceColumn
                key={selected.id}
                workspace={selected}
                effectiveId={effectiveId!}
                ragEnabled={enabledIds.includes(effectiveId ?? "")}
              />
            )}
          </div>

          {ragStatus && enabledIds.includes(effectiveId ?? "") && effectiveId && (
            <div className="flex-1 overflow-y-auto scroll px-5 py-4">
              <RagColumn workspaceId={effectiveId} status={ragStatus} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
