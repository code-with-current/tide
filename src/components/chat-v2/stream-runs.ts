/** Shared stream-run grouping for the main chat stream (block-list's stream
 *  branch) and the docked Agents panel. Contiguous tool blocks whose parent
 *  is `rootId` (null = session top level, a dispatch id = that dispatch's
 *  children) group into runs — non-tool blocks break the run; deeper
 *  descendants index by parent so they flatten under their own row. */
import type { Block, ToolBlock, ToolCall } from '@/types';
import { toolBlockToToolCall } from '@/components/chat/turn/block-adapter';

export interface StreamRuns {
  runs: ToolBlock[][];
  childrenByParent: Map<string, ToolBlock[]>;
}

export function groupToolRuns(blocks: Block[] | undefined, rootId: string | null): StreamRuns {
  const childrenByParent = new Map<string, ToolBlock[]>();
  const runs: ToolBlock[][] = [];
  let prevWasRootTool = false;
  for (const b of blocks ?? []) {
    const isRootTool = b.kind === 'tool' && (b.parentToolCallId ?? null) === rootId;
    if (isRootTool) {
      const run = prevWasRootTool ? runs[runs.length - 1] : undefined;
      if (run) run.push(b);
      else runs.push([b]);
      prevWasRootTool = true;
      continue;
    }
    if (b.kind === 'tool' && b.parentToolCallId) {
      const arr = childrenByParent.get(b.parentToolCallId);
      if (arr) arr.push(b);
      else childrenByParent.set(b.parentToolCallId, [b]);
    }
    prevWasRootTool = false;
  }
  return { runs, childrenByParent };
}

/** v2 ToolChips input: tool calls with nested children flattened directly
 *  after their parent row. */
export function flattenRun(run: ToolBlock[], childrenByParent: Map<string, ToolBlock[]>): ToolCall[] {
  const out: ToolCall[] = [];
  for (const b of run) {
    out.push(toolBlockToToolCall(b));
    for (const child of childrenByParent.get(b.toolCallId) ?? []) {
      out.push(toolBlockToToolCall(child));
    }
  }
  return out;
}
