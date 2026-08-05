/** Human-friendly labels for tool names. Maps snake_case IDs to short UI labels. */

/** Base label (completed state) for each tool. */
const TOOL_LABELS: Record<string, string> = {
  // File system
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'Edit',
  list_dir: 'List',
  notebook_edit: 'Edit',
  // Shell
  bash: 'Run',
  bash_output: 'Shell',
  kill_shell: 'Stop',
  git: 'Git',
  // Search
  glob: 'Search',
  grep: 'Search',
  web_fetch: 'Fetch',
  web_search: 'Search',
  // Agent system
  dispatch_agent: 'Dispatch Agent',
  load_skill: 'Skill',
  // Planning / meta
  todo_write: 'Plan',
  ask_followup_question: 'Ask',
  exit_plan_mode: 'Plan Ready',
  compact: 'Compact',
  slash_command: 'Command',
  // External
  mcp: 'MCP',
  memory: 'Memory',
};

/** Per-tool overrides for the progressive ("-ing") form (irregulars + multi-word). */
const TOOL_PROGRESSIVE: Record<string, string> = {
  bash: 'Running',
  kill_shell: 'Stopping',
  dispatch_agent: 'Dispatching Agent',
  git: 'Git',         // no progressive — "Git" reads fine while running
  exit_plan_mode: 'Plan Ready',
  mcp: 'MCP',
  ask_followup_question: 'Asking',
};

/** Parse `mcp__<server>__<tool>` into `"server · tool"` display label. Returns null if not MCP. */
export function mcpToolLabel(namespacedName: string): string | null {
  // Split on the fixed `__` separator (the SDK contract forbids `__` inside either segment). `[^_]+` after `mcp__` captures the server; the rest is the tool name. Matches what toolset.ts emits.
  const match = namespacedName.match(/^mcp__([^_]+)__(.+)$/);
  if (!match) return null;
  const server = match[1].replace(/-/g, ' ');
  const tool = match[2].replace(/_/g, ' ');
  return `${server} · ${tool}`;
}


/** Get the human-friendly label for a tool name. Falls back to raw name with spaces. */
export function toolLabel(toolName: string, status?: string): string {
  // MCP namespaced tools (mcp__server__tool) get a dedicated "server · tool"
  // label — checked first so they bypass the built-in table entirely. Returns
  // null for non-MCP names, in which case we fall through to the table lookup.
  const mcpLabel = mcpToolLabel(toolName);
  if (mcpLabel) return mcpLabel;

  const base = TOOL_LABELS[toolName] ?? toolName.replace(/_/g, ' ');

  if (status === 'running' || status === 'pending') {
    // Use explicit progressive form if defined (handles irregulars + multi-word).
    if (TOOL_PROGRESSIVE[toolName]) {
      return TOOL_PROGRESSIVE[toolName];
    }
    // Auto-derive: drop trailing 'e' (Read → Reading), else append -ing.
    if (base.endsWith('e') && base.length > 2 && !base.endsWith('ee')) {
      return base.slice(0, -1) + 'ing';
    }
    return base + 'ing';
  }

  return base;
}
