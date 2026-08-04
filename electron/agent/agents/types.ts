/**
 * Embedded sub-agent definition contract.
 *
 * An agent is a named, specialized system prompt. The main orchestrator
 * dispatches it via the `dispatch_agent` tool. Agents come in two flavors:
 *
 *   - **Single-shot** (no `allowedTools`): one LLM call, no tools, returns
 *     a report. Used for analysis, planning, research, design.
 *
 *   - **Multi-step** (has `allowedTools`): gets its own tool-call loop via
 *     `streamText` with `stopWhen`. Can read files, search code, and even
 *     dispatch its own sub-agents (recursive, up to MAX_AGENT_DEPTH).
 *
 * All agents inherit the parent turn's provider, model, permissions, and
 * abort signal. Permission gates apply to every tool call inside sub-agents.
 */

export interface AgentDef {
  /** Stable identifier — matches the `name` field in the dispatch_agent enum. */
  name: string;
  /** One-line summary shown in the dispatch_agent tool schema. */
  description: string;
  /** Hint surfaced in the main system prompt so the model knows when to dispatch. */
  whenToUse: string;
  /** The agent's role prompt. Self-contained — no template substitution. */
  systemPrompt: string;
  /** Tools this agent can use. If omitted/empty, agent is single-shot (no tools).
   *  If present, agent gets its own multi-step tool loop via streamText.
   *  Include 'dispatch_agent' for recursive delegation capability. */
  allowedTools?: string[];
  /** Max tool-call steps for multi-step agents. Default 10. */
  maxSteps?: number;
  /** Thinking budget override (tokens). Default 4096. */
  thinkingBudget?: number;
}
