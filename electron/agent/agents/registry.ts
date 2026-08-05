/** Built-in agent catalog built from src/lib/prompts/agents/*.md (bundled at build time into _agent-prompts-bundle.ts by build/promptMarkdownUtils.mjs). Add a .md file + rebuild to add an agent. Consumed by dispatch_agent, the main system prompt, and the renderer @mention catalog. */

import type { AgentDef } from './types';
import { BUNDLED_AGENTS } from './prompts';

export const BUILTIN_AGENTS: AgentDef[] = BUNDLED_AGENTS.map((a) => ({
  name: a.name,
  description: a.description,
  whenToUse: a.whenToUse,
  systemPrompt: a.systemPrompt,
  allowedTools: a.allowedTools?.length ? a.allowedTools : undefined,
  maxSteps: a.maxSteps,
  thinkingBudget: a.thinkingBudget,
}));

/** Look up an agent by name. Returns undefined for unknown names. */
export function getAgent(name: string): AgentDef | undefined {
  return BUILTIN_AGENTS.find((a) => a.name === name);
}

/** Stable list of agent names — used to build the dispatch_agent tool's enum. */
export function agentNames(): string[] {
  return BUILTIN_AGENTS.map((a) => a.name);
}
