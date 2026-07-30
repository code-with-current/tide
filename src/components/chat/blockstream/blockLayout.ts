/**
 * Pure layout derivation. Single pass over the block list routes each
 * block to its visual section: thinking, process (non-edit tools +
 * narration), edits (always-visible), answer, followup.
 *
 * Cheap (microseconds for typical turns) and memoized in BlockList via
 * useMemo on the blocks array reference.
 */

import type { Block, ReasoningBlock, TextBlock, ToolBlock, FollowupBlock } from '@/types';
import { isFailedStatus } from '@/lib/stream/blockState';

export interface TurnLayout {
  thinking?: ReasoningBlock;
  /** Non-edit tools + narration text, in emission order. */
  process: Array<ToolBlock | TextBlock>;
  /** Edit tool blocks — hoisted into their own always-visible section. */
  edits: ToolBlock[];
  answer?: TextBlock;
  followup?: FollowupBlock;
  /** Derived totals for the header + process summary line. */
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
        // Tally totals regardless of where it renders.
        layout.totals[b.category]++;
        if (isFailedStatus(b.status)) layout.totals.failedCount++;
        if (b.durationMs != null) layout.totals.totalMs += b.durationMs;
        // Edits are hoisted; everything else goes in process.
        if (b.category === 'edits') layout.edits.push(b);
        else layout.process.push(b);
        break;
      case 'text':
        if (b.isAnswer) {
          if (!layout.answer) layout.answer = b;
          // Defensive: a second answer block (shouldn't happen with the
          // reducer's positional rule) gets appended.
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
