/** Pure layout derivation: single pass over the block list routes each block to its visual section (thinking / process / answer / followup). Edits render inline within the process section in emission order. */

import type { Block, ReasoningBlock, TextBlock, ToolBlock, FollowupBlock } from '@/types';
import { isFailedStatus } from '@/lib/stream/blockState';

export interface TurnLayout {
  thinking?: ReasoningBlock;
  /** All tools (including edits) + narration text, in emission order. */
  process: Array<ToolBlock | TextBlock>;
  /** Kept for back-compat — always empty now (edits merged into process). */
  edits: ToolBlock[];
  answer?: TextBlock;
  followup?: FollowupBlock;
  totals: {
    commands: number;
    edits: number;
    exploration: number;
    other: number;
    failedCount: number;
    totalMs: number;
  };
}

export function deriveLayout(blocks: Block[] | undefined): TurnLayout {
  const layout: TurnLayout = {
    process: [],
    edits: [],
    totals: { commands: 0, edits: 0, exploration: 0, other: 0, failedCount: 0, totalMs: 0 },
  };
  if (!blocks) return layout;

  for (const b of blocks) {
    switch (b.kind) {
      case 'reasoning':
        if (!layout.thinking) layout.thinking = b;
        break;
      case 'tool':
        // Children (sub-agent tool calls) count toward totals but don't
        // render as top-level process rows — they're nested inside their
        // dispatch_agent parent via the parentToolCallId linkage.
        if (b.parentToolCallId) {
          layout.totals[b.category]++;
          if (isFailedStatus(b.status)) layout.totals.failedCount++;
          if (b.durationMs != null) layout.totals.totalMs += b.durationMs;
          break;
        }
        layout.totals[b.category]++;
        if (isFailedStatus(b.status)) layout.totals.failedCount++;
        if (b.durationMs != null) layout.totals.totalMs += b.durationMs;
        // All tools (including edits) render inline in process, in emission order.
        layout.process.push(b);
        break;
      case 'text':
        if (b.isAnswer) {
          if (!layout.answer) layout.answer = b;
          else layout.answer.text += '\n\n' + b.text;
        } else {
          layout.process.push(b);
        }
        break;
      case 'followup':
        if (!layout.followup) layout.followup = b;
        break;
    }
  }
  return layout;
}
