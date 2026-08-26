/** Built-in agent catalog built from src/lib/prompts/agents/*.md (bundled at build time into _agent-prompts-bundle.ts by build/promptMarkdownUtils.mjs). Add a .md file + rebuild to add an agent. Consumed by dispatch_agent, the main system prompt, and the renderer @mention catalog. */

import type { AgentDef } from './types';
import { BUNDLED_AGENTS } from './prompts';
import { toolMeta } from '../tools/tool-meta.js';
import type { RiskTier, ToolName } from '../../../../src/types/index.js';

export const BUILTIN_AGENTS: AgentDef[] = BUNDLED_AGENTS.map((a) => ({
  name: a.name,
  description: a.description,
  whenToUse: a.whenToUse,
  systemPrompt: a.systemPrompt,
  allowedTools: a.allowedTools?.length ? a.allowedTools : undefined,
  maxSteps: a.maxSteps,
  thinkingLevel: a.thinkingLevel as import('../../../../src/types/index.js').ThinkingLevel | undefined,
  canDispatch: a.canDispatch === 'all' || (a.canDispatch?.length ?? 0) > 0 ? a.canDispatch : undefined,
  hidden: a.hidden,
}));

/** Look up an agent by name. Returns undefined for unknown names. */
export function getAgent(name: string): AgentDef | undefined {
  return BUILTIN_AGENTS.find((a) => a.name === name);
}

/** Stable list of agent names — used to build the dispatch_agent tool's enum. */
export function agentNames(): string[] {
  return BUILTIN_AGENTS.map((a) => a.name);
}

const RISK_RANK: Record<RiskTier, number> = { read_only: 0, write: 1, destructive: 2 };

/** The effective risk of dispatching this agent: the highest risk tier
 *  among its allowedTools. Drives the plan-mode dispatch gate — a parent
 *  in plan mode must not be able to spawn an agent that can write or run
 *  shell commands without an explicit escalation. */
export function agentRiskTier(agent: AgentDef): RiskTier {
  let rank = 0;
  for (const t of agent.allowedTools ?? []) {
    const meta = toolMeta[t as ToolName];
    if (meta) rank = Math.max(rank, RISK_RANK[meta.riskTier] ?? 0);
  }
  return rank >= 2 ? 'destructive' : rank === 1 ? 'write' : 'read_only';
}

/** May `agent` dispatch `target`? False unless canDispatch explicitly grants it. */
export function canDispatchTo(agent: AgentDef, target: string): boolean {
  if (!agent.canDispatch) return false;
  if (agent.canDispatch === 'all') return true;
  return agent.canDispatch.includes(target);
}

/** The tool list a child built from this agent actually gets — includes
 *  dispatch_agent only when canDispatch grants it (declarative recursion:
 *  capability rides on canDispatch, not on the raw allowedTools list), and
 *  strips any stray dispatch_agent otherwise (remove-don't-fail: the model
 *  never sees a tool it is not allowed to call). */
export function effectiveChildTools(agent: AgentDef): string[] {
  const tools = agent.allowedTools ?? [];
  if (agent.canDispatch) {
    return tools.includes('dispatch_agent') ? tools : [...tools, 'dispatch_agent'];
  }
  return tools.filter((t) => t !== 'dispatch_agent');
}
