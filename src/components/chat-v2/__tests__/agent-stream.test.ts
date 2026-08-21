import { describe, expect, it } from 'vitest';
import type { Block, ReasoningBlock, TextBlock, ToolBlock } from '@/types';
import { agentStream } from '../agent-stream';

const tool = (over: Partial<ToolBlock>): ToolBlock =>
  ({
    kind: 'tool',
    id: over.toolCallId ?? 't',
    toolCallId: 't',
    toolName: 'bash',
    status: 'executed',
    ...over,
  }) as ToolBlock;

const childText = (id: string, text = 'child narration'): TextBlock =>
  ({ kind: 'text', id, text, isAnswer: false, parentToolCallId: 'd' }) as unknown as TextBlock;

const childReasoning = (id: string, text = 'child thinking'): ReasoningBlock =>
  ({ kind: 'reasoning', id, text, parentToolCallId: 'd' }) as unknown as ReasoningBlock;

describe('agentStream — segment ordering', () => {
  it('interleaves reasoning, tool runs, and text in emission order', () => {
    const r1 = childReasoning('r1');
    const c1 = tool({ id: 'c1', toolCallId: 'c1', parentToolCallId: 'd' });
    const t1 = childText('t1');
    const c2 = tool({ id: 'c2', toolCallId: 'c2', parentToolCallId: 'd' });
    const { segments } = agentStream([r1, c1, c2, t1], 'd');
    expect(segments.map((s) => s.type)).toEqual(['reasoning', 'tools', 'text']);
    if (segments[1]?.type === 'tools') {
      expect(segments[1].run.map((b) => b.id)).toEqual(['c1', 'c2']);
    }
    expect(segments[2]).toEqual({ type: 'text', block: t1 });
  });

  it('a child text or reasoning block breaks a tool run', () => {
    const c1 = tool({ id: 'c1', toolCallId: 'c1', parentToolCallId: 'd' });
    const c2 = tool({ id: 'c2', toolCallId: 'c2', parentToolCallId: 'd' });
    const { segments } = agentStream([c1, childText('t1'), c2], 'd');
    expect(segments.map((s) => s.type)).toEqual(['tools', 'text', 'tools']);
  });

  it('consecutive reasoning blocks stay per-block (main-stream parity)', () => {
    const r1 = childReasoning('r1');
    const r2 = childReasoning('r2');
    const { segments } = agentStream([r1, r2], 'd');
    expect(segments).toEqual([
      { type: 'reasoning', block: r1 },
      { type: 'reasoning', block: r2 },
    ]);
  });
});

describe('agentStream — scoping', () => {
  it('the dispatch block itself never surfaces', () => {
    const dispatch = tool({ id: 'd', toolCallId: 'd', toolName: 'dispatch_agent' });
    const c1 = tool({ id: 'c1', toolCallId: 'c1', parentToolCallId: 'd' });
    const { segments } = agentStream([dispatch, c1], 'd');
    expect(segments).toEqual([{ type: 'tools', run: [c1] }]);
  });

  it('grandchildren index by parent for flattenRun, never as segments', () => {
    const c1 = tool({ id: 'c1', toolCallId: 'c1', parentToolCallId: 'd' });
    const gc = tool({ id: 'gc', toolCallId: 'gc', parentToolCallId: 'c1' });
    const { segments, childrenByParent } = agentStream([c1, gc], 'd');
    expect(segments).toEqual([{ type: 'tools', run: [c1] }]);
    expect(childrenByParent.get('c1')).toEqual([gc]);
  });

  it('other subtrees and top-level blocks never leak, and break runs', () => {
    const c1 = tool({ id: 'c1', toolCallId: 'c1', parentToolCallId: 'd' });
    const foreign = tool({ id: 'o', toolCallId: 'o' });
    const foreignChild = tool({ id: 'oc', toolCallId: 'oc', parentToolCallId: 'o' });
    const topText = { kind: 'text', id: 'tt', text: 'parent narration', isAnswer: false } as unknown as Block;
    const c2 = tool({ id: 'c2', toolCallId: 'c2', parentToolCallId: 'd' });
    const { segments, childrenByParent } = agentStream([c1, foreign, foreignChild, topText, c2], 'd');
    expect(segments.map((s) => s.type)).toEqual(['tools', 'tools']);
    expect(childrenByParent.get('o')).toEqual([foreignChild]);
  });
});

describe('agentStream — edge cases', () => {
  it('undefined blocks → empty', () => {
    expect(agentStream(undefined, 'd')).toEqual({ segments: [], childrenByParent: new Map() });
  });

  it('empty-text child blocks still produce segments (render-side skips them)', () => {
    const { segments } = agentStream([childText('t1', '  '), childReasoning('r1', '')], 'd');
    expect(segments.map((s) => s.type)).toEqual(['text', 'reasoning']);
  });
});
