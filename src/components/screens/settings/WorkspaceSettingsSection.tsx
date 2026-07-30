import { useState } from "react";
import {
  Trash2,
  Play,
  Power,
  Save,
  RefreshCw,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Pencil,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Chip } from "@/components/primitives";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useWorkspaces,
  useRagStatus,
  useUpdateRagConfig,
  useEnableRagWorkspace,
  useDisableRagWorkspace,
  useInitRagWorkspace,
  useRagInitProgress,
  useArchiveWorkspace,
  useUnarchiveWorkspace,
  useDeleteWorkspace,
} from "@/lib/queries";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useUi } from "@/lib/stores/ui";
import * as api from "@/lib/api/client";
import type { Workspace, WorkspaceScript, RagStatus } from "@/types";
import { Card, SettingsGroup, SettingsRow } from "./shared";
import { cn } from "@/lib/utils";

const SCRIPT_META: Record<
  WorkspaceScript["kind"],
  {
    label: string;
    icon: React.ReactNode;
    tone: string;
    hint: string;
    placeholder: string;
  }
> = {
  setup: {
    label: "Setup",
    icon: <Power className="size-3" />,
    tone: "text-info",
    hint: "Runs on first open or after a fresh clone.",
    placeholder: "npm install",
  },
  run: {
    label: "Run",
    icon: <Play className="size-3" />,
    tone: "text-success",
    hint: 'Default command for the "Run" action.',
    placeholder: "npm run dev",
  },
  delete: {
    label: "Cleanup",
    icon: <Trash2 className="size-3" />,
    tone: "text-destructive",
    hint: "Runs before the workspace is removed.",
    placeholder: "git worktree prune",
  },
};

const STORAGE_KEY = "tide-ws-settings-selected";

export function WorkspaceSettingsSection() {
  const { data: workspaces, isLoading } = useWorkspaces();
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);

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
    <div className="flex h-full">
      {/* SIDEBAR */}
      <aside className="w-[180px] flex-shrink-0 border-r border-input bg-card flex flex-col">
        <div className="px-3 py-2.5 border-b border-input flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
            Workspaces
          </div>
          <span className="text-[10px] text-muted-foreground/60">
            {workspaces?.length ?? 0}
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto scroll p-1.5 space-y-0.5">
          {isLoading && (
            <div className="text-[11px] text-muted-foreground/60 px-2 py-1">
              Loading…
            </div>
          )}
          {workspaces?.map((ws) => (
            <WorkspaceListRow
              key={ws.id}
              workspace={ws}
              active={ws.id === effectiveId}
              isEnabled={enabledIds.includes(ws.id)}
              onSelect={handleSelect}
            />
          ))}
        </nav>
        <div className="pt-3 mt-auto border-t border-border/60 px-2 pb-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/50 font-semibold mb-1.5">
            Model
          </div>
          <div className="flex items-center gap-2 px-1">
            <CheckCircle2 className="size-3 text-emerald-400/80" />
            <span className="text-[11px] text-muted-foreground/70">
              Bundled · 22 MB
            </span>
          </div>
        </div>
      </aside>

      {/* CONTENT: two columns */}
      <div className="flex-1 flex min-w-0">
        {/* LEFT COLUMN: Workspace settings */}
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

        {/* RIGHT COLUMN: RAG config (only when enabled) */}
        {ragStatus && enabledIds.includes(effectiveId ?? "") && effectiveId && (
          <div className="flex-1 overflow-y-auto scroll px-5 py-4">
            <RagColumn workspaceId={effectiveId} status={ragStatus} />
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================
// SIDEBAR ROW — one workspace in the list, with a right-click
// context menu mirroring the sidebar's actions (Archive / Unarchive
// / Delete). Rename selects the workspace so its Name field in the
// detail column (WorkspaceColumn) gets focus — avoids a second
// inline-rename flow here. Hooks live in this child component so they
// can be called once per row without violating rules-of-hooks.
// =============================================================

function WorkspaceListRow({
  workspace,
  active,
  isEnabled,
  onSelect,
}: {
  workspace: Workspace;
  active: boolean;
  isEnabled: boolean;
  onSelect: (id: string) => void;
}) {
  const archived = !!workspace.archivedAt;
  const archiveWorkspace = useArchiveWorkspace(workspace.id);
  const unarchiveWorkspace = useUnarchiveWorkspace(workspace.id);
  const deleteWorkspace = useDeleteWorkspace(workspace.id);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Rename = select the workspace; the detail column's Name <Input> is where
  // the actual edit happens (single source of truth for the save logic).
  const handleRename = () => onSelect(workspace.id);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* div role="button" (not <button>) so the ContextMenu trigger nests
            cleanly and matches the sidebar row pattern. Keyboard-accessible. */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => onSelect(workspace.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(workspace.id);
            }
          }}
          className={cn(
            "w-full flex items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[12px] transition-colors cursor-default outline-none focus-visible:ring-1 focus-visible:ring-ring",
            active
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground/90",
            archived && "opacity-60",
          )}
        >
          <span
            className={cn(
              "size-[5px] rounded-full shrink-0 transition-colors",
              isEnabled ? "bg-emerald-400" : "bg-muted-foreground/25",
            )}
          />
          <span className="truncate flex-1 leading-tight">{workspace.name}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onSelect={handleRename}>
          <Pencil className="size-3.5" /> Rename
        </ContextMenuItem>
        {!archived ? (
          <ContextMenuItem onSelect={() => archiveWorkspace.mutate(workspace.id)}>
            <Archive className="size-3.5" /> Archive
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem onSelect={() => unarchiveWorkspace.mutate(workspace.id)}>
              <ArchiveRestore className="size-3.5" /> Unarchive
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onSelect={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5" /> Delete…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete workspace permanently?</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground px-1 -mt-1">
            "{workspace.name}" will be removed from Tide. All its archived
            sessions will be permanently deleted from disk. The repository
            folder on disk is not touched. This can't be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                deleteWorkspace.mutate(workspace.id);
                setConfirmDelete(false);
              }}
            >
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ContextMenu>
  );
}

// =============================================================
// LEFT COLUMN: Workspace properties + RAG toggle + Scripts
// =============================================================

function WorkspaceColumn({
  workspace,
  effectiveId,
  ragEnabled,
}: {
  workspace: Workspace;
  effectiveId: string;
  ragEnabled: boolean;
}) {
  const qc = useQueryClient();
  const enableWs = useEnableRagWorkspace(effectiveId);
  const disableWs = useDisableRagWorkspace(effectiveId);
  const initWs = useInitRagWorkspace(effectiveId);

  const [name, setName] = useState(workspace.name);
  const [repository, setRepository] = useState(workspace.repository ?? "");
  const [location, setLocation] = useState(workspace.path);
  const [worktreeLocation, setWorktreeLocation] = useState(
    workspace.worktreeLocation,
  );
  const initialCmd = (kind: WorkspaceScript["kind"]) =>
    workspace.scripts.find((s) => s.kind === kind)?.command ?? "";
  const [setupCmd, setSetupCmd] = useState(initialCmd("setup"));
  const [runCmd, setRunCmd] = useState(initialCmd("run"));
  const [deleteCmd, setDeleteCmd] = useState(initialCmd("delete"));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const scripts: WorkspaceScript[] = [];
    if (setupCmd.trim())
      scripts.push({ kind: "setup", command: setupCmd.trim() });
    if (runCmd.trim()) scripts.push({ kind: "run", command: runCmd.trim() });
    if (deleteCmd.trim())
      scripts.push({ kind: "delete", command: deleteCmd.trim() });
    await api.updateWorkspace(workspace.id, {
      name: name.trim() || workspace.name,
      repository: repository.trim() || undefined,
      path: location.trim(),
      worktreeLocation: worktreeLocation.trim(),
      scripts,
    });
    qc.invalidateQueries({ queryKey: ["workspaces"] });
    setSaving(false);
  };

  return (
    <div>
      <div
        className="text-[12x] font-semibold uppercase text-foreground/50"
        style={{ height: 40 }}
      >
        ⬡ {workspace.name}
      </div>

      {/* General */}
      <SettingsGroup title="General">
        <Card>
          <SettingsRow title="Name">
            <Input
              className="w-[14rem] h-8 text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </SettingsRow>
          <SettingsRow title="Repository" description="Git remote URL.">
            <Input
              className="w-[18rem] h-8 text-xs font-mono"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="git@github.com:owner/repo.git"
            />
          </SettingsRow>
          <SettingsRow title="Location">
            <Input
              className="w-[18rem] h-8 text-xs font-mono"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            title="Worktree"
            description="Relative to repo root."
            last
          >
            <Input
              className="w-[14rem] h-8 text-xs font-mono"
              value={worktreeLocation}
              onChange={(e) => setWorktreeLocation(e.target.value)}
            />
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* RAG toggle — highlighted card */}
      <SettingsGroup title="Memory & RAG">
        <div className="rounded-lg border border-emerald-500/25 bg-card overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="size-7 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 text-sm">
              ◈
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium">Enable RAG</div>
              <div className="text-[11px] text-muted-foreground/60 mt-0.5">
                Indexes this workspace. The agent can then search it
                semantically.
              </div>
            </div>
            <Switch
              checked={ragEnabled}
              disabled={enableWs.isPending || disableWs.isPending}
              onCheckedChange={(v) => {
                if (v)
                  enableWs.mutate(effectiveId, {
                    onSuccess: () => initWs.mutate(effectiveId),
                  });
                else disableWs.mutate(effectiveId);
              }}
            />
          </div>
        </div>
      </SettingsGroup>

      {/* Scripts */}
      <SettingsGroup title="Scripts">
        <Card>
          {(["setup", "run", "delete"] as const).map((kind, i) => {
            const meta = SCRIPT_META[kind];
            const [val, setVal] =
              kind === "setup"
                ? [setupCmd, setSetupCmd]
                : kind === "run"
                  ? [runCmd, setRunCmd]
                  : [deleteCmd, setDeleteCmd];
            return (
              <div
                key={kind}
                className={cn("px-4 py-3", i < 2 && "border-b border-input")}
              >
                <div
                  className={cn(
                    "flex items-center gap-1.5 text-xs font-medium mb-0.5",
                    meta.tone,
                  )}
                >
                  {meta.icon} {meta.label}
                </div>
                <p className="text-[11px] text-muted-foreground/60 mb-2">
                  {meta.hint}
                </p>
                <Input
                  className="font-mono text-xs h-8"
                  value={val}
                  onChange={(e) => setVal(e.target.value)}
                  placeholder={meta.placeholder}
                />
              </div>
            );
          })}
        </Card>
      </SettingsGroup>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 pt-2 mb-4">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground/60 hover:text-foreground"
          onClick={() => {
            setName(workspace.name);
            setRepository(workspace.repository ?? "");
            setLocation(workspace.path);
            setWorktreeLocation(workspace.worktreeLocation);
            setSetupCmd(initialCmd("setup"));
            setRunCmd(initialCmd("run"));
            setDeleteCmd(initialCmd("delete"));
          }}
        >
          <RefreshCw className="size-3" /> Reset
        </Button>
        <Button
          variant="default"
          size="sm"
          className="text-xs"
          onClick={handleSave}
          disabled={saving}
        >
          <Save className="size-3" /> {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      {/* Danger zone */}
      <SettingsGroup title="Danger zone">
        <Card className="border-destructive/30">
          <div className="px-4 py-3 flex items-center gap-3">
            <AlertTriangle className="size-4 text-destructive flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-destructive">
                Delete this workspace
              </div>
              <div className="text-[11px] text-muted-foreground/60 mt-0.5">
                Removes from Tide. Disk repo untouched.
                {deleteCmd && " Cleanup script runs first."}
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs flex-shrink-0"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3" /> Delete
            </Button>
          </div>
        </Card>
      </SettingsGroup>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg bg-destructive/10 border border-destructive/25 flex items-center justify-center">
                <AlertTriangle className="size-4 text-destructive" />
              </div>
              <div>
                <DialogTitle className="text-base">
                  Delete workspace?
                </DialogTitle>
                <DialogDescription className="text-xs mt-0.5">
                  This cannot be undone.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="text-sm text-muted-foreground py-2">
            You're about to remove{" "}
            <span className="font-medium text-foreground font-mono">
              {workspace.name}
            </span>{" "}
            from Tide.
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(false)}
            >
              <Trash2 className="size-3.5" /> Delete workspace
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =============================================================
// RIGHT COLUMN: RAG config (only when enabled)
// =============================================================

function RagColumn({
  workspaceId,
  status,
}: {
  workspaceId: string;
  status: RagStatus;
}) {
  const updateRag = useUpdateRagConfig(workspaceId);
  const initWs = useInitRagWorkspace(workspaceId);
  const initProgress = useRagInitProgress(workspaceId);
  const initRunning = status.initState === "running";
  const showProgress = !!initProgress && initProgress.phase !== "done";
  const isLocal = status.embedderId === "local-code-512";
  const chunkOptions = isLocal ? [256, 384, 512] : [256];
  const currentChunk = status.chunkTokens ?? 384;

  return (
    <div>
      <div
        className="text-[12px] font-semibold uppercase text-foreground/50"
        style={{ height: 40 }}
      >
        ◈ RAG · {status.chunkCount} chunks
      </div>

      {/* Status */}
      <SettingsGroup title="Status">
        <Card>
          <SettingsRow
            title="Indexed"
            description={`${status.chunkCount} chunks`}
          >
            <Chip tone={status.chunkCount > 0 ? "ok" : "info"}>
              {status.chunkCount > 0 ? `${status.chunkCount} chunks` : "empty"}
            </Chip>
          </SettingsRow>
          {status.lastIngestedAt && (
            <SettingsRow title="Last indexed">
              <span className="text-[11px] text-muted-foreground/70">
                {new Date(status.lastIngestedAt).toLocaleString()}
              </span>
            </SettingsRow>
          )}
          <SettingsRow title="Embedder" last>
            <span className="text-[10px] font-mono text-muted-foreground/70">
              {status.embedderId ?? "—"}
            </span>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* Indexing progress */}
      {showProgress && initProgress && (
        <SettingsGroup
          title={initProgress.phase === "failed" ? "Failed" : "Indexing"}
        >
          <Card>
            <SettingsRow
              title={phaseLabel(initProgress.phase)}
              description={
                initProgress.phase === "walking"
                  ? `${initProgress.filesSeen} files`
                  : initProgress.phase === "chunking"
                    ? `${initProgress.chunksTotal} chunks from ${initProgress.filesSeen} files`
                    : initProgress.phase === "embedding"
                      ? `${initProgress.chunksEmbedded} / ${initProgress.chunksTotal}`
                      : ""
              }
              last={initProgress.phase !== "failed" || !initProgress.error}
            >
              {initProgress.phase === "failed" ? (
                <AlertTriangle className="size-3.5 text-destructive" />
              ) : (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              )}
            </SettingsRow>
            {initProgress.phase === "failed" && initProgress.error && (
              <div className="px-4 pb-3">
                <pre className="text-[10px] leading-relaxed text-destructive/80 whitespace-pre-wrap break-words max-w-full font-mono bg-destructive/5 rounded-md p-2.5">
                  {initProgress.error}
                </pre>
              </div>
            )}
          </Card>
        </SettingsGroup>
      )}

      {/* Cloud fallback */}
      <SettingsGroup title="Cloud Fallback">
        <Card>
          <SettingsRow
            title="Cloud fallback"
            description="Only when local ONNX unavailable."
            last
          >
            <Switch
              checked={status.cloudAllowed ?? false}
              disabled={!workspaceId || updateRag.isPending}
              onCheckedChange={(v) => updateRag.mutate({ cloudAllowed: v })}
            />
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* Chunking */}
      <SettingsGroup title="Chunking">
        <Card>
          <SettingsRow
            title="Strategy"
            description="AST-aware via tree-sitter."
          >
            <Chip tone="info">tree-sitter</Chip>
          </SettingsRow>
          <SettingsRow
            title="Chunk size"
            description={isLocal ? "Up to 512 tokens." : "Locked to 256."}
          >
            <Select
              value={String(currentChunk)}
              disabled={!workspaceId || updateRag.isPending}
              onValueChange={(v) =>
                updateRag.mutate({ chunkTokens: Number(v) })
              }
            >
              <SelectTrigger className="w-[8rem] h-7 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {chunkOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} tokens
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            title="Languages"
            description="28 grammars bundled."
            last
          >
            <span className="text-[9px] font-mono text-muted-foreground/50">
              TS JS PY GO RS JAVA…
            </span>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* Memory stores */}
      <SettingsGroup title="Memory Stores">
        <Card>
          <SettingsRow
            title="Working"
            description="Session state — in-context."
          >
            <span className="text-[9px] text-muted-foreground/50">session</span>
          </SettingsRow>
          <SettingsRow
            title="Semantic"
            description="Codebase knowledge via RAG."
          >
            <span className="text-[9px] text-muted-foreground/50">
              {status.chunkCount > 0 ? `${status.chunkCount} chunks` : "empty"}
            </span>
          </SettingsRow>
          <SettingsRow title="Episodic" description="Past sessions JSONL." last>
            <span className="text-[9px] text-muted-foreground/50">planned</span>
          </SettingsRow>
        </Card>
      </SettingsGroup>

      {/* Index management */}
      <SettingsGroup title="Index">
        <Card>
          <SettingsRow
            title="Re-index"
            description="Re-walk + re-chunk + re-embed."
            last
          >
            <Button
              variant="secondary"
              size="sm"
              className="h-7 text-[11px] gap-1.5"
              disabled={initWs.isPending || initRunning}
              onClick={() => initWs.mutate(workspaceId)}
            >
              <RefreshCw
                className={cn("size-3", initWs.isPending && "animate-spin")}
              />{" "}
              Re-index
            </Button>
          </SettingsRow>
        </Card>
      </SettingsGroup>
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "walking":
      return "Walking files";
    case "chunking":
      return "Chunking source";
    case "embedding":
      return "Embedding chunks";
    case "failed":
      return "Failed";
    default:
      return "Indexing";
  }
}
