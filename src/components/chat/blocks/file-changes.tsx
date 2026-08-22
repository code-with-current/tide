/** Collapsible "files changed" summary appended after a turn's answer.
 *  Each file row has: the path (clickable to open), a Review button (opens
 *  a side-by-side diff), and an Undo button (reverts to pre-turn state).
 *  The list caps at MAX_VISIBLE files with a "Show More.." expander. */

import { memo, useEffect, useState } from 'react';
import { ChevronRight, ChevronUp, FileEdit, FilePlus, Undo2, GitCompareArrows } from 'lucide-react';
import type { FileChangeEntry } from '@/lib/stream/block-state';
import type { DiffHunk } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface FileChangeClickPayload {
  path: string;
  hunks?: DiffHunk[];
}

const MAX_VISIBLE = 5;

function FileChangesImpl({
  changes,
  streaming,
  onViewFile,
  onUndoFile,
}: {
  changes: FileChangeEntry[];
  streaming: boolean;
  onViewFile?: (entry: FileChangeClickPayload) => void;
  onUndoFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(streaming);
  const [expanded, setExpanded] = useState(false);
  const [reverted, setReverted] = useState<Set<string>>(new Set());
  useEffect(() => { if (!streaming) setOpen(false); }, [streaming]);

  const created = changes.filter((c) => c.status === 'created').length;
  const edited = changes.filter((c) => c.status === 'edited').length;
  const totalAdd = changes.reduce((n, c) => n + (c.additions ?? 0), 0);
  const totalDel = changes.reduce((n, c) => n + (c.deletions ?? 0), 0);
  const visibleChanges = changes.filter(c => !reverted.has(c.path));
  const shown = expanded ? visibleChanges : visibleChanges.slice(0, MAX_VISIBLE);
  const hidden = visibleChanges.length - shown.length;

  return (
    <div className="mt-[5px]">
      <div className="rounded-lg border border-input bg-secondary/40 overflow-hidden">
        {/* Header */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors cursor-pointer',
            'hover:bg-secondary/80',
          )}
          aria-expanded={open}
        >
          <ChevronRight className={cn('size-3.5 transition-transform text-muted-foreground', open && 'rotate-90')} />
          <div className="flex items-center gap-1.5">
            {created > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-1.5 py-0.5">
                <FilePlus className="size-3 text-success" />
                <span className="text-[0.75rem] font-mono font-medium text-success/90 tabular-nums">{created}</span>
              </span>
            )}
            {edited > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/12 px-1.5 py-0.5">
                <FileEdit className="size-3 text-warning" />
                <span className="text-[0.75rem] font-mono font-medium text-warning/90 tabular-nums">{edited}</span>
              </span>
            )}
          </div>
          <span className="text-[0.8214rem] font-medium text-foreground/80">
            {visibleChanges.length} {visibleChanges.length === 1 ? 'file' : 'files'} changed
          </span>
          {totalAdd + totalDel > 0 && (
            <span className="ml-auto flex items-center gap-2 text-[0.75rem] font-mono text-muted-foreground tabular-nums">
              <span className="text-success/80">+{totalAdd}</span>
              <span className="text-error/80">−{totalDel}</span>
            </span>
          )}
        </button>

        {/* File list */}
        {open && (
          <div className="border-t border-input/60 px-2 py-1.5 animate-slide-up">
            <div className="space-y-0">
              {shown.map((c) => {
                const Icon = c.status === 'created' ? FilePlus : FileEdit;
                const iconColor = c.status === 'created' ? 'text-success' : 'text-warning';
                return (
                  <div
                    key={c.path}
                    className="group/file flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-secondary/70 transition-colors"
                  >
                    <Icon className={cn('size-3.5 shrink-0', iconColor)} />
                    {/* Path — click to open file */}
                    <button
                      type="button"
                      onClick={() => onViewFile?.({ path: c.path, hunks: c.hunks })}
                      disabled={!onViewFile}
                      title={onViewFile ? `Open: ${c.path}` : c.path}
                      className={cn(
                        'truncate min-w-0 text-left text-[0.8214rem] font-mono',
                        onViewFile
                          ? 'text-foreground/85 hover:text-primary cursor-pointer'
                          : 'text-foreground/70 cursor-default',
                      )}
                    >
                      {c.path}
                    </button>
                    {/* Additions/deletions */}
                    {(c.additions ?? 0) + (c.deletions ?? 0) > 0 && (
                      <span className="shrink-0 flex items-center gap-1 text-[0.7143rem] font-mono text-muted-foreground tabular-nums">
                        {c.additions ? <span className="text-success/80">+{c.additions}</span> : null}
                        {c.deletions ? <span className="text-error/80">−{c.deletions}</span> : null}
                      </span>
                    )}
                    {/* Action buttons */}
                    <div className="ml-auto shrink-0 flex items-center gap-0.5 opacity-0 group-hover/file:opacity-100 transition-opacity">
                      {/* Review — opens a side-by-side diff in the file viewer */}
                      {onViewFile && !streaming && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => onViewFile({ path: c.path, hunks: c.hunks })}
                          className="text-muted-foreground hover:text-primary"
                          title="Review diff"
                        >
                          <GitCompareArrows className="size-3" />
                          Review
                        </Button>
                      )}
                      {/* Undo — reverts this file to its pre-turn state */}
                      {onUndoFile && !streaming && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            onUndoFile(c.path);
                            setReverted(prev => new Set(prev).add(c.path));
                          }}
                          className="text-muted-foreground hover:text-warning"
                          title="Undo — revert to pre-turn state"
                        >
                          <Undo2 className="size-3" />
                          Undo
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {hidden > 0 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setExpanded(true)}
                className="mt-1 ml-1.5 text-[0.7143rem] uppercase tracking-wider gap-1.5"
              >
                Show More.. ({hidden})
              </Button>
            )}
            <Button
              variant="outline"
              size="xs"
              onClick={() => setOpen(false)}
              className="mt-1.5 ml-1.5 mb-0.5 text-[0.7143rem] uppercase tracking-wider gap-1.5"
            >
              <ChevronUp className="size-3" />
              Collapse
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export const FileChanges = memo(FileChangesImpl);
