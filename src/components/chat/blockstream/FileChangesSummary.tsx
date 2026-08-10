/** Collapsible "files changed" summary appended after a turn's answer.
 *  Edits + creates only — deletions aren't detectable (no delete tool). */

import { memo, useEffect, useState } from 'react';
import { ChevronRight, ChevronUp, FileEdit, FilePlus } from 'lucide-react';
import type { FileChangeEntry } from '@/lib/stream/blockState';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

function FileChangesSummaryImpl({
  changes,
  streaming,
  onViewFile,
}: {
  changes: FileChangeEntry[];
  streaming: boolean;
  onViewFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  const created = changes.filter((c) => c.status === 'created').length;
  const edited = changes.filter((c) => c.status === 'edited').length;
  const totalAdd = changes.reduce((n, c) => n + (c.additions ?? 0), 0);
  const totalDel = changes.reduce((n, c) => n + (c.deletions ?? 0), 0);

  return (
    <div className="mt-2">
      <div className="rounded-lg border border-input bg-secondary/40 overflow-hidden">
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
                <span className="text-[10.5px] font-mono font-medium text-success/90 tabular-nums">{created}</span>
              </span>
            )}
            {edited > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/12 px-1.5 py-0.5">
                <FileEdit className="size-3 text-warning" />
                <span className="text-[10.5px] font-mono font-medium text-warning/90 tabular-nums">{edited}</span>
              </span>
            )}
          </div>
          <span className="text-[11.5px] font-medium text-foreground/80">
            {changes.length} {changes.length === 1 ? 'file' : 'files'} changed
          </span>
          {totalAdd + totalDel > 0 && (
            <span className="ml-auto flex items-center gap-2 text-[10.5px] font-mono text-muted-foreground tabular-nums">
              <span className="text-success/80">+{totalAdd}</span>
              <span className="text-error/80">−{totalDel}</span>
            </span>
          )}
        </button>

        {open && (
          <div className="border-t border-input/60 px-2 py-1.5 animate-slide-up">
            <div className="space-y-0">
              {changes.map((c) => {
                const Icon = c.status === 'created' ? FilePlus : FileEdit;
                const iconColor = c.status === 'created' ? 'text-success' : 'text-warning';
                return (
                  <div
                    key={c.path}
                    className="group/file flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-secondary/70 transition-colors"
                  >
                    <Icon className={cn('size-3.5 shrink-0', iconColor)} />
                    <button
                      type="button"
                      onClick={() => onViewFile?.(c.path)}
                      disabled={!onViewFile}
                      title={onViewFile ? `Open ${c.path}` : c.path}
                      className={cn(
                        'truncate min-w-0 text-left text-[11.5px] font-mono',
                        onViewFile
                          ? 'text-foreground/85 hover:text-primary cursor-pointer'
                          : 'text-foreground/70 cursor-default',
                      )}
                    >
                      {c.path}
                    </button>
                    {(c.additions ?? 0) + (c.deletions ?? 0) > 0 && (
                      <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground tabular-nums">
                        {c.additions ? <span className="text-success/80">+{c.additions}</span> : null}
                        {c.deletions ? <span className="text-error/80">−{c.deletions}</span> : null}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setOpen(false)}
              className="mt-1.5 ml-1.5 mb-0.5 text-[10px] uppercase tracking-wider gap-1.5"
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

export const FileChangesSummary = memo(FileChangesSummaryImpl);
