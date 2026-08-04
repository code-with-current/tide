import { createContext, useContext } from 'react';
import type { ToolCall } from '@/types';

/**
 * Inline-permission surface. Provided by TurnBlock (which has the session's
 * `permissionRequest` + approve/reject callbacks); consumed by OneCodeToolRow
 * so each pending tool row can render its own `<PermissionCard>` without
 * prop-drilling through BlockList → ProcessSection.
 */
export interface PermissionSurface {
  /** Pending permission entries keyed by toolCallId (real ids). */
  byId: Map<string, ToolCall>;
  /** Orchestrator auto-reject deadline. */
  timeoutAt?: number;
  onApprove?: (
    id: string,
    newMode?: 'plan' | 'ask' | 'edit' | 'full',
    remember?: boolean,
  ) => void;
  onReject?: (id: string, reason?: string) => void;
}

export const PermissionSurfaceContext = createContext<PermissionSurface | null>(null);

export function usePermissionSurface(): PermissionSurface | null {
  return useContext(PermissionSurfaceContext);
}
