import { useMemo, useState } from 'react';
import { LibraryBig, Plus, Loader2, Pencil, Trash2, RotateCw } from 'lucide-react';
import { SettingsHeader, Card } from '../shared';
import { SourceDialog } from './source-dialog';
import { WorkspaceScopeSelect, type WorkspaceOption } from './scope-select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tip } from '@/components/ui/quick-tooltip';
import { ConfirmPopover } from '@/components/ui/confirm-popover';
import { toast } from '@/lib/toast';
import { formatRelative } from '@/lib/utils';
import {
  useSources,
  useSourcesProgress,
  useAddSource,
  useUpdateSource,
  useRemoveSource,
  useReindexSource,
  useWorkspaces,
} from '@/lib/queries';
import type { KnowledgeSource, SourceKind, SourceProgressEvent } from '@/types';

/** Settings → AI → Knowledge: registers URL/docs/crawl/repo sources that feed
 *  the agent's memory tool. Live ingestion status comes from
 *  tide:sources:progress pushes (useSourcesProgress) keyed on sourceId. */

const KIND_LABELS: Record<SourceKind, string> = {
  url: 'Page',
  docs: 'Docs',
  crawl: 'Crawl',
  repo: 'Repo',
};

interface StatusView {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  /** Live phase detail shown next to the badge while indexing. */
  detail?: string;
  title?: string;
}

const LIVE_PHASES = new Set(['fetching', 'chunking', 'embedding']);

function statusFor(src: KnowledgeSource, progress: SourceProgressEvent | null): StatusView {
  if (progress && progress.sourceId === src.id && LIVE_PHASES.has(progress.phase)) {
    const detail =
      progress.phase === 'embedding' && progress.chunksTotal
        ? `${progress.chunksEmbedded ?? 0}/${progress.chunksTotal} chunks`
        : progress.current;
    return { label: 'Indexing', variant: 'default', detail };
  }
  switch (src.status) {
    case 'queued':
      return { label: 'Queued', variant: 'secondary' };
    case 'indexing':
      return { label: 'Indexing', variant: 'default' };
    case 'error':
      return { label: 'Error', variant: 'destructive', title: src.error ?? undefined };
    default:
      return { label: 'Idle', variant: 'outline' };
  }
}

export function SourcesSection() {
  const sourcesQuery = useSources();
  const progress = useSourcesProgress();
  const sources = useMemo(() => sourcesQuery.data?.sources ?? [], [sourcesQuery.data]);
  const workspacesQuery = useWorkspaces();
  const workspaces: WorkspaceOption[] = useMemo(
    () => (workspacesQuery.data ?? []).map((w) => ({ id: w.id, name: w.name })),
    [workspacesQuery.data],
  );

  const addSource = useAddSource();
  const updateSource = useUpdateSource();
  const removeSource = useRemoveSource();
  const reindex = useReindexSource();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeSource | null>(null);

  const handleAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const handleEdit = (src: KnowledgeSource) => {
    setEditing(src);
    setDialogOpen(true);
  };

  const handleSave = (input: {
    name: string;
    kind: SourceKind;
    location: string;
    enabledWorkspaceIds: string[];
  }) => {
    if (editing) {
      // Only send location when it actually changed — the main process
      // re-enqueues a full re-index whenever a location patch arrives.
      const patch: {
        name?: string;
        location?: string;
        enabledWorkspaceIds?: string[];
      } = { name: input.name };
      if (input.location !== editing.location) patch.location = input.location;
      if (!sameScope(input.enabledWorkspaceIds, editing.enabledWorkspaceIds)) {
        patch.enabledWorkspaceIds = input.enabledWorkspaceIds;
      }
      updateSource.mutate(
        { id: editing.id, patch },
        {
          onSuccess: (res) => {
            if (res.ok) {
              toast.success('Source updated');
              setDialogOpen(false);
              setEditing(null);
            } else {
              toast.error('Update failed', { description: res.error });
            }
          },
        },
      );
    } else {
      addSource.mutate(input, {
        onSuccess: (res) => {
          if (res.ok) {
            toast.success('Source added — indexing');
            setDialogOpen(false);
          } else {
            toast.error('Add failed', { description: res.error });
          }
        },
      });
    }
  };

  const handleRemove = (src: KnowledgeSource) => {
    removeSource.mutate(src.id, {
      onSuccess: (res) => {
        if (res.ok) {
          toast.success(`Removed ${src.name}`);
        } else {
          toast.error('Remove failed', { description: res.error });
        }
      },
    });
  };

  const handleReindex = (src: KnowledgeSource) => {
    reindex.mutate(src.id, {
      onSuccess: (res) => {
        if (!res.ok) {
          toast.error('Reindex failed', { description: res.error });
        }
      },
    });
  };

  const handleScopeChange = (src: KnowledgeSource, enabledWorkspaceIds: string[]) => {
    updateSource.mutate(
      { id: src.id, patch: { enabledWorkspaceIds } },
      {
        onSuccess: (res) => {
          if (!res.ok) {
            toast.error('Could not change availability', { description: res.error });
          }
        },
      },
    );
  };

  const busy = addSource.isPending || updateSource.isPending;

  return (
    <>
      <SettingsHeader
        title="Knowledge"
        description="Register docs, web pages, and repos that the agent searches via its memory tool."
        action={
          <Button size="sm" onClick={handleAdd} className="gap-1.5">
            <Plus className="size-3.5" />
            Add Source
          </Button>
        }
      />

      {sourcesQuery.isPending ? null : sources.length > 0 ? (
        <Card>
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60">
            <span className="shrink-0 text-muted-foreground/50">
              <LibraryBig className="size-3.5" />
            </span>
            <h3 className="text-[0.7857rem] uppercase tracking-wide text-muted-foreground/60 font-medium flex-1">
              Sources
            </h3>
            <span className="text-[0.7143rem] text-muted-foreground/50 font-mono tabular-nums">
              {sources.length}
            </span>
          </div>
          <div className="divide-y divide-border/30">
            {sources.map((src) => (
              <SourceRow
                key={src.id}
                source={src}
                progress={progress}
                workspaces={workspaces}
                reindexing={reindex.isPending && reindex.variables === src.id}
                onScopeChange={(ids) => handleScopeChange(src, ids)}
                onEdit={() => handleEdit(src)}
                onRemove={() => handleRemove(src)}
                onReindex={() => handleReindex(src)}
              />
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState onAdd={handleAdd} />
      )}

      <SourceDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSave={handleSave}
        initial={editing}
        busy={busy}
      />
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Row + empty state
// ──────────────────────────────────────────────────────────────────────────

function SourceRow({
  source,
  progress,
  workspaces,
  reindexing,
  onScopeChange,
  onEdit,
  onRemove,
  onReindex,
}: {
  source: KnowledgeSource;
  progress: SourceProgressEvent | null;
  workspaces: WorkspaceOption[];
  reindexing: boolean;
  onScopeChange: (enabledWorkspaceIds: string[]) => void;
  onEdit: () => void;
  onRemove: () => void;
  onReindex: () => void;
}) {
  const status = statusFor(source, progress);
  const isLive = status.detail !== undefined || source.status === 'queued' || source.status === 'indexing';

  return (
    <div className="group flex items-center gap-3 px-4 py-2.5">
      <Badge variant="outline" className="shrink-0 text-[0.7143rem] font-mono uppercase">
        {KIND_LABELS[source.kind]}
      </Badge>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[0.9286rem] font-medium truncate">{source.name}</span>
          <StatusBadge status={status} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <code className="text-[0.7143rem] text-muted-foreground/50 font-mono truncate max-w-[60%]">
            {source.location}
          </code>
          <span className="text-[0.7143rem] text-muted-foreground/40 font-mono tabular-nums shrink-0">
            {source.chunkCount} chunks
            {source.lastIndexedAt != null && ` · ${formatRelative(new Date(source.lastIndexedAt).toISOString())}`}
          </span>
          {status.title && (
            <Tip label={status.title} side="top">
              <span className="text-[0.7143rem] text-destructive shrink-0">details</span>
            </Tip>
          )}
        </div>
      </div>

      {/* Hover-revealed actions */}
      <div className="hidden group-hover:flex items-center gap-1 shrink-0">
        <Tip label="Reindex" side="top">
          <button
            type="button"
            onClick={onReindex}
            disabled={isLive || reindexing}
            className="p-1 rounded hover:bg-muted transition-colors disabled:opacity-30"
          >
            {reindexing ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
          </button>
        </Tip>
        <Tip label="Edit" side="top">
          <button
            type="button"
            onClick={onEdit}
            className="p-1 rounded hover:bg-muted transition-colors"
          >
            <Pencil className="size-3" />
          </button>
        </Tip>
        <ConfirmPopover
          trigger={
            <button
              type="button"
              title="Remove"
              className="p-1 rounded hover:bg-muted transition-colors text-destructive"
            >
              <Trash2 className="size-3" />
            </button>
          }
          title={`Remove ${source.name}?`}
          description="This deletes the source and its indexed chunks."
          confirmLabel="Remove"
          destructive
          onConfirm={onRemove}
        />
      </div>

      <div className="flex items-center gap-1.5 shrink-0 group-hover:hidden">
        {status.detail && (
          <span className="text-[0.7143rem] text-muted-foreground/50 font-mono truncate max-w-[12rem]">
            {status.detail}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {isLive && (
          <Loader2 className="size-3 animate-spin text-muted-foreground/60" />
        )}
        <WorkspaceScopeSelect
          value={source.enabledWorkspaceIds}
          workspaces={workspaces}
          onChange={onScopeChange}
        />
      </div>
    </div>
  );
}

// Order-insensitive comparison so saving the dialog without touching scope
// doesn't ship a redundant patch.
function sameScope(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
}

function StatusBadge({ status }: { status: StatusView }) {
  return (
    <Badge variant={status.variant} className="shrink-0 text-[0.7143rem] px-1.5 py-0">
      {status.label}
    </Badge>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="size-12 rounded-xl bg-muted/50 flex items-center justify-center mb-4">
        <LibraryBig className="size-6 text-muted-foreground/50" />
      </div>
      <h3 className="text-base font-medium mb-1">No knowledge sources yet</h3>
      <p className="text-sm text-muted-foreground/70 max-w-sm">
        Add a documentation site, a local docs folder, or a repo. The agent cites
        these when answering questions through its memory tool.
      </p>
      <div className="mt-6">
        <Button size="sm" onClick={onAdd} className="gap-1.5">
          <Plus className="size-3.5" />
          Add Source
        </Button>
      </div>
    </div>
  );
}
