/** Per-turn context bound into every tool factory via closure (the SDK's execute only gets {messages, toolCallId, abortSignal}; everything Tide-specific rides through here). Mutable fields (autonomyMode, compactionSettings) may change mid-turn — read at execution time, not factory-build time. */

import type { Provider, Usage, AutonomyMode, ThinkingLevel } from '../../../src/types';
import type { CompactionSettings } from '../../../src/types/compaction';
import type { RuleSet } from '../permissions/rules.js';

/** Minimal emit signature — the orchestrator injects a part-shaped event. */
export type ToolEmit = (event: unknown) => void;

/** Callback a sub-agent uses to surface its internal tool-call lifecycle as
 *  real (nested) AgentEvents. The orchestrator injects this when building the
 *  top-level ToolContext; sub-agents read it and call it per part. Each event
 *  is an AgentEvent-shaped object (without seq — the bridge assigns one). */
export type EmitToolEvent = (event: {
  type: 'tool_call_start' | 'tool_call_delta' | 'tool_call' | 'tool_executing' | 'tool_result';
  parentToolCallId: string;
  toolCallId: string;
  toolName?: string;
  delta?: string;
  arguments?: Record<string, unknown>;
  argPreview?: string;
  riskTier?: import('../../../../src/types/index.js').RiskTier;
  status?: import('../../../../src/types/index.js').ToolCallStatus;
  output?: string;
  display?: import('../../../../src/types/index.js').ToolDisplay;
  durationMs?: number;
  meta?: string;
}) => void;

export interface ToolContext {
  sessionId: string;
  workspaceRoot: string;
  workspaceId: string;
  /** Mutable — withPermission updates this on plan→edit escalation. */
  autonomyMode: AutonomyMode;
  /** Per-turn project + user permission rules (loaded from .agent/settings.json).
   *  Session-scoped rules live in the rules module and are read separately. */
  permissionRules: RuleSet;
  modelId: string;
  provider: Provider;
  compactionSettings: CompactionSettings;
  /** Fold tool/sub-agent usage back into the parent turn's totals. */
  onUsage: (u: Usage) => void;
  /** Emit an IPC event to the renderer (part-shaped). */
  emit: ToolEmit;
  /** Surface a sub-agent's internal tool-call lifecycle as nested AgentEvents.
   *  Set by the orchestrator on the top-level ctx; sub-agents call this for
   *  each tool part they iterate. Undefined on legacy/contexts that don't
   *  support sub-agent event streaming (sub-agent tools stay invisible). */
  emitToolEvent?: EmitToolEvent;
  /** Abort signal for the parent turn — checked by long-running tools. */
  abortSignal: AbortSignal;
  /** The parent turn's thinking level — sub-agents inherit this as their
   *  default unless the agent definition overrides via AgentDef.thinkingLevel. */
  thinkingLevel?: ThinkingLevel;
  /** Recursion depth for sub-agent dispatch. 0 = main orchestrator, 1+ = nested.
   *  Used to prevent infinite agent-spawns-agent chains. */
  _depth?: number;
}
