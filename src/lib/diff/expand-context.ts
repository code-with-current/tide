/** Expandable diff context — pure helpers shared by the renderer (separator
 *  affordances) and the main process (contextLines clamping). */
import type { DiffHunk } from '@/types';

/** Expand ladder: each click widens context to the next rung, capped here. */
export const MAX_EXPAND_CONTEXT = 200;

const EXPAND_LADDER = [3, 12, 24, 48, 96, MAX_EXPAND_CONTEXT] as const;

/** Values >= this are the documented full-file sentinel (e.g. 100000 in
 *  turn-block's viewer fetch) — passed through unclamped so whole-file diffs
 *  keep working while ladder values stay bounded. */
const FULL_FILE_CONTEXT = 1000;

/** Next context width after `current` when the user expands. Snaps up to the
 *  next rung; already at (or past) the cap it stays there so callers can
 *  hide the affordance when `next === current`. */
export function nextExpandWidth(current: number): number {
  for (const rung of EXPAND_LADDER) {
    if (rung > current) return rung;
  }
  return MAX_EXPAND_CONTEXT;
}

/** Sanitize an IPC `contextLines` argument. Absent / non-finite → undefined
 *  (git's default context of 3); ladder-range values clamp into 1..200;
 *  full-file sentinels pass through. */
export function clampContextLines(n: number | null | undefined): number | undefined {
  if (n == null || !Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded >= FULL_FILE_CONTEXT) return rounded;
  return Math.min(MAX_EXPAND_CONTEXT, Math.max(1, rounded));
}

/** Old-side start line parsed from the @@ header. Uses the header (not the
 *  first line's oldNo) so pure-addition hunks resolve correctly; 0 when the
 *  header doesn't parse. */
export function hunkOldStart(hunk: DiffHunk): number {
  const m = hunk.header.match(/^@@ -(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Old-side end line (last oldNo, or oldStart - 1 when the hunk adds only). */
export function hunkOldEnd(hunk: DiffHunk): number {
  let end = -1;
  for (const line of hunk.lines) {
    if (line.oldNo != null && line.oldNo > end) end = line.oldNo;
  }
  return end >= 0 ? end : hunkOldStart(hunk) - 1;
}

/** Lines were skipped before this hunk when it starts more than one line
 *  past the previous hunk's old end — or beyond line 1 for the first hunk
 *  (`prevOldEnd` omitted). */
export function hunkHasCollapsedContextBefore(hunk: DiffHunk, prevOldEnd?: number): boolean {
  return hunkOldStart(hunk) > (prevOldEnd ?? 0) + 1;
}

/** Lines were skipped after this hunk when the next hunk starts beyond this
 *  hunk's old end + 1. The last hunk has no next hunk and EOF is unknowable
 *  from hunks alone, so it reports false. */
export function hunkHasCollapsedContextAfter(hunk: DiffHunk, nextOldStart?: number): boolean {
  return nextOldStart != null && nextOldStart > hunkOldEnd(hunk) + 1;
}
