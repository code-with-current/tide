/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/permissionAutoAccept.ts — ADAPTED.
 *  Upstream's file contains only the composer's auto-accept toggle
 *  (PermissionAutoAcceptToggleArgs + togglePermissionAutoAccept), which is excluded
 *  from the port (composer out of scope per Ruling 2). The piece Task 5 needs is the
 *  remember-decision computation: mapping a card action onto the exact argument
 *  shape Tide's onApproveToolCalls/onRejectToolCalls callbacks accept. Rewritten for
 *  that contract; no upstream logic survives verbatim. */

import type { AutonomyMode } from '@/types';

export type PermissionCardAction = 'once' | 'always' | 'reject';

export interface PermissionDecision {
  kind: 'approve' | 'reject';
  /** 'always' approvals add a permission rule instead of a one-shot allow. */
  remember?: boolean;
  /** Mode escalation is offered by the host (T8), never computed here. */
  newMode?: AutonomyMode;
  /** Optional rejection reason surfaced to the model. */
  reason?: string;
}

export function getPermissionDecision(action: PermissionCardAction): PermissionDecision {
  switch (action) {
    case 'once':
      return { kind: 'approve', remember: false };
    case 'always':
      return { kind: 'approve', remember: true };
    case 'reject':
      return { kind: 'reject', reason: undefined };
  }
}
