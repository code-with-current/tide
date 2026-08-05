import type { DiffHunk } from '@/types';
import { cn } from '@/lib/utils';

/** Renders unified diff hunks with old + new line numbers and colored add/remove backgrounds. Used by ToolCallCard + Source Control DiffDialog. */
export function DiffView({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="font-mono text-[12px] leading-[1.7]">
      {hunks.map((hunk, i) => (
        <div key={i}>
          {/* Hunk header */}
          <div className="px-3 py-1 bg-info/[0.06] text-info/70 text-[11px] border-y border-info/10 select-none">
            {hunk.header}
          </div>
          {/* Lines */}
          {hunk.lines.map((line, j) => {
            const isAdd = line.type === 'add';
            const isDel = line.type === 'del';
            const isContext = line.type === 'context';
            return (
              <div
                key={j}
                className={cn(
                  'flex items-start px-0 transition-colors',
                  isAdd && 'bg-success/[0.08]',
                  isDel && 'bg-destructive/[0.08]',
                )}
              >
                {/* Old line number */}
                <span
                  className={cn(
                    'select-none w-[32px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]',
                    isDel ? 'text-destructive/50' : 'text-muted-foreground/60/40',
                  )}
                >
                  {line.oldNo ?? ''}
                </span>
                {/* New line number */}
                <span
                  className={cn(
                    'select-none w-[32px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]',
                    isAdd ? 'text-success/50' : 'text-muted-foreground/60/40',
                  )}
                >
                  {line.newNo ?? ''}
                </span>
                {/* Sign + content */}
                <span
                  className={cn(
                    'select-none w-[16px] flex-shrink-0 text-center pt-[1px]',
                    isAdd && 'text-success/60',
                    isDel && 'text-destructive/60',
                    isContext && 'text-transparent',
                  )}
                >
                  {isAdd ? '+' : isDel ? '−' : ' '}
                </span>
                <span
                  className={cn(
                    'flex-1 whitespace-pre-wrap break-all pr-3',
                    isAdd && 'text-success',
                    isDel && 'text-destructive',
                    isContext && 'text-muted-foreground',
                  )}
                >
                  {line.text.replace(/^[+\-\s]/, '')}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
