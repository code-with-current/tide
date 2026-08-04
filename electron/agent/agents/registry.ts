/**
 * Built-in agent catalog — dynamically built from MD files.
 *
 * Agents are defined in src/lib/prompts/agents/*.md. Each .md file has
 * frontmatter (name, description, whenToUse) + the agent's system prompt.
 * At build time, build/promptMarkdownUtils.mjs bundles them into
 * _agent-prompts-bundle.ts. This module just maps the bundle onto AgentDef.
 *
 * To add a new agent: drop a .md file in src/lib/prompts/agents/ and rebuild.
 * No code changes needed.
 *
 * Consumed by:
 * - `dispatch_agent` tool (executor looks up the agent by name)
 * - main system prompt (15-builtin-agents.md advertises whenToUse hints)
 * - renderer `@mention` catalog (via the `tide:listAgents` IPC)
 */

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
