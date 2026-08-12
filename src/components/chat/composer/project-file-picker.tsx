import { FileText, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ProjectFileItem {
  path: string;
  kind: 'file' | 'dir';
}

/** Project file/folder picker — triggered by typing `@` in the editor. Shows a flat list of project files matching the query; uses the same floating-popover approach as SlashPicker (absolute, above the composer). */
export function ProjectFilePicker({
  items,
  highlightedIndex,
  onPick,
  onHighlight,
}: {
  items: ProjectFileItem[];
  highlightedIndex: number;
  onPick: (path: string) => void;
  onHighlight: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Project files"
      className="rounded-md border border-border bg-popover shadow-lg overflow-hidden"
    >
      <div className="px-3 py-1.5 border-b border-input text-[10px] uppercase tracking-wider text-muted-foreground/60">
        Project files
      </div>
      <div className="max-h-[260px] overflow-y-auto overflow-x-hidden scroll py-1">
        {items.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground/60">
            No files found. Press Esc to keep typing.
          </div>
        )}
        {items.map((f, i) => {
          const Icon = f.kind === 'dir' ? Folder : FileText;
          return (
            <span
              key={f.path}
              role="option"
              aria-selected={i === highlightedIndex}
              onMouseEnter={() => onHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); onPick(f.path); }}
              className={cn(
                'w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors',
                i === highlightedIndex ? 'bg-secondary' : 'hover:bg-secondary',
              )}
            >
              <Icon className={cn('size-3.5 shrink-0', f.kind === 'dir' ? 'text-info' : 'text-muted-foreground/60')} />
              <span className="text-xs font-mono truncate flex-1">{f.path}</span>
            </span>
          );
        })}
      </div>
      <div className="px-3 py-1.5 border-t border-input text-[10px] text-muted-foreground/80 flex items-center gap-2">
        <kbd className="font-mono text-[10px] px-1 py-0 bg-primary text-primary-foreground border border-border rounded">↑↓</kbd>
        Navigate
        <kbd className="font-mono text-[10px] px-1 py-0 bg-primary text-primary-foreground border border-border rounded ml-1">↵</kbd>
        Select
        <kbd className="font-mono text-[10px] px-1 py-0 bg-primary text-primary-foreground border border-border rounded ml-1">esc</kbd>
        Dismiss
      </div>
    </div>
  );
}
