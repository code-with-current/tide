import { useState } from "react";
import {
  Trash2,
  Play,
  Power,
  Save,
  RefreshCw,
  AlertTriangle,
  FolderCode,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  useEnableRagWorkspace,
  useDisableRagWorkspace,
  useInitRagWorkspace,
} from "@/lib/queries";
import * as api from "@/lib/api/client";
import type { Workspace, WorkspaceScript } from "@/types";
import { Card, SettingsGroup, SettingsRow } from "../shared";
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
};

// ── LEFT COLUMN: Workspace properties + RAG toggle + Scripts ──

export function WorkspaceColumn({
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const scripts: WorkspaceScript[] = [];
    if (setupCmd.trim())
      scripts.push({ kind: "setup", command: setupCmd.trim() });
    if (runCmd.trim()) scripts.push({ kind: "run", command: runCmd.trim() });
    try {
      await api.updateWorkspace(workspace.id, {
        name: name.trim() || workspace.name,
        repository: repository.trim() || undefined,
        path: location.trim(),
        worktreeLocation: worktreeLocation.trim(),
        scripts,
      });
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success("Workspace saved");
    } catch (e) {
      toast.error("Save failed", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div
        className="flex flex-row items-center text-[0.9rem] font-semibold uppercase text-foreground/50 gap-2"
        style={{ height: 40 }}
      >
        <div className="p-1.5 rounded-2xl bg-foreground/10 text-foreground"><FolderCode className="size-3.5"/> </div> {workspace.name}
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
              <div className="text-[0.9286rem] font-medium">Enable RAG</div>
              <div className="text-[0.7857rem] text-muted-foreground/60 mt-0.5">
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
          {(["setup", "run"] as const).map((kind, i) => {
            const meta = SCRIPT_META[kind];
            const [val, setVal] =
              kind === "setup"
                ? [setupCmd, setSetupCmd]
                : [runCmd, setRunCmd];
            return (
              <div
                key={kind}
                className={cn("px-4 py-3", i < 1 && "border-b border-input")}
              >
                <div
                  className={cn(
                    "flex items-center gap-1.5 text-xs font-medium mb-0.5",
                    meta.tone,
                  )}
                >
                  {meta.icon} {meta.label}
                </div>
                <p className="text-[0.7857rem] text-muted-foreground/60 mb-2">
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
              <div className="text-[0.7857rem] text-muted-foreground/60 mt-0.5">
                Removes from Tide. Disk repo untouched.
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
