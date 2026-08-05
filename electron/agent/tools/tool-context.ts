/** Per-turn context bound into every tool factory via closure (the SDK's execute only gets {messages, toolCallId, abortSignal}; everything Tide-specific rides through here). Mutable fields (autonomyMode, compactionSettings) may change mid-turn — read at execution time, not factory-build time. */

import type { Provider, Usage, AutonomyMode } from '../../../src/types';
import type { CompactionSettings } from '../../../src/types/compaction';
import type { RuleSet } from '../permissions/rules.js';

/** Minimal emit signature — the orchestrator injects a part-shaped event. */
export type ToolEmit = (event: unknown) => void;

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
  /** Abort signal for the parent turn — checked by long-running tools. */
  abortSignal: AbortSignal;
  /** Recursion depth for sub-agent dispatch. 0 = main orchestrator, 1+ = nested.
   *  Used to prevent infinite agent-spawns-agent chains. */
  _depth?: number;
}
