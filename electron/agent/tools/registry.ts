/**
 * Tool registry — single map of name → registration.
 *
 * The orchestrator calls `getToolDefinitions()` to build the request body
 * sent to the model, and `executeTool()` to dispatch a model-emitted call.
 *
 * Tools are grouped by capability:
 *   - File system: read_file, list_dir, glob, grep, edit_file, multi_edit,
 *     write_file, notebook_edit
 *   - Shell: bash, bash_output, kill_shell, git
 *   - Web: web_fetch, web_search
 *   - Agent system: dispatch_agent (sub-agents), todo_write (planning),
 *     ask_followup_question (structured Q), exit_plan_mode, compact,
 *     slash_command (user-defined macros)
 *
 * The `mcp` tool name is reserved but unregistered; when MCP lands, its
 * tools will be added dynamically per-server.
 *
 * Migration state (Phase 2 → Phase 3): the legacy `REGISTRY` map and its
 * helpers (`getToolDefinitions`, `executeTool`, etc.) stay until the
 * Phase 3 orchestrator rewrite deletes them. The new SDK-driven path
 * uses `buildToolset(ctx)` below — only the 5 core tools (bash,
 * read_file, write_file, edit_file, list_dir) have been converted so far.
 * The remaining 15 tools are migrated incrementally; until they land,
 * the orchestrator only advertises the converted subset to the model.
 */

import type { ToolDefinition } from '../../../src/types/index';
import { formatArgPreview } from './types';
import { runWithToolCallId } from './tool-call-context';
import type { ToolContext as LegacyToolContext, ToolRegistration, ToolResult } from './types';
import { readFileTool } from './read-file';
import { listDirTool } from './list-dir';
import { grepTool } from './grep';
import { bashTool } from './bash';
import { editFileTool } from './edit-file';
import { multiEditTool } from './multi-edit';
import { writeFileTool } from './write-file';
import { globTool } from './glob';
import { gitTool } from './git';
import { bashOutputTool, killShellTool } from './background-shell';
import { dispatchAgentTool } from './dispatch-agent';
import { todoWriteTool } from './todo-write';
import { webFetchTool } from './web-fetch';
import { webSearchTool } from './web-search';
import { notebookEditTool } from './notebook-edit';
import { askFollowupTool } from './ask-followup';
import { exitPlanModeTool } from './exit-plan-mode';
import { compactTool } from './compact';
import { slashCommandTool } from './slash-command';
import { directoryTreeTool } from './directory-tree';
import { readMediaFileTool } from './read-media-file';

// New SDK factory imports (Phase 2+). Aliased to avoid colliding with the
// legacy ToolContext shape from ./types.
import { createBashTool } from './bash';
import { createReadFileTool } from './read-file';
import { createListDirTool } from './list-dir';
import { createWriteFileTool } from './write-file';
import { createEditFileTool } from './edit-file';
import { createGlobTool } from './glob';
import { createGrepTool } from './grep';
import { createWebFetchTool } from './web-fetch';
import { createWebSearchTool } from './web-search';
import { createMultiEditTool } from './multi-edit';
import { createNotebookEditTool } from './notebook-edit';
import { createGitTool } from './git';
import { createBashOutputTool, createKillShellTool } from './background-shell';
import { createTodoWriteTool } from './todo-write';
import { createExitPlanModeTool } from './exit-plan-mode';
import { createSlashCommandTool } from './slash-command';
import { createLoadSkillTool } from './load-skill';
import { createDispatchAgentTool } from './dispatch-agent';
import { createAskFollowupTool } from './ask-followup';
import { createCompactTool } from './compact';
import { createDirectoryTreeTool } from './directory-tree';
import { createReadMediaFileTool } from './read-media-file';
import { memoryTool, createMemoryTool } from './memory';
import type { ToolContext as SdkToolContext } from './tool-context';
import { withToolHooks } from '../hooks/with-tool-hooks';
import type { HookConfig } from '../hooks/hook-config';
import { createLogger } from '../../logger.js';

const log = createLogger('tool');

const REGISTRY: Record<string, ToolRegistration> = {
  // File system
  read_file: readFileTool,
  list_dir: listDirTool,
  directory_tree: directoryTreeTool,
  read_media_file: readMediaFileTool,
  glob: globTool,
  grep: grepTool,
  edit_file: editFileTool,
  multi_edit: multiEditTool,
  write_file: writeFileTool,
  notebook_edit: notebookEditTool,
  // Shell
  bash: bashTool,
  bash_output: bashOutputTool,
  kill_shell: killShellTool,
  git: gitTool,
  // Web
  web_fetch: webFetchTool,
  web_search: webSearchTool,
  // Agent system
  dispatch_agent: dispatchAgentTool,
  todo_write: todoWriteTool,
  ask_followup_question: askFollowupTool,
  exit_plan_mode: exitPlanModeTool,
  compact: compactTool,
  slash_command: slashCommandTool,
  memory: memoryTool,
};

/** Definitions to send to the model (shape matches Anthropic's `tools` field). */
export function getToolDefinitions(): ToolDefinition[] {
  return Object.values(REGISTRY).map((reg) => ({
    definition: reg.definition,
    riskTier: reg.riskTier,
    requiresWorktree: reg.requiresWorktree,
    timeoutMs: reg.timeoutMs,
    autoApproveIn: reg.autoApproveIn,
  }));
}

/** Definitions in the wire format Anthropic expects (`name`/`description`/`input_schema`). */
export function getAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}> {
  return Object.values(REGISTRY).map((reg) => reg.definition);
}

export function getRegistration(name: string): ToolRegistration | undefined {
  return REGISTRY[name];
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: LegacyToolContext,
): Promise<ToolResult> {
  const reg = REGISTRY[name];
  if (!reg) {
    log.warn('unknown tool requested', { name });
    return { status: 'failed', output: `Unknown tool: ${name}` };
  }
  // Per-tool timeout via a child signal — the executor reads ctx.timeoutMs.
  const t0 = Date.now();
  try {
    const result = await reg.execute(args, ctx);
    const durationMs = result.durationMs ?? Date.now() - t0;
    log.info('executed', { tool: name, durationMs, status: result.status });
    return {
      durationMs,
      ...result,
    };
  } catch (e: any) {
    log.error('threw', { tool: name, error: e?.message ?? String(e), durationMs: Date.now() - t0 });
    return {
      status: 'failed',
      output: `Tool threw: ${e?.message || String(e)}`,
    };
  }
}

export { formatArgPreview };

// ─── New SDK-driven path (Phase 3+) ────────────────────────────────────

/**
 * Factory map for the new SDK tool path. Each entry is a function that
 * takes the per-turn SdkToolContext (closure-bound) and returns an SDK
 * `tool({ description, inputSchema, execute })`.
 *
 * All 20 built-in tools are now migrated (Phase 2 complete). The SDK
 * orchestrator advertises this full set to the model — feature-parity with
 * the legacy path. `compact` is a deprecation stub (Phase 3 Task 3.6 deletes
 * it and its entry here); `mcp` remains reserved (unregistered, dynamic).
 */
const FACTORIES = {
  bash: createBashTool,
  read_file: createReadFileTool,
  list_dir: createListDirTool,
  directory_tree: createDirectoryTreeTool,
  read_media_file: createReadMediaFileTool,
  write_file: createWriteFileTool,
  edit_file: createEditFileTool,
  glob: createGlobTool,
  grep: createGrepTool,
  web_fetch: createWebFetchTool,
  web_search: createWebSearchTool,
  multi_edit: createMultiEditTool,
  notebook_edit: createNotebookEditTool,
  git: createGitTool,
  bash_output: createBashOutputTool,
  kill_shell: createKillShellTool,
  todo_write: createTodoWriteTool,
  exit_plan_mode: createExitPlanModeTool,
  slash_command: createSlashCommandTool,
  load_skill: createLoadSkillTool,
  dispatch_agent: createDispatchAgentTool,
  ask_followup_question: createAskFollowupTool,
  compact: createCompactTool,
  memory: createMemoryTool,
} as const;

/**
 * Tool name aliases — maps alternative names models may use (learned from
 * other agent frameworks) to Tide's canonical tool names. Without this,
 * models like Gemini call `local_shell_call` (Antigravity's name) instead of
 * `bash`, and the SDK rejects the call with "unavailable tool", wasting the
 * entire turn in a retry loop.
 *
 * Add entries here as new model-specific name mismatches surface. The
 * canonical name always wins (an alias pointing to itself is harmless).
 */
const TOOL_ALIASES: Record<string, string> = {
  // Shell execution
  local_shell_call: 'bash',
  run_shell_command: 'bash',
  execute_bash: 'bash',
  shell: 'bash',
  terminal: 'bash',
  // File operations
  local_file_edit: 'edit_file',
  str_replace_editor: 'edit_file',
  create_file: 'write_file',
  read_file_content: 'read_file',
  file_search: 'glob',
  // Former MCP filesystem server tools → now native built-ins
  'mcp__tide-filesystem__directory_tree': 'directory_tree',
  'mcp__tide-filesystem__read_file': 'read_file',
  'mcp__tide-filesystem__write_file': 'write_file',
  'mcp__tide-filesystem__edit_file': 'edit_file',
  'mcp__tide-filesystem__list_directory': 'list_dir',
  'mcp__tide-filesystem__read_media_file': 'read_media_file',
  'mcp__tide-filesystem__move_file': 'bash',
  'mcp__tide-filesystem__create_directory': 'bash',
  'mcp__tide-filesystem__search_files': 'glob',
  'mcp__tide-filesystem__get_file_info': 'bash',
  // Search
  regex_search: 'grep',
  content_search: 'grep',
  // Web
  browser: 'web_fetch',
  fetch_url: 'web_fetch',
};

/** Resolve a model-supplied tool name to Tide's canonical name. Returns the
 *  input unchanged if no alias exists (the name is already canonical or
 *  genuinely unknown). */
export function resolveToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/** Names of tools currently available via the SDK factory path. */
export const SDK_TOOL_NAMES = Object.keys(FACTORIES) as Array<keyof typeof FACTORIES>;

/**
 * Build the SDK-shaped toolset for a turn. Reads factories + binds the
 * per-turn context via closure. Result is ready to pass to
 * `streamText({ tools })`.
 *
 * Example:
 *
 *   const tools = buildToolset(ctx);
 *   const result = await streamText({ model, messages, tools, maxSteps: 100 });
 */
type AnySdkTool = ReturnType<typeof createBashTool>;
type ToolFactory = (c: SdkToolContext) => AnySdkTool;

export function buildToolset(
  ctx: SdkToolContext,
  hookConfig?: HookConfig | null,
): Record<string, AnySdkTool> {
  const out: Record<string, AnySdkTool> = {};
  // Build a reverse map: canonical name → list of aliases (for the Proxy
  // below). We need this so the Proxy can serve tool definitions under both
  // the canonical name AND its aliases — but only the canonical names are
  // ENUMERATED (Object.keys), which is what the AI SDK uses to build the
  // function declarations sent to the model. Aliases are accessible by direct
  // lookup (out['local_shell_call']) but invisible to enumeration, so the
  // model never sees a duplicate function declaration.
  const aliasesByCanonical: Record<string, string[]> = {};
  for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
    (aliasesByCanonical[canonical] ??= []).push(alias);
  }

  for (const [name, factory] of Object.entries(FACTORIES)) {
    const tool = (factory as ToolFactory)(ctx);
    // Bind the SDK's toolCallId into AsyncLocalStorage so withPermission can
    // read it via currentToolCallId() without each tool threading the param.
    // Each parallel execute gets its own context (no race); the store survives
    // the permission `await`. Spreads keep the rest of the tool (description,
    // inputSchema) intact.
    const origExecute = (tool as unknown as { execute?: (...a: unknown[]) => Promise<unknown> }).execute;
    const bound: AnySdkTool =
      typeof origExecute === 'function'
        ? ({
            ...tool,
            execute: async (args: unknown, execCtx: { toolCallId?: string } = {}) => {
              const _t0 = Date.now();
              const call = () => origExecute(args, execCtx);
              try {
                const r = execCtx.toolCallId
                  ? await runWithToolCallId(execCtx.toolCallId, call)
                  : await call();
                log.info('executed', { tool: name, durationMs: Date.now() - _t0 });
                return r;
              } catch (e: any) {
                log.error('threw', { tool: name, error: e?.message ?? String(e), durationMs: Date.now() - _t0 });
                throw e;
              }
            },
          } as AnySdkTool)
        : tool;
    // Wrap with PreToolUse/PostToolUse hooks if configured. Zero-overhead
    // pass-through when no hooks are present (see withToolHooks).
    const wrapped = hookConfig
      ? withToolHooks(name, bound, hookConfig, ctx.workspaceRoot)
      : bound;
    out[name] = wrapped;

    // Make aliases reachable by direct property access (out['local_shell_call'])
    // WITHOUT appearing in Object.keys — the Proxy's has trap returns true for
    // them, and ownKeys/ownPropertyNames omits them. This is the critical fix:
    // the old approach (out[alias] = wrapped) made them enumerable, causing the
    // AI SDK to declare duplicate functions to the model → Gemini 400.
    for (const alias of aliasesByCanonical[name] ?? []) {
      Object.defineProperty(out, alias, {
        value: wrapped,
        enumerable: false, // hidden from Object.keys → not declared to model
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

/**
 * Build a subset of the toolset — only the named tools. Used by multi-step
 * sub-agents that have `allowedTools` in their AgentDef. Filters the full
 * toolset (built via buildToolset) to only include tools whose canonical
 * name is in the allow list. Aliases are preserved.
 */
export function buildToolsetSubset(
  ctx: SdkToolContext,
  allowedTools: string[],
  hookConfig?: HookConfig | null,
): Record<string, AnySdkTool> {
  const full = buildToolset(ctx, hookConfig);
  const allowed = new Set(allowedTools);
  // Also include aliases of allowed tools.
  for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
    if (allowed.has(canonical)) allowed.add(alias);
  }
  return Object.fromEntries(
    Object.entries(full).filter(([name]) => allowed.has(name)),
  );
}
