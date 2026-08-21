/** Per-turn context bound into every tool factory via closure (the SDK's execute only gets {messages, toolCallId, abortSignal}; everything Tide-specific rides through here). Mutable fields (autonomyMode, compactionSettings) may change mid-turn — read at execution time, not factory-build time. */

import type { Provider, Usage, AutonomyMode, ThinkingLevel } from '../../../src/types';
import type { CompactionSettings } from '../../../src/types/compaction';
import type { RuleSet } from '../permissions/rules.js';

/** Minimal emit signature — the orchestrator injects a part-shaped event. */
export type ToolEmit = (event: unknown) => void;

/** Callback a sub-agent uses to surface its internal stream as real
 *  (nested) AgentEvents. The orchestrator injects this when building the
 *  top-level ToolContext; sub-agents read it and call it per part. Each event
 *  is an AgentEvent-shaped object (without seq — the bridge assigns one).
 *  Tool lifecycle events carry toolCallId; narration/thinking forwards
 *  text/reasoning deltas with the SDK part's stable block id instead. */
export type EmitToolEvent = (event: {
  type: 'tool_call_start' | 'tool_call_delta' | 'tool_call' | 'tool_executing' | 'tool_result' | 'delta' | 'reasoning';
  parentToolCallId: string;
  toolCallId?: string;
  toolName?: string;
  delta?: string;
  /** Full text of a 'delta' (sub-agent narration) part. */
  text?: string;
  /** SDK part id — the text/reasoning block id consecutive deltas share. */
  blockId?: string;
  arguments?: Record<string, unknown>;
  argPreview?: string;
  riskTier?: import('../../../../src/types/index.js').RiskTier;
  status?: import('../../../../src/types/index.js').ToolCallStatus;
  output?: string;
  display?: import('../../../../src/types/index.js').ToolDisplay;
  durationMs?: number;
  meta?: string;
}) => void;

/** One skill from the workspace scan, for the load_skill tool-description catalog. */
export interface SkillSummary {
  name: string;
  description: string;
  absPath: string;
}

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
  /** Set on sub-agent contexts: the AgentDef of the running sub-agent.
   *  Lets dispatch_agent enforce the parent's canDispatch list. */
  _agentDef?: import('../agents/types.js').AgentDef;
  /** Enabled skills for this workspace (project + user, disabled filtered out).
   *  Rendered into the load_skill tool-description catalog so the model can
   *  discover and reach for skills autonomously. Undefined on sub-agent
   *  contexts — sub-agents don't get the catalog. */
  skills?: SkillSummary[];
}
