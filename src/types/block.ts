/**
 * Block — the atomic unit of a turn's rendered output. A turn is an
 * ordered list of blocks; array order is emission order.
 *
 * Every block has a stable `id` (assigned by the orchestrator at event
 * emission time) used as the React key. The id never changes after
 * creation. This is what lets the reducer update one block without
 * busting the memoization of its siblings.
 *
 * See `docs/superpowers/specs/2026-07-20-block-stream-ui-design.md`.
 */

import type {
  FollowupMode,
  RiskTier,
  ToolCallStatus,
  ToolDisplay,
  ToolName,
} from './index';

export interface BaseBlock {
  /** Stable id assigned by the orchestrator at creation. Never changes.
   *  For tool blocks: always equal to `toolCallId`. For text/reasoning:
   *  a UUID. For followup: `${toolCallId}#followup`. */
  id: string;
  /** Monotonic event `seq` when the block was created. */
  createdAtSeq: number;
  /** Monotonic event `seq` when the block was last modified. Used by
   *  memo comparators. */
  modifiedAtSeq: number;
}

export interface TextBlock extends BaseBlock {
  kind: 'text';
  text: string;
  /** True if this text block is the final answer (no tool block follows
   *  it in the array). Computed by the reducer on `turn_end`. False
   *  during streaming for the active block. */
  isAnswer: boolean;
}

export interface ReasoningBlock extends BaseBlock {
  kind: 'reasoning';
  text: string;
  tokens?: number;
  ms?: number;
}

export interface ToolBlock extends BaseBlock {
  kind: 'tool';
  /** Always equal to the tool call's id — tool blocks reuse it as their
   *  block id. Documented invariant; the reducer asserts it on creation. */
  toolCallId: string;
  toolName: ToolName;
  category: 'commands' | 'edits' | 'exploration' | 'other';
  status: ToolCallStatus;
  arguments: Record<string, unknown>;
  argPreview: string;
  /** Partial JSON while args stream in (for shimmer preview). */
  partialInput?: string;
  /** Sub-agent report streams here for dispatch_agent. */
  report?: string;
  riskTier: RiskTier;
  output?: string;
  display?: ToolDisplay;
  durationMs?: number;
  meta?: string;
}

export interface FollowupBlock extends BaseBlock {
  kind: 'followup';
  mode: FollowupMode;
  toolCallId: string;
}

export type Block = TextBlock | ReasoningBlock | ToolBlock | FollowupBlock;

/** Type guards — runtime narrowing without the verbose `b.kind === ...`
 *  pattern scattered through reducer and component code. */
export function isTextBlock(b: Block): b is TextBlock { return b.kind === 'text'; }
export function isReasoningBlock(b: Block): b is ReasoningBlock { return b.kind === 'reasoning'; }
export function isToolBlock(b: Block): b is ToolBlock { return b.kind === 'tool'; }
export function isFollowupBlock(b: Block): b is FollowupBlock { return b.kind === 'followup'; }
