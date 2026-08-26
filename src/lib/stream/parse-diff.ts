import type { DiffHunk, DiffLine } from '../../types';

/** Parse unified diff output (from `git diff`) into DiffHunk[]: skip the preamble (diff --git, index, ---/+++) and process @@ hunk headers + bodies, ignoring the `\ No newline at end of file` marker. */
export function parseUnifiedDiff(raw: string): DiffHunk[] {
  if (!raw || !raw.trim()) return [];
  const lines = raw.split('\n');
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk);
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldNo = parseInt(match[1], 10);
        newNo = parseInt(match[2], 10);
      }
      currentHunk = { header: line, lines: [] };
      continue;
    }

    if (!currentHunk) continue;
    if (line.startsWith('\\')) continue;

    let diffLine: DiffLine;
    if (line.startsWith('+')) {
      diffLine = { type: 'add', newNo, text: line };
      newNo++;
    } else if (line.startsWith('-')) {
      diffLine = { type: 'del', oldNo, text: line };
      oldNo++;
    } else {
      diffLine = { type: 'context', oldNo, newNo, text: line };
      oldNo++;
      newNo++;
    }
    currentHunk.lines.push(diffLine);
  }

  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}
