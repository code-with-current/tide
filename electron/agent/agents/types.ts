/**
 * Embedded sub-agent definition contract.
 *
 * An agent is a named, specialized system prompt. The main orchestrator
 * dispatches it via the `dispatch_agent` tool; the agent makes a single
 * LLM call with its prompt + the caller's task and returns the answer.
 *
 * All built-in agents are single-shot (one LLM call, no tools). The main
 * orchestrator keeps doing actual file operations; sub-agents analyze,
 * plan, research, and report.
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
}
