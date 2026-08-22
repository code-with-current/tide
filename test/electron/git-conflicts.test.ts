import { describe, it, expect } from 'vitest';
import { parseConflictEntries } from '../../electron/ipc/git-conflicts';

/** The caller runs `git status --porcelain -z`: records are NUL-delimited
 *  and paths are emitted raw (no C-style quoting), so spaces/unicode in
 *  paths pass through verbatim. */
describe('parseConflictEntries', () => {
  it('returns empty for empty input', () => {
    expect(parseConflictEntries('')).toEqual([]);
  });

  it('returns empty when there are no conflicts', () => {
    const porcelain = ' M modified.ts\0?? untracked.ts\0A  staged.ts\0';
    expect(parseConflictEntries(porcelain)).toEqual([]);
  });

  it('maps UU to both-modified', () => {
    expect(parseConflictEntries('UU both.txt\0')).toEqual([
      { path: 'both.txt', state: 'both-modified' },
    ]);
  });

  it('maps AA to both-added', () => {
    expect(parseConflictEntries('AA added.txt\0')).toEqual([
      { path: 'added.txt', state: 'both-added' },
    ]);
  });

  it('maps DD to both-deleted', () => {
    expect(parseConflictEntries('DD gone.txt\0')).toEqual([
      { path: 'gone.txt', state: 'both-deleted' },
    ]);
  });

  it('maps AU to added-by-us', () => {
    expect(parseConflictEntries('AU ours.txt\0')).toEqual([
      { path: 'ours.txt', state: 'added-by-us' },
    ]);
  });

  it('maps UA to added-by-them', () => {
    expect(parseConflictEntries('UA theirs.txt\0')).toEqual([
      { path: 'theirs.txt', state: 'added-by-them' },
    ]);
  });

  it('maps DU to deleted-by-us', () => {
    expect(parseConflictEntries('DU ours-gone.txt\0')).toEqual([
      { path: 'ours-gone.txt', state: 'deleted-by-us' },
    ]);
  });

  it('maps UD to deleted-by-them', () => {
    expect(parseConflictEntries('UD theirs-gone.txt\0')).toEqual([
      { path: 'theirs-gone.txt', state: 'deleted-by-them' },
    ]);
  });

  it('excludes renamed RR entries — not a conflict status', () => {
    const porcelain = 'RR old.ts\0UU conflicted.ts\0';
    expect(parseConflictEntries(porcelain)).toEqual([
      { path: 'conflicted.ts', state: 'both-modified' },
    ]);
  });

  it('keeps paths with spaces verbatim (no -z quoting)', () => {
    expect(parseConflictEntries('UU my file name.txt\0')).toEqual([
      { path: 'my file name.txt', state: 'both-modified' },
    ]);
  });

  it('returns multiple conflicts in input order', () => {
    const porcelain = 'UU a.txt\0AA b.txt\0UD c.txt\0';
    expect(parseConflictEntries(porcelain)).toEqual([
      { path: 'a.txt', state: 'both-modified' },
      { path: 'b.txt', state: 'both-added' },
      { path: 'c.txt', state: 'deleted-by-them' },
    ]);
  });

  it('ignores trailing empty record after the final NUL', () => {
    expect(parseConflictEntries('UU a.txt\0')).toHaveLength(1);
  });
});
