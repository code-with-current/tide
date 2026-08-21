/** Block — atomic unit of a turn's rendered output (a turn is an ordered list of blocks). Each block has a stable id (assigned at emission, used as the React key, never mutates) so the reducer can update one block without busting siblings' memoization. See block-stream-ui-design.md. */

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
  /** When set, this text was emitted inside a sub-agent dispatched by the
   *  named parent dispatch_agent tool call. Parent-aware consumers (the
   *  Agents panel) render it; the main chat skips it. Undefined for
   *  top-level narration. */
  parentToolCallId?: string;
}

export interface ReasoningBlock extends BaseBlock {
  kind: 'reasoning';
  text: string;
  tokens?: number;
  ms?: number;
  /** When set, this reasoning was emitted inside a sub-agent — see
   *  TextBlock.parentToolCallId. */
  parentToolCallId?: string;
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
  /** When set, this tool call ran inside a sub-agent dispatched by the
   *  named parent dispatch_agent tool call. The renderer nests these
   *  under the parent block instead of rendering them as siblings.
   *  Undefined for top-level (main-orchestrator) tool calls. */
  parentToolCallId?: string;
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
