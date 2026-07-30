/**
 * Permission gate — design doc §5.
 *
 * Given a tool's risk tier and the session's autonomy mode, decide whether
 * the tool runs automatically, needs approval, or is blocked outright.
 *
 * Scope note: Tide has NO worktree isolation today (design doc §6 not built).
 * That means write/destructive tools hit the user's real working tree. The
 * autonomy mode IS the consent — the user explicitly picks the mode knowing
 * this. So:
 *
 *   plan  → read tools only (writes blocked outright; the tool set sent to
 *           the model is already filtered, this is defense in depth)
 *   ask   → reads auto, writes/destructive prompt
 *   edit  → reads + writes auto, destructive prompts
 *   full  → everything auto (user opted into full trust)
 *
 * If you want a "asks even in full mode" escape hatch later, add a separate
 * per-session flag — don't overload the autonomy mode.
 */

import type { AutonomyMode, RiskTier } from '../../src/types/index';

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
