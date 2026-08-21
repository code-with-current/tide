import { useMemo } from 'react';
import type { DiffHunk, DiffLine } from '@/types';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import { hunkHasCollapsedContextBefore, hunkOldEnd, hunkOldStart, nextExpandWidth } from '@/lib/diff/expand-context';

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

// ── Expandable context separators ───────────────────────────────────────

/** Separator over a collapsed-context gap: plain-text glyph buttons +
 *  lowercase 'expand all', hover underline. All affordances refetch the
 *  whole diff at the next ladder width (per-gap expansion isn't offered by
 *  the gitDiff IPC); when the ladder is exhausted only the count remains. */
function ExpandSeparator({
  dir, hiddenLines, contextLines, onExpand,
}: {
  dir: 'down' | 'both';
  hiddenLines: number;
  contextLines: number;
  onExpand: (n: number) => void;
}) {
  const next = nextExpandWidth(contextLines);
  const glyph = 'px-1.5 text-muted-foreground/60 hover:text-foreground hover:underline';
  return (
    <div className="flex items-center justify-center gap-2 py-0.5 px-3 bg-info/[0.03] border-y border-info/10 text-[11px] text-muted-foreground/60 select-none">
      {next > contextLines && (
        <>
          {dir === 'down' ? (
            <button type="button" title="expand down" className={glyph} onClick={() => onExpand(next)}>↓</button>
          ) : (
            <>
              <button type="button" title="expand up" className={glyph} onClick={() => onExpand(next)}>↑</button>
              <button type="button" title="expand down" className={glyph} onClick={() => onExpand(next)}>↓</button>
              <button type="button" title="expand around" className={glyph} onClick={() => onExpand(next)}>↕</button>
            </>
          )}
          <button type="button" className="hover:underline" onClick={() => onExpand(next)}>expand all</button>
        </>
      )}
      <span>{hiddenLines} unchanged lines</span>
    </div>
  );
}

// ── Row models ──────────────────────────────────────────────────────────

interface GapRow { kind: 'gap'; dir: 'down' | 'both'; hidden: number }
interface HeaderRow { kind: 'header'; text: string }
type UnifiedRow = GapRow | HeaderRow | { kind: 'line'; line: DiffLine };
type SplitRow = GapRow | HeaderRow | { kind: 'pair'; left?: DiffLine; right?: DiffLine };

/** Gap rows only exist when the parent can actually refetch on expand. */
function gapRow(hunk: DiffHunk, index: number, prevOldEnd: number | undefined): GapRow | null {
  if (!hunkHasCollapsedContextBefore(hunk, prevOldEnd)) return null;
  return {
    kind: 'gap',
    dir: index === 0 ? 'down' : 'both',
    hidden: hunkOldStart(hunk) - (prevOldEnd ?? 0) - 1,
  };
}

function buildUnifiedModel(hunks: DiffHunk[], expandable: boolean): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  let prevOldEnd: number | undefined;
  hunks.forEach((hunk, i) => {
    const gap = gapRow(hunk, i, prevOldEnd);
    if (expandable && gap) rows.push(gap);
    rows.push({ kind: 'header', text: hunk.header });
    for (const line of hunk.lines) rows.push({ kind: 'line', line });
    prevOldEnd = hunkOldEnd(hunk);
  });
  return rows;
}

/** Pair old/new lines: del goes left, add goes right, context goes both. */
function buildSplitPairs(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine }[] {
  const rows: { left?: DiffLine; right?: DiffLine }[] = [];
  let leftPending: DiffLine[] = [];
  let rightPending: DiffLine[] = [];
  for (const line of lines) {
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
  return rows;
}

function buildSplitModel(hunks: DiffHunk[], expandable: boolean): SplitRow[] {
  const rows: SplitRow[] = [];
  let prevOldEnd: number | undefined;
  hunks.forEach((hunk, i) => {
    const gap = gapRow(hunk, i, prevOldEnd);
    if (expandable && gap) rows.push(gap);
    rows.push({ kind: 'header', text: hunk.header });
    for (const pair of buildSplitPairs(hunk.lines)) rows.push({ kind: 'pair', ...pair });
    prevOldEnd = hunkOldEnd(hunk);
  });
  return rows;
}

// ── Diff bodies ─────────────────────────────────────────────────────────

interface DiffBodyProps {
  hunks: DiffHunk[];
  contextLines: number;
  onExpandContext?: (n: number) => void;
}

/** Unified diff view — old + new line numbers in one column. */
function UnifiedDiff({ hunks, contextLines, onExpandContext }: DiffBodyProps) {
  const rows = useMemo(
    () => buildUnifiedModel(hunks, onExpandContext != null),
    [hunks, onExpandContext],
  );

  return (
    <div className="font-mono text-[12px] leading-[1.7]">
      {rows.map((row, j) => {
        if (row.kind === 'gap') {
          return <ExpandSeparator key={j} dir={row.dir} hiddenLines={row.hidden} contextLines={contextLines} onExpand={onExpandContext!} />;
        }
        if (row.kind === 'header') {
          return <div key={j} className="px-3 py-1 bg-info/[0.06] text-info/70 text-[11px] border-y border-info/10 select-none">{row.text}</div>;
        }
        const line = row.line;
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
  );
}

/** Side-by-side diff view — old on the left, new on the right. Paired
 *  del/add rows get word-level highlights so a small edit reads instantly. */
function SplitDiff({ hunks, contextLines, onExpandContext }: DiffBodyProps) {
  const rows = useMemo(
    () => buildSplitModel(hunks, onExpandContext != null),
    [hunks, onExpandContext],
  );

  return (
    <div className="font-mono text-[12px] leading-[1.7]">
      {rows.map((row, j) => {
        if (row.kind === 'gap') {
          return <ExpandSeparator key={j} dir={row.dir} hiddenLines={row.hidden} contextLines={contextLines} onExpand={onExpandContext!} />;
        }
        if (row.kind === 'header') {
          return <div key={j} className="px-3 py-1 bg-info/[0.06] text-info/70 text-[11px] border-y border-info/10 select-none">{row.text}</div>;
        }
        const { left, right } = row;
        const leftDel = left?.type === 'del';
        const rightAdd = right?.type === 'add';
        const segs =
          leftDel && rightAdd && left && right
            ? wordDiff(stripSign(left.text), stripSign(right.text))
            : null;
        return (
          <div key={j} className="flex items-start">
            {/* Left (old) */}
            <div className={cn('flex-1 flex items-start min-w-0 border-r border-border/50', leftDel && 'bg-destructive/[0.08]')}>
              <span className={cn('select-none w-[36px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]', leftDel ? 'text-destructive/50' : 'text-muted-foreground/40')}>{left?.oldNo ?? ''}</span>
              <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3 pl-1', leftDel ? 'text-destructive' : 'text-muted-foreground')}>
                {left ? (segs ? <Segments segs={segs.left} tone="del" /> : stripSign(left.text)) : ''}
              </span>
            </div>
            {/* Right (new) */}
            <div className={cn('flex-1 flex items-start min-w-0', rightAdd && 'bg-success/[0.08]')}>
              <span className={cn('select-none w-[36px] flex-shrink-0 text-right pr-2 tabular-nums text-[10px] pt-[1px]', rightAdd ? 'text-success/50' : 'text-muted-foreground/40')}>{right?.newNo ?? ''}</span>
              <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3 pl-1', rightAdd ? 'text-success' : 'text-muted-foreground')}>
                {right ? (segs ? <Segments segs={segs.right} tone="add" /> : stripSign(right.text)) : ''}
              </span>
            </div>
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

export interface DiffViewProps {
  hunks: DiffHunk[];
  mode?: 'unified' | 'split';
  /** Context width the hunks were fetched with — seeds the expand ladder. */
  contextLines?: number;
  /** Refetch on expand. Absent (chat tool blocks, commit diffs) hides the
   *  separator affordances entirely — the component stays pure. */
  onExpandContext?: (contextLines: number) => void;
}

/** Renders diff hunks. Mode defaults to the persisted `diffMode` preference;
 *  the `mode` prop remains as an explicit per-instance override. */
export function DiffView({ hunks, mode, contextLines = 3, onExpandContext }: DiffViewProps) {
  const diffMode = useUi((s) => s.diffMode);
  const setDiffMode = useUi((s) => s.setDiffMode);
  const resolved = mode ?? diffMode;
  return (
    <div className="min-w-0">
      {hunks.length > 0 && <DiffModeTabs mode={resolved} onChange={setDiffMode} />}
      {resolved === 'split' ? (
        <SplitDiff hunks={hunks} contextLines={contextLines} onExpandContext={onExpandContext} />
      ) : (
        <UnifiedDiff hunks={hunks} contextLines={contextLines} onExpandContext={onExpandContext} />
      )}
    </div>
  );
}
