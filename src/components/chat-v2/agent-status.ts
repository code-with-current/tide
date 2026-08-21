/** Live status of a dispatch_agent row (chat dispatch rows and the Agents
 *  panel header share it). Background dispatches keep running after the
 *  parent turn ends — their display carries the authoritative
 *  backgroundState, not the tool status. */
import type { ToolCall } from '@/types';

export type AgentStatus = 'running' | 'done' | 'error' | 'interrupted';

export function agentStatusOf(call: {
  status: ToolCall['status'];
  display?: ToolCall['display'];
}): AgentStatus {
  const d = call.display?.kind === 'agent' ? call.display : undefined;
  if (d?.background) {
    if (d.backgroundState === 'completed') return 'done';
    if (d.backgroundState === 'error') return 'error';
    if (d.backgroundState === 'interrupted') return 'interrupted';
    return 'running';
  }
  switch (call.status) {
    case 'executed':
      return 'done';
    case 'failed':
    case 'rejected':
      return 'error';
    case 'aborted':
      return 'interrupted';
    default:
      return 'running';
  }
}
