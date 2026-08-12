import type { DiffHunk, DiffLine } from '@/types';
import { cn } from '@/lib/utils';

/** Strip the leading +,-,or space from a diff line's text. */
function stripSign(text: string): string {
  return text.replace(/^[+\-\s]/, '');
}

/** Unified diff view — old + new line numbers in one column. */
function UnifiedDiff({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="font-mono text-[12px] leading-[1.7]">
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div className="px-3 py-1 bg-info/[0.06] text-info/70 text-[11px] border-y border-info/10 select-none">
            {hunk.header}
          </div>
          {hunk.lines.map((line, j) => {
            const isAdd = line.type === 'add';
            const isDel = line.type === 'del';
            const isContext = line.type === 'context';
            return (
              <div key={j} className={cn('flex items-start px-0', isAdd && 'bg-success/[0.08]', isDel && 'bg-destructive/[0.08]')}>
                <span className={cn('select-none w-[32px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]', isDel ? 'text-destructive/50' : 'text-muted-foreground/40')}>{line.oldNo ?? ''}</span>
                <span className={cn('select-none w-[32px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]', isAdd ? 'text-success/50' : 'text-muted-foreground/40')}>{line.newNo ?? ''}</span>
                <span className={cn('select-none w-[16px] flex-shrink-0 text-center pt-[1px]', isAdd && 'text-success/60', isDel && 'text-destructive/60', isContext && 'text-transparent')}>{isAdd ? '+' : isDel ? '−' : ' '}</span>
                <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3', isAdd && 'text-success', isDel && 'text-destructive', isContext && 'text-muted-foreground')}>{stripSign(line.text)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Side-by-side diff view — old on the left, new on the right. */
function SplitDiff({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="font-mono text-[12px] leading-[1.7]">
      {hunks.map((hunk, i) => {
        // Pair old/new lines: del lines go left, add lines go right, context goes both.
        const rows: { left?: DiffLine; right?: DiffLine }[] = [];
        let leftPending: DiffLine[] = [];
        let rightPending: DiffLine[] = [];
        for (const line of hunk.lines) {
          if (line.type === 'context') {
            // Flush pending dels/adds as unpaired rows first.
            for (const l of leftPending) rows.push({ left: l });
            for (const r of rightPending) rows.push({ right: r });
            leftPending = []; rightPending = [];
            rows.push({ left: line, right: line });
          } else if (line.type === 'del') {
            leftPending.push(line);
          } else if (line.type === 'add') {
            rightPending.push(line);
          }
        }
        // Flush remaining.
        const maxPending = Math.max(leftPending.length, rightPending.length);
        for (let k = 0; k < maxPending; k++) {
          rows.push({ left: leftPending[k], right: rightPending[k] });
        }

        return (
          <div key={i}>
            <div className="px-3 py-1 bg-info/[0.06] text-info/70 text-[11px] border-y border-info/10 select-none">{hunk.header}</div>
            {rows.map((row, j) => {
              const leftDel = row.left?.type === 'del';
              const rightAdd = row.right?.type === 'add';
              return (
                <div key={j} className="flex items-start">
                  {/* Left (old) */}
                  <div className={cn('flex-1 flex items-start min-w-0 border-r border-border/50', leftDel && 'bg-destructive/[0.08]')}>
                    <span className={cn('select-none w-[36px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]', leftDel ? 'text-destructive/50' : 'text-muted-foreground/40')}>{row.left?.oldNo ?? ''}</span>
                    <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3 pl-1', leftDel ? 'text-destructive' : 'text-muted-foreground')}>
                      {row.left ? stripSign(row.left.text) : ''}
                    </span>
                  </div>
                  {/* Right (new) */}
                  <div className={cn('flex-1 flex items-start min-w-0', rightAdd && 'bg-success/[0.08]')}>
                    <span className={cn('select-none w-[36px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]', rightAdd ? 'text-success/50' : 'text-muted-foreground/40')}>{row.right?.newNo ?? ''}</span>
                    <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3 pl-1', rightAdd ? 'text-success' : 'text-muted-foreground')}>
                      {row.right ? stripSign(row.right.text) : ''}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Renders diff hunks. `mode='split'` shows side-by-side; default is unified. */
export function DiffView({ hunks, mode = 'unified' }: { hunks: DiffHunk[]; mode?: 'unified' | 'split' }) {
  if (mode === 'split') return <SplitDiff hunks={hunks} />;
  return <UnifiedDiff hunks={hunks} />;
}
