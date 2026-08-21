/** Agents-panel child stream: the dispatch's direct children — tool, text
 *  (narration), and reasoning blocks tagged parentToolCallId === dispatchId —
 *  as ordered segments in emission order, mirroring block-list's stream
 *  branch. Contiguous tool children merge into run segments (one ToolChips
 *  section each); any other block breaks the run, matching groupToolRuns.
 *  Grandchildren index by parent so flattenRun nests them under their row. */
import type { Block, ReasoningBlock, TextBlock, ToolBlock } from '@/types';

export type AgentSegment =
  | { type: 'reasoning'; block: ReasoningBlock }
  | { type: 'text'; block: TextBlock }
  | { type: 'tools'; run: ToolBlock[] };

export interface AgentStream {
  segments: AgentSegment[];
  childrenByParent: Map<string, ToolBlock[]>;
}

export function agentStream(blocks: Block[] | undefined, dispatchId: string): AgentStream {
  const childrenByParent = new Map<string, ToolBlock[]>();
  const segments: AgentSegment[] = [];
  let openRun: ToolBlock[] | undefined;
  for (const b of blocks ?? []) {
    const parent =
      b.kind === 'tool' || b.kind === 'text' || b.kind === 'reasoning'
        ? (b.parentToolCallId ?? null)
        : null;
    if (parent === dispatchId) {
      if (b.kind === 'tool') {
        if (openRun) openRun.push(b);
        else segments.push({ type: 'tools', run: (openRun = [b]) });
        continue;
      }
      openRun = undefined;
      if (b.kind === 'text') segments.push({ type: 'text', block: b });
      else if (b.kind === 'reasoning') segments.push({ type: 'reasoning', block: b });
      continue;
    }
    openRun = undefined;
    if (b.kind === 'tool' && parent) {
      const arr = childrenByParent.get(parent);
      if (arr) arr.push(b);
      else childrenByParent.set(parent, [b]);
    }
  }
  return { segments, childrenByParent };
}
