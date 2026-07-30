/**
 * Risk metadata sidecar — keyed by tool name. The SDK has no concept of
 * risk tiers, autonomy modes, or categories; this map is read by:
 *
 *   - withPermission (auto/ask/blocked decision per autonomy mode)
 *   - ProcessSection / EditsSection (categorization for the UI)
 *   - ToolCallCard (timeout enforcement via Promise.race)
 *
 * Values transcribed from the per-tool ToolRegistration objects that
 * existed pre-migration. Keep in sync with the tool factories in this
 * directory — the test enumerates the expected keys.
 *
 * Categories mirror the sets in `src/lib/stream/blockState.ts`
 * (COMMAND_TOOLS / EDIT_TOOLS / EXPLORATION_TOOLS) so the UI's existing
 * grouping logic continues to work without refactoring.
 */

import type { AutonomyMode, RiskTier, ToolName } from '../../../src/types';

export type ToolCategory = 'commands' | 'edits' | 'exploration' | 'other';

export interface ToolMeta {
  riskTier: RiskTier;
  autoApproveIn: AutonomyMode[];
  /** Max wall-clock ms before the orchestrator cancels the execute. */
  timeoutMs: number;
  category: ToolCategory;
}

const ALL_MODES: AutonomyMode[] = ['plan', 'ask', 'edit', 'full'];
const WRITE_MODES: AutonomyMode[] = ['edit', 'full'];
const FULL_ONLY: AutonomyMode[] = ['full'];

export const toolMeta: Record<ToolName, ToolMeta> = {
  // ─── Commands ───────────────────────────────────────────────────────
  bash:          { riskTier: 'destructive', autoApproveIn: FULL_ONLY, timeoutMs: 120_000, category: 'commands' },
  bash_output:   { riskTier: 'read_only',   autoApproveIn: ALL_MODES, timeoutMs: 5_000,   category: 'commands' },
  kill_shell:    { riskTier: 'write',       autoApproveIn: WRITE_MODES, timeoutMs: 5_000, category: 'commands' },
  git:           { riskTier: 'destructive', autoApproveIn: FULL_ONLY, timeoutMs: 30_000,  category: 'commands' },

  // ─── Edits ──────────────────────────────────────────────────────────
  edit_file:     { riskTier: 'write',       autoApproveIn: WRITE_MODES, timeoutMs: 30_000, category: 'edits' },
  multi_edit:    { riskTier: 'write',       autoApproveIn: WRITE_MODES, timeoutMs: 60_000, category: 'edits' },
  write_file:    { riskTier: 'write',       autoApproveIn: WRITE_MODES, timeoutMs: 30_000, category: 'edits' },
  notebook_edit: { riskTier: 'write',       autoApproveIn: WRITE_MODES, timeoutMs: 30_000, category: 'edits' },

  // ─── Exploration (read-only) ────────────────────────────────────────
  read_file:     { riskTier: 'read_only',   autoApproveIn: ALL_MODES, timeoutMs: 10_000,  category: 'exploration' },
  list_dir:      { riskTier: 'read_only',   autoApproveIn: ALL_MODES, timeoutMs: 5_000,   category: 'exploration' },
  glob:          { riskTier: 'read_only',   autoApproveIn: ALL_MODES, timeoutMs: 10_000,  category: 'exploration' },
  grep:          { riskTier: 'read_only',   autoApproveIn: ALL_MODES, timeoutMs: 10_000,  category: 'exploration' },
  web_fetch:     { riskTier: 'read_only',   autoApproveIn: ALL_MODES, timeoutMs: 15_000,  category: 'exploration' },
  web_search:    { riskTier: 'read_only',   autoApproveIn: ALL_MODES, timeoutMs: 12_000,  category: 'exploration' },

  // ─── Other (metadata / planning / dispatch) ─────────────────────────
  todo_write:          { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 1_000,    category: 'other' },
  ask_followup_question: { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 600_000, category: 'other' },
  exit_plan_mode:      { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 1_000,    category: 'other' },
  compact:             { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 1_000,    category: 'other' },
  slash_command:       { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 30_000,   category: 'other' },
  load_skill:          { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 5_000,    category: 'other' },
  dispatch_agent:      { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 120_000,  category: 'other' },
  mcp:                 { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 30_000,   category: 'other' },

  // ─── Memory (new — always auto-approve; confined to .agent/memories) ─
  // Special case in the autonomy matrix: writes don't touch user code,
  // so gating them would defeat the purpose. Path-safety.ts enforces
  // confinement at execute time.
  memory:              { riskTier: 'read_only', autoApproveIn: ALL_MODES, timeoutMs: 5_000, category: 'other' },
};

export function getToolMeta(name: ToolName): ToolMeta {
  const m = toolMeta[name];
  if (!m) throw new Error(`Unknown tool: ${name}`);
  return m;
}
