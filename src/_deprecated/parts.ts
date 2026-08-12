/** Parts-based event/state types — the new canonical shape for the agent event stream and renderer state (replaces `Block[]`). Two layers: `PartEvent` (IPC wire format) and `DerivedView` (memoized projection in Phase 4). */

import type { ToolName, Usage } from '@/types';

// ============================================================
// Part — canonical state. Accumulated by useParts from PartEvents.
// ============================================================

export type ToolCallStatus =
  | 'running'
  | 'awaiting_input'   // ask_followup_question paused on user
  | 'executed'
  | 'failed'
  | 'rejected';        // permission denied

export interface ReasoningPart {
  id: string;
  type: 'reasoning';
  text: string;
  /** Thinking tokens consumed (Anthropic-only; 0 elsewhere). */
  tokens?: number;
  /** Wall-clock ms for the thinking phase. */
  ms?: number;
}

export interface TextPart {
  id: string;
  type: 'text';
  text: string;
}

export interface ToolCallPart {
  id: string;
  type: 'tool-call';
  /** Stable identifier — equals the SDK's toolCallId. */
  toolCallId: string;
  toolName: ToolName;
  /** Parsed input args. */
  input: unknown;
  status: ToolCallStatus;
  /** Structured result from the tool's execute. */
  output?: unknown;
  /** Wall-clock ms for execution. */
  durationMs?: number;
  /** Risk tier (from toolMeta sidecar) for UI categorization. */
  category?: string;
}

/** A single moment in the ordered part stream. */
export type Part = ReasoningPart | TextPart | ToolCallPart;

// ============================================================
// PartEvent — the IPC wire format. Same channel, new shape.
// ============================================================

export type PartEvent =
  | { type: 'text'; id: string; delta: string }
  | { type: 'reasoning'; id: string; delta: string; tokens?: number; ms?: number }
  | {
      type: 'tool-call';
      id: string;
      toolCallId: string;
      toolName: ToolName;
      input: unknown;
      status: ToolCallStatus;
      output?: unknown;
      durationMs?: number;
      category?: string;
    }
  | { type: 'step-finish'; usage: Usage }
  | {
      type: 'followup';
      toolCallId: string;
      question: string;
      options: string[];
      multiple: boolean;
    }
  | { type: 'permission'; toolName: ToolName; args: unknown }
  | { type: 'rate-limited'; retryInMs: number }
  | { type: 'compacting'; tokensBefore: number }
  | { type: 'compacted'; tokensBefore: number; tokensAfter: number; messageCount: number }
  | { type: 'finish'; stopReason: string }
  | {
      type: 'error';
      message: string;
      kind?: 'quota_exhausted' | 'rate_limited' | 'network' | 'aborted' | 'generic';
    };

// ============================================================
// DerivedView — pure projection of Part[]. Phase 4's deriveView.
// ============================================================

export interface DerivedView {
  /** Concatenated reasoning deltas (ThinkingSection). */
  reasoning: { text: string; tokens?: number; ms?: number };
  /** Tool calls in emission order (ProcessSection + EditsSection). */
  toolCalls: ToolCallPart[];
  /** Text segments in emission order, with answer flag set. */
  textSegments: Array<{ id: string; text: string; isAnswer: boolean }>;
  /** Convenience: concatenated answer text (post-last-tool). */
  answer: string;
  /** Current pending followup, if any (FollowupPrompt). */
  followup?: { toolCallId: string; question: string; options: string[]; multiple: boolean };
  /** Current pending permission ask, if any (PermissionPrompt). */
  permissionRequest?: { toolName: ToolName; args: unknown };
  /** Whether the turn is still streaming. */
  isStreaming: boolean;
  /** Stop reason once the turn finished. */
  stopReason?: string;
}
