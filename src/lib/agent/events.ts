/** Agent event protocol — single source of truth for the orchestrator↔renderer wire format. Every event carries `sessionId` and a monotonic per-session `seq`. A single discriminated union (design doc §9, condensed). */

import type {
  Block,
  MessageAttachment,
  RiskTier,
  ToolCall,
  ToolCallStatus,
  ToolDisplay,
  ToolName,
  Usage,
} from '../../types/index';

export interface AgentEventBase {
  sessionId: string;
  /** Monotonic per-session sequence number. */
  seq: number;
}

/** Streamed assistant text token. */
export interface DeltaEvent extends AgentEventBase {
  type: 'delta';
  /** Message id assigned by the orchestrator for this assistant turn. */
  messageId: string;
  text: string;
  /** UUID assigned by the orchestrator when it opened this text block.
   *  Consecutive deltas in the same narration/answer segment share it;
   *  a fresh UUID signals "open a new text block." The reducer uses this
   *  to decide append-vs-push without guessing from position. */
  blockId: string;
  /** When set, this delta was emitted inside a sub-agent dispatched by the
   *  named parent dispatch_agent tool call — the reducer tags the text
   *  block so parent-aware consumers (Agents panel) render it and the main
   *  chat skips it. */
  parentToolCallId?: string;
}

/** Streamed reasoning token (Anthropic `thinking`, R1 `<think>`, etc.). */
export interface ReasoningEvent extends AgentEventBase {
  type: 'reasoning';
  messageId: string;
  delta: string;
  /** UUID for the reasoning block. Stable for the whole turn — every
   *  reasoning delta shares it. */
  blockId: string;
  /** Sub-agent origin marker — see DeltaEvent.parentToolCallId. */
  parentToolCallId?: string;
}

/** Model started a tool call — id + name known, args still streaming. */
export interface ToolCallStartEvent extends AgentEventBase {
  type: 'tool_call_start';
  messageId: string;
  toolCallId: string;
  toolName: ToolName;
  /** Always equal to `toolCallId`. Documented invariant; the reducer
   *  asserts it on creation. Repeated here (not derived) so the wire
   *  format is self-describing. */
  blockId: string;
  /** When set, this tool call originated inside a sub-agent dispatched by
   *  the named parent tool call (a dispatch_agent). The renderer nests
   *  these under the parent block instead of rendering them as siblings. */
  parentToolCallId?: string;
}

/** Partial tool args — for live preview / early cancel. */
export interface ToolCallDeltaEvent extends AgentEventBase {
  type: 'tool_call_delta';
  toolCallId: string;
  /** Partial JSON string fragment of the tool's input. */
  delta: string;
  /** Sub-agent origin marker — see ToolCallStartEvent.parentToolCallId. */
  parentToolCallId?: string;
}

/** Tool call fully assembled, ready for execution. */
export interface ToolCallEvent extends AgentEventBase {
  type: 'tool_call';
  messageId: string;
  toolCallId: string;
  toolName: ToolName;
  /** Parsed arguments object. */
  arguments: Record<string, unknown>;
  /** Human-readable preview for the UI. */
  argPreview: string;
  riskTier: RiskTier;
  /** Sub-agent origin marker — see ToolCallStartEvent.parentToolCallId. */
  parentToolCallId?: string;
}

/** Tool call moved into `running` state — execution started. */
export interface ToolExecutingEvent extends AgentEventBase {
  type: 'tool_executing';
  toolCallId: string;
  /** Sub-agent origin marker — see ToolCallStartEvent.parentToolCallId. */
  parentToolCallId?: string;
}

/** Tool finished — renderer shows the result/diff/output. */
export interface ToolResultEvent extends AgentEventBase {
  type: 'tool_result';
  toolCallId: string;
  status: ToolCallStatus;
  /** Model-facing short summary (already redacted). */
  output?: string;
  /** Richer UI-facing payload, e.g. a diff. */
  display?: ToolDisplay;
  durationMs?: number;
  meta?: string;
  /** Sub-agent origin marker — see ToolCallStartEvent.parentToolCallId. */
  parentToolCallId?: string;
}

/** Tool is asking the user to pick between options (ask_followup_question).
 *  The orchestrator is PAUSED on this tool call — it won't continue until
 *  the renderer sends a submitFollowup IPC command with the user's pick
 *  (or the user aborts the turn). Mirrors permission_required's pattern. */
export interface FollowupRequiredEvent extends AgentEventBase {
  type: 'followup_required';
  toolCallId: string;
  /** The question to display. */
  question: string;
  /** Concrete options the user can pick from. Empty array means the model
   *  is asking an open-ended question (Mode 2) — renderer shows composer
   *  prompt instead of a picker. */
  options: string[];
  /** Optional one-line description per option, parallel to `options`. */
  optionDescriptions?: (string | undefined)[];
  /** True if the user can pick multiple options. */
  multiple: boolean;
}

/** Gate needs a human decision; auto-reject fires at `timeoutAt`. */
export interface PermissionRequiredEvent extends AgentEventBase {
  type: 'permission_required';
  /** Tool calls awaiting approval. */
  toolCalls: ToolCall[];
  /** Epoch ms when auto-reject fires. */
  timeoutAt: number;
}

/** A background dispatch finished. The renderer turns this into a queued
 *  synthetic message so the parent turn picks it up via the queue drain. */
export interface DispatchResultEvent extends AgentEventBase {
  type: 'dispatch_result';
  /** The child dispatch session id (matches the ToolDisplay agent payload). */
  dispatchId: string;
  /** Dispatch title, when the model provided one. */
  title?: string;
  /** Terminal state — 'error' injects a task_error report, 'completed' a task_result. */
  state: 'completed' | 'error';
  /** The sub-agent's report (already redacted). */
  report: string;
}

/** Per-call usage by token class + running totals. */
export interface UsageEvent extends AgentEventBase {
  type: 'usage';
  messageId: string;
  /** This call's tokens. */
  tokens: Usage;
  /** Cumulative session cost in USD (may be 0 until pricing lands). */
  costUsd: number;
  /** Cumulative session cost. */
  runningTotalUsd: number;
  /** Which iteration within the turn (1-based). */
  iteration: number;
}

/** Turn complete. */
export interface TurnEndEvent extends AgentEventBase {
  type: 'turn_end';
  messageId: string;
  stopReason:
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'pause_turn'
    | 'refusal'
    | 'content_filter'
    | 'iteration_limit'
    | 'permission_timeout'
    | 'spend_cap'
    | 'aborted';
  /** Final assistant message shape, for persistence. */
  content: string;
  /** Ordered timeline preserving the exact interleaving of text and tool
   *  calls as the model emitted them: text₁ → tool₁ → text₂ → tool₂.
   *  The renderer iterates this array directly to render in emission order.
   *  Optional — older turns without it fall back to flat content + toolCalls. */
  timeline?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool'; toolIndex: number }
  >;
  reasoning?: string;
  reasoningTokens?: number;
  reasoningMs?: number;
  /** Wall-clock duration of the turn (ms), from turn start to turn end.
   *  Persisted on the message so the send→result timer survives reload. */
  totalMs?: number;
  toolCalls?: ToolCall[];
  /** Canonical block list for this turn, in emission order. The renderer
   *  uses this as the source of truth for the persisted message and the
   *  final rendered state. Built by the orchestrator. */
  blocks?: Block[];
  /** Aggregate usage for the whole turn (summed across all LLM calls).
   *  Used for cumulative cost accounting. Optional. */
  usage?: Usage;
  /** The LAST step's usage only (not accumulated). The context-window meter
   *  reads this to show the current context fill — the model's most recent
   *  request is what fills the window, not the sum of all steps. */
  lastStepUsage?: Usage;
}

/** Network, provider error, or timeout — after retries exhausted. */
export interface ErrorEvent extends AgentEventBase {
  type: 'error';
  message: string;
}

/** Emitted between retry attempts so the UI can show "Retrying 2/3…". */
export interface RetryEvent extends AgentEventBase {
  type: 'retry';
  /** Which retry is about to run (1-based). e.g. attempt=1 means "first retry"
   *  after the initial failure; the total including the initial call is
   *  attempt + 1. */
  attempt: number;
  /** Total number of retry attempts configured (not counting the initial call). */
  maxAttempts: number;
  /** The error that caused the retry, so the UI can show what went wrong. */
  reason: string;
}

/** Emitted when autocompact fires — the conversation was summarized to fit the
 *  context window. Lets the UI show a "Compacting…" indicator so the user knows
 *  why there's a brief pause before the next step streams.
 *
 *  Two-phase: the first event (tokensAfter absent) signals "compaction starting."
 *  After compactConversation() returns, a second event with `tokensAfter` set
 *  signals completion so the context meter can drop to the reduced count. */
export interface CompactingEvent extends AgentEventBase {
  type: 'compacting';
  messageId: string;
  /** Estimated token count before compaction. */
  tokensBefore: number;
  /** Token count after compaction (estimated). Present on the completion
   *  event; absent on the "starting" event. */
  tokensAfter?: number;
  /** Whether the user triggered it via /compact (vs auto threshold). */
  forced: boolean;
}

export type AgentEvent =
  | DeltaEvent
  | ReasoningEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEvent
  | ToolExecutingEvent
  | ToolResultEvent
  | FollowupRequiredEvent
  | PermissionRequiredEvent
  | DispatchResultEvent
  | UsageEvent
  | TurnEndEvent
  | RetryEvent
  | CompactingEvent
  | ErrorEvent;

/** IPC channel name for the unified agent event stream. */
export const AGENT_EVENT_CHANNEL = 'agent:event' as const;

/** IPC command names. */
export const AGENT_COMMANDS = {
  runTurn: 'agent:runTurn',
  abort: 'agent:abort',
  approve: 'agent:tool:approve',
  reject: 'agent:tool:reject',
  submitFollowup: 'agent:followup:submit',
} as const;

/** Payload for the runTurn command. */
export interface RunTurnPayload {
  sessionId: string;
  /** Full message history, including the just-added user message. */
  messages: TurnMessage[];
  modelId: string;
  providerId: string;
  autonomyMode: 'plan' | 'ask' | 'edit' | 'full';
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'extra' | 'max';
}

/** Message shape the orchestrator accepts — richer than the old chat path's `{role, content: string}`: content can be plain text or an array of Anthropic-shape content blocks. */
export interface TurnMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Attachments carried alongside a user message. */
  attachments?: MessageAttachment[];
}
