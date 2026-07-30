import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../../src/lib/stream/parseDiff';

describe('parseUnifiedDiff', () => {
  it('parses a single hunk with context + add + del lines', () => {
    const raw = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index abc..def 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -10,4 +10,6 @@ function app()',
      '   const router = createRouter();',
      '- const port = 3000;',
      '+ const port = process.env.PORT || 3000;',
      '+ // note',
      '   router.listen(port);',
    ].join('\n');

    const hunks = parseUnifiedDiff(raw);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe('@@ -10,4 +10,6 @@ function app()');
    expect(hunks[0].lines).toHaveLength(5);
    expect(hunks[0].lines[0]).toMatchObject({ type: 'context', oldNo: 10, newNo: 10 });
    expect(hunks[0].lines[1]).toMatchObject({ type: 'del', oldNo: 11 });
    expect(hunks[0].lines[2]).toMatchObject({ type: 'add', newNo: 11 });
    expect(hunks[0].lines[3]).toMatchObject({ type: 'add', newNo: 12 });
    expect(hunks[0].lines[4]).toMatchObject({ type: 'context', oldNo: 12, newNo: 13 });
  });

  it('parses multiple hunks', () => {
    const raw = [
      '@@ -1,2 +1,2 @@',
      ' old1',
      '-old2',
      '+new2',
      '@@ -10,1 +11,1 @@',
      ' ctx',
      '-del',
      '+add',
    ].join('\n');
    const hunks = parseUnifiedDiff(raw);
    expect(hunks).toHaveLength(2);
    expect(hunks[1].lines[0]).toMatchObject({ type: 'context' });
  });

  it('skips \\ No newline markers', () => {
    const raw = '@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new';
    const hunks = parseUnifiedDiff(raw);
    expect(hunks[0].lines).toHaveLength(2);
  });

  it('returns empty for non-diff input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('just text\nno diff here')).toEqual([]);
  });
});
