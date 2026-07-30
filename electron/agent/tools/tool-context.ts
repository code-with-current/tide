/**
 * Per-turn context bound into every tool factory via closure. The SDK's
 * execute only receives { messages, toolCallId, abortSignal } — anything
 * Tide-specific rides through here.
 *
 * Mutable fields (autonomyMode, compactionSettings) may change mid-turn
 * after permission escalation or settings edits. Tools that read these
 * should do so at execution time, not at factory-build time.
 */

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
}
