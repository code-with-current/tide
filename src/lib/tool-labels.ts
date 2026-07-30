/**
 * Human-friendly labels for tool names.
 *
 * Tool names from the model are snake_case identifiers (read_file, edit_file,
 * dispatch_agent). These map to short, verb-based labels that read naturally
 * in the UI card headers:
 *
 *   📝 Read    src/index.ts
 *   ✏️  Edit    src/index.ts
 *   ▶️  Run     npm test
 *   🤖 Agent   explore
 *
 * Design principles:
 *   - Short (1-2 words) — fits next to the arg preview in a compact card
 *   - Action-oriented verb — what the tool DID, not what it's called internally
 *   - Merge similar tools (glob + grep → "Search") — users don't distinguish
 *   - Preserve domain terms (git, MCP) — expanding them is worse
 *
 * For streaming/pending tools, `toolLabel` appends "-ing" for the live view,
 * with per-tool overrides for irregular forms (e.g. "Run" → "Running", not
 * "Runing"; "Dispatch" → "Dispatching").
 */

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

/**
 * Per-tool overrides for the progressive ("-ing") form. Most labels can be
 * derived automatically (Read → Reading, Edit → Editing), but some need
 * explicit forms because:
 *   - The base ends in a consonant that doesn't take -ing cleanly
 *     (Run → "Running" not "Runing")
 *   - The label is multi-word and only the verb inflects
 *     (Dispatch Agent → "Dispatching Agent")
 *   - The label doesn't inflect at all (Plan Ready, Git, MCP)
 */
const TOOL_PROGRESSIVE: Record<string, string> = {
  bash: 'Running',
  kill_shell: 'Stopping',
  dispatch_agent: 'Dispatching Agent',
  git: 'Git',         // no progressive — "Git" reads fine while running
  exit_plan_mode: 'Plan Ready',
  mcp: 'MCP',
  ask_followup_question: 'Asking',
};

/**
 * Parse an MCP namespaced tool name into a display label.
 *
 * MCP tools arrive from the agent stream under names of the form
 * `mcp__<server>__<tool>` (see electron/agent/mcp/toolset.ts, which mints
 * those keys at AI-SDK tool-registration time). The bare `mcp` entry in
 * TOOL_LABELS handles the legacy catch-all; this helper gives each server's
 * tool a distinct, readable header:
 *
 *   "mcp__github__create_issue"   → "github · create issue"
 *   "mcp__linear__list_teams"     → "linear · list teams"
 *
 * The server segment keeps its raw casing (server names are user-defined and
 * case-meaningful on some transports); only hyphens become spaces. The tool
 * segment gets underscores → spaces (matching the rest of this module's
 * snake_case → display convention).
 *
 * Returns null for anything that isn't an `mcp__server__tool` triple so the
 * caller can fall through to the built-in label table.
 */
export function mcpToolLabel(namespacedName: string): string | null {
  // `[^_]+` for the server segment would split on underscores in server names
  // (some MCP servers DO contain them), but the registration key we match here
  // is always `mcp__<server>__<tool>` with a fixed `__` separator, and the SDK
  // contract forbids `__` inside either segment. A greedy `[^_]+` would break
  // on single-underscore server names, so we accept everything up to the next
  // `__` boundary by matching `([^_]+)` after the first `mcp__` and capturing
  // the remainder up to end. This matches what toolset.ts emits.
  const match = namespacedName.match(/^mcp__([^_]+)__(.+)$/);
  if (!match) return null;
  const server = match[1].replace(/-/g, ' ');
  const tool = match[2].replace(/_/g, ' ');
  return `${server} · ${tool}`;
}


/**
 * Get the human-friendly label for a tool name.
 * Falls back to the raw name with underscores replaced by spaces.
 *
 * @param toolName  The snake_case tool identifier.
 * @param status    Optional status — when 'running' or 'pending', uses the
 *                  progressive ("-ing") form for the live streaming view.
 */
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
