import type { DiffHunk, DiffLine } from '@/types';
import type { FileDiffMetadata, Hunk, ChangeContent, ContextContent } from '@pierre/diffs';

/**
 * Maps Tide's parsed diff hunks to Pierre's `FileDiffMetadata`, mirroring the
 * `isPartial: true` path of Pierre's own patch parser (`processFile`): the
 * metadata-level `deletionLines`/`additionLines` arrays hold only the content
 * present in the hunks, each entry carrying its trailing newline (Pierre joins
 * them into a whole document for highlighting).
 *
 * Tide has two hunk producers with different text conventions: `parseUnifiedDiff`
 * (git output — text keeps its +/-/space prefix) and the edit tools (raw text,
 * no prefix). The prefix is stripped only when it matches the line's own type,
 * which is exact for git hunks and faithful for edit-tool hunks.
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: (.*))?$/;

function stripPrefix(line: DiffLine): string {
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  const text = line.text.startsWith(sign) ? line.text.slice(1) : line.text;
  return text.length === 0 ? '\n' : `${text}\n`;
}

function parseHeader(header: string): { deletionStart?: number; additionStart?: number; hunkContext?: string } {
  const match = header.match(HUNK_HEADER_RE);
  if (match == null) return {};
  return {
    deletionStart: Number(match[1]),
    additionStart: Number(match[2]),
    hunkContext: match[3],
  };
}

function sideStartBoundary(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1);
}

export function mapHunksToPierreMetadata(
  hunks: DiffHunk[],
  language?: string,
  name = '',
): FileDiffMetadata {
  const deletionLines: string[] = [];
  const additionLines: string[] = [];
  const mappedHunks: Hunk[] = [];
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let lastHunkEnd = 0;

  for (const hunk of hunks) {
    const lines = hunk.lines.filter((line) => line.type !== 'hunk');
    const header = parseHeader(hunk.header);

    let contextCount = 0;
    let addCount = 0;
    let delCount = 0;
    let additionStart: number | undefined;
    let deletionStart: number | undefined;
    for (const line of lines) {
      if (line.type === 'context') {
        contextCount++;
        if (line.newNo != null && line.newNo > 0) additionStart ??= line.newNo;
        if (line.oldNo != null && line.oldNo > 0) deletionStart ??= line.oldNo;
      } else if (line.type === 'add') {
        addCount++;
        if (line.newNo != null && line.newNo > 0) additionStart ??= line.newNo;
      } else {
        delCount++;
        if (line.oldNo != null && line.oldNo > 0) deletionStart ??= line.oldNo;
      }
    }
    additionStart ??= header.additionStart ?? 1;
    deletionStart ??= header.deletionStart ?? 1;
    const additionCount = contextCount + addCount;
    const deletionCount = contextCount + delCount;

    const mapped: Hunk = {
      collapsedBefore: 0,
      additionStart,
      additionCount,
      additionLines: addCount,
      additionLineIndex: additionLines.length,
      deletionStart,
      deletionCount,
      deletionLines: delCount,
      deletionLineIndex: deletionLines.length,
      hunkContent: [],
      hunkSpecs: hunk.header,
      splitLineStart: 0,
      splitLineCount: 0,
      unifiedLineStart: 0,
      unifiedLineCount: 0,
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
    };
    if (header.hunkContext != null) mapped.hunkContext = header.hunkContext;

    let current: ChangeContent | ContextContent | null = null;
    for (const line of lines) {
      if (line.type === 'add' || line.type === 'del') {
        if (current == null || current.type !== 'change') {
          current = {
            type: 'change',
            additions: 0,
            deletions: 0,
            additionLineIndex: additionLines.length,
            deletionLineIndex: deletionLines.length,
          };
          mapped.hunkContent.push(current);
        }
        if (line.type === 'add') {
          additionLines.push(stripPrefix(line));
          current.additions++;
        } else {
          deletionLines.push(stripPrefix(line));
          current.deletions++;
        }
      } else {
        if (current == null || current.type !== 'context') {
          current = {
            type: 'context',
            lines: 0,
            additionLineIndex: additionLines.length,
            deletionLineIndex: deletionLines.length,
          };
          mapped.hunkContent.push(current);
        }
        const text = stripPrefix(line);
        deletionLines.push(text);
        additionLines.push(text);
        current.lines++;
      }
    }

    mapped.collapsedBefore = Math.max(sideStartBoundary(additionStart, additionCount) - lastHunkEnd, 0);
    lastHunkEnd = sideStartBoundary(additionStart, additionCount) + additionCount;
    for (const content of mapped.hunkContent) {
      if (content.type === 'context') {
        mapped.splitLineCount += content.lines;
        mapped.unifiedLineCount += content.lines;
      } else {
        mapped.splitLineCount += Math.max(content.additions, content.deletions);
        mapped.unifiedLineCount += content.deletions + content.additions;
      }
    }
    mapped.splitLineStart = splitLineCount + mapped.collapsedBefore;
    mapped.unifiedLineStart = unifiedLineCount + mapped.collapsedBefore;
    splitLineCount += mapped.collapsedBefore + mapped.splitLineCount;
    unifiedLineCount += mapped.collapsedBefore + mapped.unifiedLineCount;

    mappedHunks.push(mapped);
  }

  return {
    name,
    lang: language,
    type: 'change',
    hunks: mappedHunks,
    splitLineCount,
    unifiedLineCount,
    isPartial: true,
    deletionLines,
    additionLines,
  };
}
