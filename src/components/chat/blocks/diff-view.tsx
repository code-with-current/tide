import { memo, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DiffHunk, DiffLine } from '@/types';
import { cn } from '@/lib/utils';
import { useUi } from '@/lib/stores/ui';
import { hunkHasCollapsedContextBefore, hunkOldEnd, hunkOldStart, nextExpandWidth } from '@/lib/diff/expand-context';
import { MAX_HIGHLIGHT_LINE_CHARS, highlightLine, shouldHighlight } from '@/lib/diff/highlight';

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

// ── Syntax-highlighted code (preview ladder) ────────────────────────────

/** Highlighted line content. Transparent <code> so the row's add/del tint
 *  shows through; falls back to plain text past the per-line ladder rung. */
const CodeSpan = memo(function CodeSpan({ text, language }: { text: string; language: string }) {
  if (text.length > MAX_HIGHLIGHT_LINE_CHARS) return <>{text}</>;
  const spans = highlightLine(text, language);
  return (
    <code className="bg-transparent">
      {spans.map((s, k) =>
        s.cls ? <span key={k} className={s.cls}>{s.text}</span> : <span key={k}>{s.text}</span>,
      )}
    </code>
  );
});

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
    <div className="flex items-center justify-center gap-2 py-0.5 px-3 bg-info/[0.03] border-y border-info/10 text-[0.7857rem] text-muted-foreground/60 select-none">
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

// ── Row models (shared by flat + virtualized rendering) ────────────────

interface GapRow { kind: 'gap'; dir: 'down' | 'both'; hidden: number }
interface HeaderRow { kind: 'header'; text: string }
type UnifiedRow = GapRow | HeaderRow | { kind: 'line'; line: DiffLine };
type SplitRow = GapRow | HeaderRow | { kind: 'pair'; left?: DiffLine; right?: DiffLine };

interface RowModel<R> {
  rows: R[];
  /** Content rows (lines / pairs) — drives the virtualization threshold. */
  bodyCount: number;
}

/** Gap rows only exist when the parent can actually refetch on expand. */
function gapRow(hunk: DiffHunk, index: number, prevOldEnd: number | undefined): GapRow | null {
  if (!hunkHasCollapsedContextBefore(hunk, prevOldEnd)) return null;
  return {
    kind: 'gap',
    dir: index === 0 ? 'down' : 'both',
    hidden: hunkOldStart(hunk) - (prevOldEnd ?? 0) - 1,
  };
}

function buildUnifiedModel(hunks: DiffHunk[], expandable: boolean): RowModel<UnifiedRow> {
  const rows: UnifiedRow[] = [];
  let bodyCount = 0;
  let prevOldEnd: number | undefined;
  hunks.forEach((hunk, i) => {
    const gap = gapRow(hunk, i, prevOldEnd);
    if (expandable && gap) rows.push(gap);
    rows.push({ kind: 'header', text: hunk.header });
    for (const line of hunk.lines) {
      rows.push({ kind: 'line', line });
      bodyCount++;
    }
    prevOldEnd = hunkOldEnd(hunk);
  });
  return { rows, bodyCount };
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

function buildSplitModel(hunks: DiffHunk[], expandable: boolean): RowModel<SplitRow> {
  const rows: SplitRow[] = [];
  let bodyCount = 0;
  let prevOldEnd: number | undefined;
  hunks.forEach((hunk, i) => {
    const gap = gapRow(hunk, i, prevOldEnd);
    if (expandable && gap) rows.push(gap);
    rows.push({ kind: 'header', text: hunk.header });
    for (const pair of buildSplitPairs(hunk.lines)) {
      rows.push({ kind: 'pair', ...pair });
      bodyCount++;
    }
    prevOldEnd = hunkOldEnd(hunk);
  });
  return { rows, bodyCount };
}

// ── Virtualized fallback ────────────────────────────────────────────────

/** Past this many content rows the list body switches to a virtualized
 *  scroll container so huge diffs don't mount thousands of DOM rows. */
const VIRTUALIZE_ROW_THRESHOLD = 400;
/** 12px text at leading-[1.7]; measureElement corrects wrapped rows. */
const ESTIMATED_ROW_HEIGHT = 20.4;

function VirtualRows<R>({ rows, children }: { rows: R[]; children: (row: R, index: number) => React.ReactNode }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  });
  return (
    <div ref={parentRef} className="max-h-[480px] overflow-y-auto relative">
      <div style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="w-full"
            style={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${row.start}px)` }}
          >
            {children(rows[row.index], row.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Diff bodies ─────────────────────────────────────────────────────────

interface DiffBodyProps {
  hunks: DiffHunk[];
  language?: string;
  highlight: boolean;
  contextLines: number;
  onExpandContext?: (n: number) => void;
}

/** Unified diff view — old + new line numbers in one column. */
function UnifiedDiff({ hunks, language, highlight, contextLines, onExpandContext }: DiffBodyProps) {
  const model = useMemo(
    () => buildUnifiedModel(hunks, onExpandContext != null),
    [hunks, onExpandContext],
  );

  const renderRow = (row: UnifiedRow) => {
    if (row.kind === 'gap') {
      return <ExpandSeparator dir={row.dir} hiddenLines={row.hidden} contextLines={contextLines} onExpand={onExpandContext!} />;
    }
    if (row.kind === 'header') {
      return <div className="px-3 py-1 bg-info/[0.06] text-info/70 text-[0.7857rem] border-y border-info/10 select-none">{row.text}</div>;
    }
    const line = row.line;
    const isAdd = line.type === 'add';
    const isDel = line.type === 'del';
    const isContext = line.type === 'context';
    const text = stripSign(line.text);
    const code = highlight && language != null;
    return (
      <div className={cn('flex items-start px-0', isAdd && 'bg-success/[0.08]', isDel && 'bg-destructive/[0.08]')}>
        <span className={cn('select-none w-[32px] flex-shrink-0 text-right pr-2 tabular-nums text-[0.7143rem] pt-[1px]', isDel ? 'text-destructive/50' : 'text-muted-foreground/40')}>{line.oldNo ?? ''}</span>
        <span className={cn('select-none w-[32px] flex-shrink-0 text-right pr-2 tabular-nums text-[0.7143rem] pt-[1px]', isAdd ? 'text-success/50' : 'text-muted-foreground/40')}>{line.newNo ?? ''}</span>
        <span className={cn('select-none w-[16px] flex-shrink-0 text-center pt-[1px]', isAdd && 'text-success/60', isDel && 'text-destructive/60', isContext && 'text-transparent')}>{isAdd ? '+' : isDel ? '−' : ' '}</span>
        <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3', !code && isAdd && 'text-success', !code && isDel && 'text-destructive', !code && isContext && 'text-muted-foreground')}>
          {code ? <CodeSpan text={text} language={language} /> : text}
        </span>
      </div>
    );
  };

  return (
    <div className="font-mono text-[0.8571rem] leading-[1.7]">
      {model.bodyCount > VIRTUALIZE_ROW_THRESHOLD
        ? <VirtualRows rows={model.rows}>{renderRow}</VirtualRows>
        : model.rows.map((row, j) => <div key={j}>{renderRow(row)}</div>)}
    </div>
  );
}

/** Side-by-side diff view — old on the left, new on the right. Paired
 *  del/add rows get word-level highlights so a small edit reads instantly;
 *  context and unpaired rows get syntax highlighting when available. */
function SplitDiff({ hunks, language, highlight, contextLines, onExpandContext }: DiffBodyProps) {
  const model = useMemo(
    () => buildSplitModel(hunks, onExpandContext != null),
    [hunks, onExpandContext],
  );

  const renderRow = (row: SplitRow) => {
    if (row.kind === 'gap') {
      return <ExpandSeparator dir={row.dir} hiddenLines={row.hidden} contextLines={contextLines} onExpand={onExpandContext!} />;
    }
    if (row.kind === 'header') {
      return <div className="px-3 py-1 bg-info/[0.06] text-info/70 text-[0.7857rem] border-y border-info/10 select-none">{row.text}</div>;
    }
    const { left, right } = row;
    const leftDel = left?.type === 'del';
    const rightAdd = right?.type === 'add';
    // Word-diff wins on paired changed rows — syntax highlighting applies to
    // context rows and unpaired sides instead of intersecting the two.
    const segs =
      leftDel && rightAdd && left && right
        ? wordDiff(stripSign(left.text), stripSign(right.text))
        : null;
    const code = highlight && language != null;
    const side = (line: DiffLine | undefined, del: boolean, add: boolean, old: boolean) => {
      const tone = del ? 'text-destructive' : add ? 'text-success' : 'text-muted-foreground';
      return (
        <div className={cn('flex-1 flex items-start min-w-0', old && 'border-r border-border/50', del && 'bg-destructive/[0.08]', add && 'bg-success/[0.08]')}>
          <span className={cn('select-none w-[36px] flex-shrink-0 text-right pr-2 tabular-nums text-[0.7143rem] pt-[1px]', del ? 'text-destructive/50' : add ? 'text-success/50' : 'text-muted-foreground/40')}>
            {line ? (old ? line.oldNo ?? '' : line.newNo ?? '') : ''}
          </span>
          <span className={cn('flex-1 whitespace-pre-wrap break-all pr-3 pl-1', (segs || !code) && tone)}>
            {line
              ? segs
                ? <Segments segs={old ? segs.left : segs.right} tone={old ? 'del' : 'add'} />
                : code
                  ? <CodeSpan text={stripSign(line.text)} language={language!} />
                  : stripSign(line.text)
              : ''}
          </span>
        </div>
      );
    };
    return (
      <div className="flex items-start">
        {side(left, leftDel, false, true)}
        {side(right, false, rightAdd, false)}
      </div>
    );
  };

  return (
    <div className="font-mono text-[0.8571rem] leading-[1.7]">
      {model.bodyCount > VIRTUALIZE_ROW_THRESHOLD
        ? <VirtualRows rows={model.rows}>{renderRow}</VirtualRows>
        : model.rows.map((row, j) => <div key={j}>{renderRow(row)}</div>)}
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
      <div className="flex items-center rounded-md border border-border/60 overflow-hidden text-[0.7143rem] leading-none select-none">
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
  /** Syntax language for per-line highlighting (langFromPath id); absent = none. */
  language?: string;
  /** Context width the hunks were fetched with — seeds the expand ladder. */
  contextLines?: number;
  /** Refetch on expand. Absent (chat tool blocks, commit diffs) hides the
   *  separator affordances entirely — the component stays pure. */
  onExpandContext?: (contextLines: number) => void;
}

/** Renders diff hunks. Mode defaults to the persisted `diffMode` preference;
 *  the `mode` prop remains as an explicit per-instance override. */
export function DiffView({ hunks, mode, language, contextLines = 3, onExpandContext }: DiffViewProps) {
  const diffMode = useUi((s) => s.diffMode);
  const setDiffMode = useUi((s) => s.setDiffMode);
  const resolved = mode ?? diffMode;
  const highlight = useMemo(() => {
    if (language == null || language === 'text') return false;
    let totalChars = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) totalChars += line.text.length;
    }
    return shouldHighlight([], totalChars);
  }, [language, hunks]);
  return (
    <div className="min-w-0">
      {hunks.length > 0 && <DiffModeTabs mode={resolved} onChange={setDiffMode} />}
      {resolved === 'split' ? (
        <SplitDiff hunks={hunks} language={language} highlight={highlight} contextLines={contextLines} onExpandContext={onExpandContext} />
      ) : (
        <UnifiedDiff hunks={hunks} language={language} highlight={highlight} contextLines={contextLines} onExpandContext={onExpandContext} />
      )}
    </div>
  );
}
