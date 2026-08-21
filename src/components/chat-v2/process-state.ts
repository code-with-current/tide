/** Pure open/closed derivation for the compact-mode process container.
 * Answer-gated: open while process streams, closes when the answer actively
 * streams, re-opens if process resumes after an answer stretch. The user's
 * click during a turn pins their choice (returned unchanged until reset). */
import type { Block } from '@/types';
import { derivePhases } from '@/components/chat/blocks/reasoning-phases';

export interface ProcessOpenInput {
  streaming: boolean;
  hasProcess: boolean;
  answerActive: boolean;
  /** Phase of the most recent growth — distinguishes first-open from
   * re-open-after-answer without tracking timestamps. Accepted for
   * documentation; does not change the outcome (process-resumed turns have
   * answerActive: false, which opens). */
  lastPhase?: 'process' | 'answer';
  userPinned: boolean | null;
}

export function deriveProcessOpen(input: ProcessOpenInput): boolean {
  const { streaming, hasProcess, answerActive, userPinned } = input;
  if (userPinned !== null) return userPinned;
  if (!hasProcess) return false;
  if (!streaming) return false;
  return !answerActive;
}

/** The answer is "actively streaming" when the turn is live and the most
 *  recent growth is a text block — the answer currently growing. `isAnswer`
 *  is only flagged on turn_end (streamReducer.applyTurnEnd), so the live
 *  derivation instead mirrors that rule on the tail: text after every tool
 *  is the presumptive answer. A trailing tool or reasoning block means
 *  process is running instead. */
export function answerIsGrowing(blocks: Block[] | undefined, streaming: boolean): boolean {
  if (!streaming || !blocks || blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  return last.kind === 'text';
}

/** Number of process steps (reasoning + tool blocks) in a block list — the
 * container header's "· N steps" count. */
export function stepsCount(blocks: Block[] | undefined): number {
  if (!blocks) return 0;
  let n = 0;
  for (const b of blocks) if (b.kind === 'reasoning' || b.kind === 'tool') n++;
  return n;
}

/** Label of the most recent reasoning phase — the container header's live
 * hint. Null when there is no phased content yet. */
export function lastPhaseLabel(text: string | undefined): string | null {
  if (!text) return null;
  const phases = derivePhases(text);
  return phases.length > 0 ? phases[phases.length - 1].label : null;
}
