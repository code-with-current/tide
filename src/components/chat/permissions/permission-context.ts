import { createContext, useContext } from 'react';
import type { ToolCall } from '@/types';

/** Inline-permission surface: provided by TurnBlock (carries the session's permissionRequest + approve/reject callbacks) and consumed by ToolRow so each pending row renders its own PermissionCard without prop-drilling. */
export interface PermissionSurface {
  /** Pending permission entries keyed by toolCallId (real ids). */
  byId: Map<string, ToolCall>;
  /** Orchestrator auto-reject deadline. */
  timeoutAt?: number;
  onApprove?: (
    id: string,
    newMode?: 'plan' | 'ask' | 'edit' | 'full',
    remember?: boolean | 'session',
  ) => void;
  onReject?: (id: string, reason?: string) => void;
}

export const PermissionSurfaceContext = createContext<PermissionSurface | null>(null);

export function usePermissionSurface(): PermissionSurface | null {
  return useContext(PermissionSurfaceContext);
}
