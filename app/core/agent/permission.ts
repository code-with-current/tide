/** Permission gate (design doc §5): decide auto/ask/blocked from a tool's risk tier and the session's autonomy mode. With no worktree isolation, the autonomy mode IS the consent: plan=read-only, ask=reads auto + writes/destructive prompt, edit=reads+writes auto + destructive prompt, full=trust all. */

import type { AutonomyMode, RiskTier } from '../../../src/types/index';

export type GateDecision = 'auto' | 'ask' | 'blocked';

export function checkPermission(
  riskTier: RiskTier,
  autonomyMode: AutonomyMode,
): GateDecision {
  switch (autonomyMode) {
    case 'plan':
      // Plan blocks all mutation outright. Reads still auto.
      return riskTier === 'read_only' ? 'auto' : 'blocked';

    case 'ask':
      return riskTier === 'read_only' ? 'auto' : 'ask';

    case 'edit':
      // Edit auto-runs writes (file edits) but still prompts for destructive
      // ops (shell, git mutations) — those have wider blast radius.
      return riskTier === 'read_only' || riskTier === 'write' ? 'auto' : 'ask';

    case 'full':
      // Full = full trust. No prompts.
      return 'auto';

    default:
      return 'ask';
  }
}

/** Human-readable label for a (riskTier, mode) decision — for UI badges. */
export function gateLabel(decision: GateDecision): string {
  switch (decision) {
    case 'auto':
      return 'auto-approved';
    case 'ask':
      return 'needs approval';
    case 'blocked':
      return 'blocked by mode';
  }
}
