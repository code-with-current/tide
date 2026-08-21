import { describe, expect, it } from 'vitest';
import type { Block, ToolBlock } from '@/types';
import { flattenRun, groupToolRuns } from '../stream-runs';

const tool = (over: Partial<ToolBlock>): ToolBlock =>
  ({
    kind: 'tool',
    id: over.toolCallId ?? 't',
    toolCallId: 't',
    toolName: 'bash',
    status: 'executed',
    ...over,
  }) as ToolBlock;

const text = (id: string): Block =>
  ({ kind: 'text', id, text: 'narration', isAnswer: false }) as Block;

describe('groupToolRuns — session root (null)', () => {
  it('groups contiguous top-level tools into one run', () => {
    const a = tool({ id: 'a', toolCallId: 'a' });
    const b = tool({ id: 'b', toolCallId: 'b' });
    const { runs, childrenByParent } = groupToolRuns([a, b], null);
    expect(runs).toEqual([[a, b]]);
    expect(childrenByParent.size).toBe(0);
  });

  it('non-tool blocks break the run', () => {
    const a = tool({ id: 'a', toolCallId: 'a' });
    const b = tool({ id: 'b', toolCallId: 'b' });
    const { runs } = groupToolRuns([a, text('x'), b], null);
    expect(runs).toEqual([[a], [b]]);
  });

  it('indexes parented blocks without surfacing them as runs', () => {
    const parent = tool({ id: 'p', toolCallId: 'p' });
    const child = tool({ id: 'c', toolCallId: 'c', parentToolCallId: 'p' });
    const { runs, childrenByParent } = groupToolRuns([parent, child], null);
    expect(runs).toEqual([[parent]]);
    expect(childrenByParent.get('p')).toEqual([child]);
  });

  it('parented text blocks never surface — not as runs, not indexed', () => {
    // Sub-agent narration interleaved with the parent's stream: ToolChips'
    // flattenRun only maps tool blocks, so parented text can only ever
    // break a run (same as any non-tool block), never render.
    const parent = tool({ id: 'p', toolCallId: 'p' });
    const childText = { kind: 'text', id: 'ct', text: 'child narration', isAnswer: false, parentToolCallId: 'p' } as unknown as Block;
    const next = tool({ id: 'n', toolCallId: 'n' });
    const { runs, childrenByParent } = groupToolRuns([parent, childText, next], null);
    expect(runs).toEqual([[parent], [next]]);
    expect(childrenByParent.size).toBe(0);
    const out = flattenRun(runs[0], childrenByParent);
    expect(out.map((c) => c.id)).toEqual(['p']);
  });

  it('undefined blocks → empty', () => {
    expect(groupToolRuns(undefined, null)).toEqual({ runs: [], childrenByParent: new Map() });
  });
});

describe('groupToolRuns — dispatch root', () => {
  it('direct children of the dispatch group into runs; grandchildren index by parent', () => {
    const dispatch = tool({ id: 'd', toolCallId: 'd' });
    const c1 = tool({ id: 'c1', toolCallId: 'c1', parentToolCallId: 'd' });
    const c2 = tool({ id: 'c2', toolCallId: 'c2', parentToolCallId: 'd' });
    const gc = tool({ id: 'gc', toolCallId: 'gc', parentToolCallId: 'c1' });
    const { runs, childrenByParent } = groupToolRuns([dispatch, c1, c2], 'd');
    expect(runs).toEqual([[c1, c2]]);
    expect(childrenByParent.size).toBe(0);

    const withGc = groupToolRuns([dispatch, c1, gc, c2], 'd');
    // A deeper descendant between two direct children breaks the run —
    // same semantics as interleaved children in the main stream branch.
    expect(withGc.runs).toEqual([[c1], [c2]]);
    expect(withGc.childrenByParent.get('c1')).toEqual([gc]);
  });

  it('blocks from other subtrees never leak in', () => {
    const other = tool({ id: 'o', toolCallId: 'o' });
    const otherChild = tool({ id: 'oc', toolCallId: 'oc', parentToolCallId: 'o' });
    const { runs, childrenByParent } = groupToolRuns([other, otherChild], 'd');
    expect(runs).toEqual([]);
    expect(childrenByParent.get('o')).toEqual([otherChild]);
  });
});

describe('flattenRun', () => {
  it('flattens children directly after their parent', () => {
    const parent = tool({ id: 'p', toolCallId: 'p' });
    const child = tool({ id: 'c', toolCallId: 'c', parentToolCallId: 'p' });
    const out = flattenRun([parent], new Map([['p', [child]]]));
    expect(out.map((c) => c.id)).toEqual(['p', 'c']);
    expect(out[1].parentToolCallId).toBe('p');
  });

  it('run order is preserved', () => {
    const a = tool({ id: 'a', toolCallId: 'a' });
    const b = tool({ id: 'b', toolCallId: 'b' });
    expect(flattenRun([a, b], new Map()).map((c) => c.id)).toEqual(['a', 'b']);
  });
});
