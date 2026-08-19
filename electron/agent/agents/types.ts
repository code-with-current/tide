/** Embedded sub-agent definition contract: a named, specialized system prompt dispatched via the `dispatch_agent` tool. Single-shot (no allowedTools → one LLM call) or multi-step (has allowedTools → streamText loop with stopWhen, recursive up to MAX_AGENT_DEPTH). All inherit the parent turn's provider/model/permissions/signal. */

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
  /** Thinking level override for this agent. Default 'low' — sub-agents are
   *  focused specialists that don't need deep reasoning. */
  thinkingLevel?: import('../../../src/types/index.js').ThinkingLevel;
  /** Agent names this agent may dispatch via dispatch_agent. `'all'` allows
   *  any. Absent = cannot dispatch (dispatch_agent is stripped from its
   *  toolset — declarative recursion, ported from opencode's model where no
   *  built-in subagent can spawn subagents unless explicitly granted). */
  canDispatch?: string[] | 'all';
  /** Hide from the renderer @mention catalog while remaining dispatchable. */
  hidden?: boolean;
}
