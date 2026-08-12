import {
  RefreshCw,
  Database,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Chip } from "@/components/primitives";
import { RagIndexProgress } from "@/components/rag/rag-index-progress";
import {
  useUpdateRagConfig,
  useInitRagWorkspace,
  useRagInitProgress,
} from "@/lib/queries";
import type { RagStatus } from "@/types";
import { cn } from "@/lib/utils";
import { Card, SettingsGroup, SettingsRow } from "../shared";

export function RagColumn({
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
  const isLocal = status.embedderId === "local-code-512";
  const chunkOptions = isLocal ? [256, 384, 512] : [256];
  const currentChunk = status.chunkTokens ?? 384;

  return (
    <div>
      <div
        className="flex flex-row items-center text-[0.9rem] font-semibold uppercase text-foreground/50 gap-2"
        style={{ height: 40 }}
      >
        <div className="p-1.5 rounded-2xl bg-foreground/10 text-foreground"><Database className="size-3.5"/> </div> RAG · {status.chunkCount} chunks
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

      {/* Indexing progress — prominent card (self-gates when idle/done). */}
      <RagIndexProgress event={initProgress} />

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
