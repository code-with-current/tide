import type { DiffHunk, DiffLine } from '@/types';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';

/** Strip the leading +,-,or space from a diff line's text. */
function stripSign(text: string): string {
  return text.replace(/^[+\s-]/, '');
}

/** A run of tokens sharing the same changed flag — rendered as one span. */
interface WordSegment {
  text: string;
  changed: boolean;
}

/** Split a line into word / non-word runs for intraline diffing. */
function tokenize(text: string): string[] {
  return text.split(/(\w+)/).filter((t) => t.length > 0);
}

/**
 * Word-level diff of a paired del/add row via token LCS. Returns null when
 * either side is empty or the lines are too long to diff cheaply (the row
 * then falls back to whole-line coloring).
 */
function wordDiff(oldText: string, newText: string): { left: WordSegment[]; right: WordSegment[] } | null {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length === 0 || b.length === 0) return null;
  if (a.length * b.length > 250_000) return null;

  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] vs b[j..], flattened into one array.
  const stride = m + 1;
  const dp = new Uint32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * stride + j] =
        a[i] === b[j]
          ? dp[(i + 1) * stride + (j + 1)] + 1
          : Math.max(dp[(i + 1) * stride + j], dp[i * stride + (j + 1)]);
    }
  }

  const leftCommon = new Array<boolean>(n).fill(false);
  const rightCommon = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      leftCommon[i] = true;
      rightCommon[j] = true;
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }

  return { left: toSegments(a, leftCommon), right: toSegments(b, rightCommon) };
}

/** Merge adjacent tokens with the same flag so each run renders as one span. */
function toSegments(tokens: string[], common: boolean[]): WordSegment[] {
  const segs: WordSegment[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const changed = !common[k];
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += tokens[k];
    else segs.push({ text: tokens[k], changed });
  }
  return segs;
}

function Segments({ segs, tone }: { segs: WordSegment[]; tone: 'del' | 'add' }) {
  return (
    <>
      {segs.map((s, k) =>
        s.changed ? (
          <span key={k} className={cn('rounded-[2px]', tone === 'del' ? 'bg-destructive/25' : 'bg-success/25')}>
            {s.text}
          </span>
        ) : (
          <span key={k}>{s.text}</span>
        ),
      )}
    </>
  );
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

/** Side-by-side diff view — old on the left, new on the right. Paired
 *  del/add rows get word-level highlights so a small edit reads instantly. */
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
              const segs =
                leftDel && rightAdd && row.left && row.right
                  ? wordDiff(stripSign(row.left.text), stripSign(row.right.text))
                  : null;
              return (
                <div key={j} className="flex items-start">
                  {/* Left (old) */}
                  <div className={cn('flex-1 flex items-start min-w-0 border-r border-border/50', leftDel && 'bg-destructive/[0.08]')}>
                    <span className={cn('select-none w-[36px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]', leftDel ? 'text-destructive/50' : 'text-muted-foreground/40')}>{row.left?.oldNo ?? ''}</span>
                    <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3 pl-1', leftDel ? 'text-destructive' : 'text-muted-foreground')}>
                      {row.left ? (segs ? <Segments segs={segs.left} tone="del" /> : stripSign(row.left.text)) : ''}
                    </span>
                  </div>
                  {/* Right (new) */}
                  <div className={cn('flex-1 flex items-start min-w-0', rightAdd && 'bg-success/[0.08]')}>
                    <span className={cn('select-none w-[36px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]', rightAdd ? 'text-success/50' : 'text-muted-foreground/40')}>{row.right?.newNo ?? ''}</span>
                    <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3 pl-1', rightAdd ? 'text-success' : 'text-muted-foreground')}>
                      {row.right ? (segs ? <Segments segs={segs.right} tone="add" /> : stripSign(row.right.text)) : ''}
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

/** Unified/Split segmented toggle. Writes the global preference so every
 *  DiffView instance (chat, file viewer, commit details, review) follows.
 *  Exported for surfaces that render Pierre diffs but still need the toggle. */
export function DiffModeTabs({ mode, onChange }: { mode: 'unified' | 'split'; onChange: (m: 'unified' | 'split') => void }) {
  const tabs: { id: 'unified' | 'split'; label: string }[] = [
    { id: 'unified', label: 'Unified' },
    { id: 'split', label: 'Split' },
  ];
  return (
    <div className="flex justify-end px-2 py-1 border-b border-border/50">
      <div className="flex items-center rounded-md border border-border/60 overflow-hidden text-[10px] leading-none select-none">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={cn(
              'px-2 py-1 transition-colors',
              mode === t.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Renders diff hunks. Mode defaults to the persisted `diffMode` preference;
 *  the `mode` prop remains as an explicit per-instance override. */
export function DiffView({ hunks, mode }: { hunks: DiffHunk[]; mode?: 'unified' | 'split' }) {
  const diffMode = useUi((s) => s.diffMode);
  const setDiffMode = useUi((s) => s.setDiffMode);
  const resolved = mode ?? diffMode;
  return (
    <div className="min-w-0">
      {hunks.length > 0 && <DiffModeTabs mode={resolved} onChange={setDiffMode} />}
      {resolved === 'split' ? <SplitDiff hunks={hunks} /> : <UnifiedDiff hunks={hunks} />}
    </div>
  );
}
