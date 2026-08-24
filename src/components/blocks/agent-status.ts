/** Live status of a dispatch_agent row (chat dispatch rows and the Agents
 *  panel header share it). Background dispatches keep running after the
 *  parent turn ends — their display carries the authoritative
 *  backgroundState, not the tool status. */
import type { ToolCall } from '@/types';

export type AgentStatus = 'running' | 'done' | 'error' | 'interrupted';

/** Composed sub-agent session title — mirrors the runtime's child-session
 *  naming (electron/agent/agents/runtime.ts createDispatchSession:
 *  `${title ?? agent.name} (@${agent.name})`) so chat rows and the Agents
 *  panel header show the same name the session is stored under. */
export function agentSessionDisplayName(agentName: string, title?: string): string {
  return `${title ?? agentName} (@${agentName})`;
}

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
