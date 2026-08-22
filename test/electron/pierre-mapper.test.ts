import { describe, it, expect } from 'vitest';
import { mapHunksToPierreMetadata } from '@/lib/diff/pierre-mapper';
import type { DiffHunk } from '@/types';

/** Git-style hunks — exactly what parseUnifiedDiff yields (text keeps its
 *  +/-/space prefix, line numbers are 1-based). */
const gitStyleHunks: DiffHunk[] = [
  {
    header: '@@ -1,4 +1,4 @@',
    lines: [
      { type: 'context', oldNo: 1, newNo: 1, text: ' ctx1' },
      { type: 'del', oldNo: 2, text: '-del2' },
      { type: 'add', newNo: 2, text: '+add2' },
      { type: 'context', oldNo: 3, newNo: 3, text: ' ctx3' },
      { type: 'context', oldNo: 4, newNo: 4, text: ' ctx4' },
    ],
  },
  {
    header: '@@ -8,2 +8,3 @@',
    lines: [
      { type: 'context', oldNo: 8, newNo: 8, text: ' ctx8' },
      { type: 'add', newNo: 9, text: '+add9' },
      { type: 'context', oldNo: 10, newNo: 10, text: ' ctx10' },
    ],
  },
];

describe('mapHunksToPierreMetadata', () => {
  it('maps a two-hunk mixed diff losslessly', () => {
    const meta = mapHunksToPierreMetadata(gitStyleHunks, undefined, 'src/app.ts');

    expect(meta).toEqual({
      name: 'src/app.ts',
      type: 'change',
      isPartial: true,
      splitLineCount: 10,
      unifiedLineCount: 11,
      deletionLines: ['ctx1\n', 'del2\n', 'ctx3\n', 'ctx4\n', 'ctx8\n', 'ctx10\n'],
      additionLines: ['ctx1\n', 'add2\n', 'ctx3\n', 'ctx4\n', 'ctx8\n', 'add9\n', 'ctx10\n'],
      hunks: [
        {
          collapsedBefore: 0,
          additionStart: 1,
          additionCount: 4,
          additionLines: 1,
          additionLineIndex: 0,
          deletionStart: 1,
          deletionCount: 4,
          deletionLines: 1,
          deletionLineIndex: 0,
          splitLineStart: 0,
          splitLineCount: 4,
          unifiedLineStart: 0,
          unifiedLineCount: 5,
          hunkSpecs: '@@ -1,4 +1,4 @@',
          hunkContent: [
            { type: 'context', lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
            { type: 'change', additions: 1, deletions: 1, additionLineIndex: 1, deletionLineIndex: 1 },
            { type: 'context', lines: 2, additionLineIndex: 2, deletionLineIndex: 2 },
          ],
          noEOFCRAdditions: false,
          noEOFCRDeletions: false,
        },
        {
          collapsedBefore: 3,
          additionStart: 8,
          additionCount: 3,
          additionLines: 1,
          additionLineIndex: 4,
          deletionStart: 8,
          deletionCount: 2,
          deletionLines: 0,
          deletionLineIndex: 4,
          splitLineStart: 7,
          splitLineCount: 3,
          unifiedLineStart: 8,
          unifiedLineCount: 3,
          hunkSpecs: '@@ -8,2 +8,3 @@',
          hunkContent: [
            { type: 'context', lines: 1, additionLineIndex: 4, deletionLineIndex: 4 },
            { type: 'change', additions: 1, deletions: 0, additionLineIndex: 5, deletionLineIndex: 5 },
            { type: 'context', lines: 1, additionLineIndex: 6, deletionLineIndex: 5 },
          ],
          noEOFCRAdditions: false,
          noEOFCRDeletions: false,
        },
      ],
    });
  });

  it('parses hunk context from the header and passes language through', () => {
    const hunks: DiffHunk[] = [
      {
        header: '@@ -1,1 +1,1 @@ function app()',
        lines: [{ type: 'context', oldNo: 1, newNo: 1, text: ' x' }],
      },
    ];
    const meta = mapHunksToPierreMetadata(hunks, 'typescript');
    expect(meta.lang).toBe('typescript');
    expect(meta.hunks[0].hunkContext).toBe('function app()');
  });

  it('returns empty partial metadata for no hunks', () => {
    const meta = mapHunksToPierreMetadata([]);
    expect(meta).toEqual({
      name: '',
      type: 'change',
      hunks: [],
      splitLineCount: 0,
      unifiedLineCount: 0,
      isPartial: true,
      deletionLines: [],
      additionLines: [],
    });
  });

  it('maps a context-only hunk', () => {
    const hunks: DiffHunk[] = [
      {
        header: '@@ -5,3 +5,3 @@',
        lines: [
          { type: 'context', oldNo: 5, newNo: 5, text: ' a' },
          { type: 'context', oldNo: 6, newNo: 6, text: ' b' },
          { type: 'context', oldNo: 7, newNo: 7, text: ' c' },
        ],
      },
    ];
    const meta = mapHunksToPierreMetadata(hunks);

    expect(meta.deletionLines).toEqual(['a\n', 'b\n', 'c\n']);
    expect(meta.additionLines).toEqual(['a\n', 'b\n', 'c\n']);
    expect(meta.splitLineCount).toBe(7);
    expect(meta.unifiedLineCount).toBe(7);
    expect(meta.hunks[0]).toMatchObject({
      collapsedBefore: 4,
      additionStart: 5,
      additionCount: 3,
      additionLines: 0,
      deletionStart: 5,
      deletionCount: 3,
      deletionLines: 0,
      splitLineStart: 4,
      splitLineCount: 3,
      unifiedLineStart: 4,
      unifiedLineCount: 3,
    });
    expect(meta.hunks[0].hunkContent).toEqual([
      { type: 'context', lines: 3, additionLineIndex: 0, deletionLineIndex: 0 },
    ]);
  });

  it('derives both hunk starts from the header when a hunk has no lines', () => {
    const meta = mapHunksToPierreMetadata([{ header: '@@ -4,0 +5,0 @@', lines: [] }]);
    expect(meta.hunks[0]).toMatchObject({
      collapsedBefore: 5,
      additionStart: 5,
      additionCount: 0,
      deletionStart: 4,
      deletionCount: 0,
      splitLineCount: 0,
      unifiedLineCount: 0,
    });
    expect(meta.hunks[0].hunkContent).toEqual([]);
  });

  it('maps edit-tool hunks: prefix-less text, unnumbered adds, trailing context without numbers', () => {
    const hunks: DiffHunk[] = [
      {
        header: '@@ -2,4 +2,5 @@ src/a.ts',
        lines: [
          { type: 'context', oldNo: 2, newNo: 2, text: 'alpha' },
          { type: 'context', oldNo: 3, newNo: 3, text: 'beta' },
          { type: 'del', oldNo: 4, text: 'gamma' },
          { type: 'add', newNo: 0, text: 'gamma2' },
          { type: 'add', newNo: 0, text: 'gamma3' },
          { type: 'context', text: 'delta' },
        ],
      },
    ];
    const meta = mapHunksToPierreMetadata(hunks);

    expect(meta.deletionLines).toEqual(['alpha\n', 'beta\n', 'gamma\n', 'delta\n']);
    expect(meta.additionLines).toEqual(['alpha\n', 'beta\n', 'gamma2\n', 'gamma3\n', 'delta\n']);
    expect(meta.splitLineCount).toBe(6);
    expect(meta.unifiedLineCount).toBe(7);
    expect(meta.hunks[0]).toMatchObject({
      collapsedBefore: 1,
      additionStart: 2,
      additionCount: 5,
      additionLines: 2,
      additionLineIndex: 0,
      deletionStart: 2,
      deletionCount: 4,
      deletionLines: 1,
      deletionLineIndex: 0,
      splitLineStart: 1,
      splitLineCount: 5,
      unifiedLineStart: 1,
      unifiedLineCount: 6,
    });
    expect(meta.hunks[0].hunkContent).toEqual([
      { type: 'context', lines: 2, additionLineIndex: 0, deletionLineIndex: 0 },
      { type: 'change', additions: 2, deletions: 1, additionLineIndex: 2, deletionLineIndex: 2 },
      { type: 'context', lines: 1, additionLineIndex: 4, deletionLineIndex: 3 },
    ]);
  });

  it('strips only the type-matched prefix character', () => {
    const hunks: DiffHunk[] = [
      {
        header: '@@ -1,3 +1,3 @@',
        lines: [
          { type: 'context', oldNo: 1, newNo: 1, text: '  indented' },
          { type: 'del', oldNo: 2, text: '-minus-' },
          { type: 'add', newNo: 2, text: '++plus' },
        ],
      },
    ];
    const meta = mapHunksToPierreMetadata(hunks);
    expect(meta.deletionLines).toEqual([' indented\n', 'minus-\n']);
    expect(meta.additionLines).toEqual([' indented\n', '+plus\n']);
  });

  it('ignores hunk-marker lines inside the body', () => {
    const hunks: DiffHunk[] = [
      {
        header: '@@ -1,2 +1,2 @@',
        lines: [
          { type: 'hunk', text: '@@ -1,2 +1,2 @@' },
          { type: 'context', oldNo: 1, newNo: 1, text: ' a' },
          { type: 'add', newNo: 2, text: '+b' },
        ],
      },
    ];
    const meta = mapHunksToPierreMetadata(hunks);
    expect(meta.additionLines).toEqual(['a\n', 'b\n']);
    expect(meta.hunks[0].additionCount).toBe(2);
    expect(meta.hunks[0].deletionCount).toBe(1);
  });
});
