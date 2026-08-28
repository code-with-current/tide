import type { AutonomyMode } from '@/types';

export type PermissionCardAction = 'once' | 'always' | 'reject';

export interface PermissionDecision {
  kind: 'approve' | 'reject';
  /** 'always' approvals add a permission rule instead of a one-shot allow. */
  remember?: boolean;
  /** Mode escalation is offered by the host, never computed here. */
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
