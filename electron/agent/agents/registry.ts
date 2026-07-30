/**
 * Built-in agent catalog.
 *
 * Single source of truth for the 8 embedded sub-agents. Consumed by:
 * - `dispatch_agent` tool (executor looks up the agent by name)
 * - main system prompt (`# Agents` block advertises `whenToUse` hints)
 * - renderer `@mention` catalog (via the `tide:listAgents` IPC)
 *
 * Order matters: it's how the agents appear in the model's system prompt
 * and the @mention picker. Research/analysis agents first (the most commonly
 * dispatched), then the coordination specialists.
 */

import type { AgentDef } from './types';
import {
  GENERAL_PURPOSE_PROMPT,
  EXPLORE_PROMPT,
  WORKFLOW_ORCHESTRATOR_PROMPT,
  TASK_DISTRIBUTOR_PROMPT,
  MULTI_AGENT_COORDINATOR_PROMPT,
  AGENT_ORGANIZER_PROMPT,
  CODEBASE_ORCHESTRATOR_PROMPT,
  CONTEXT_MANAGER_PROMPT,
} from './prompts';

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: 'general-purpose',
    description: 'General-purpose analyst for research, multi-step reasoning, and synthesis from provided context.',
    whenToUse: 'Multi-step research or analysis that needs careful reasoning across the provided context. Use when no narrower specialty fits.',
    systemPrompt: GENERAL_PURPOSE_PROMPT,
  },
  {
    name: 'explore',
    description: 'Read-only code locator. Proposes precise search strategies (glob/grep patterns) and synthesizes search results into locations.',
    whenToUse: 'Finding files, symbols, or call sites across the codebase. Returns locations and concrete search commands — not full reviews.',
    systemPrompt: EXPLORE_PROMPT,
  },
  {
    name: 'workflow-orchestrator',
    description: 'Designs state-machine workflows: states, transitions, error handling, compensation, and recovery.',
    whenToUse: 'Designing or reviewing a business-process workflow, state machine, or multi-step orchestration with failure recovery.',
    systemPrompt: WORKFLOW_ORCHESTRATOR_PROMPT,
  },
  {
    name: 'task-distributor',
    description: 'Designs work allocation: queues, load balancing, priority scheduling, capacity tracking.',
    whenToUse: 'Designing or analyzing a task queue, worker pool, or scheduling system where fairness and throughput matter.',
    systemPrompt: TASK_DISTRIBUTOR_PROMPT,
  },
  {
    name: 'multi-agent-coordinator',
    description: 'Designs coordination across many agents: communication, dependencies, parallelism, fault tolerance.',
    whenToUse: 'Coordinating multiple agents/workers that communicate, share state, or have dependencies. Deadlock and race analysis.',
    systemPrompt: MULTI_AGENT_COORDINATOR_PROMPT,
  },
  {
    name: 'agent-organizer',
    description: 'Decomposes a complex task into subtasks and assigns the right agent to each. Team assembly + sequencing.',
    whenToUse: 'Planning a multi-agent engagement: which agents to use, in what order, for which subtask.',
    systemPrompt: AGENT_ORGANIZER_PROMPT,
  },
  {
    name: 'codebase-orchestrator',
    description: 'Refactor governance with weighted risk priorities and approval gates. Maps the repo, flags issues, proposes safe diffs.',
    whenToUse: 'Repo-wide refactor planning, structural-debt audit, or any change that needs a risk-weighted approval loop before execution.',
    systemPrompt: CODEBASE_ORCHESTRATOR_PROMPT,
  },
  {
    name: 'context-manager',
    description: 'Designs shared-state systems: storage, retrieval, synchronization, access control, lifecycle.',
    whenToUse: 'Designing how shared context/state is stored, retrieved, kept consistent, and governed across agents or services.',
    systemPrompt: CONTEXT_MANAGER_PROMPT,
  },
];

/** Look up an agent by name. Returns undefined for unknown names. */
export function getAgent(name: string): AgentDef | undefined {
  return BUILTIN_AGENTS.find((a) => a.name === name);
}

/** Stable list of agent names — used to build the dispatch_agent tool's enum. */
export function agentNames(): string[] {
  return BUILTIN_AGENTS.map((a) => a.name);
}
