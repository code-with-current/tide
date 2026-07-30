/**
 * Tool executor contract.
 *
 * Every built-in tool implements this signature. The orchestrator looks up
 * the executor by tool name in the registry, calls it with the model's
 * parsed args and a context carrying the workspace root + abort signal,
 * and forwards the result back to the model + renderer.
 */

import type { Provider, ToolDisplay, ToolName, Usage } from '../../../src/types/index';

/** Passed to every executor. */
export interface ToolContext {
  workspaceRoot: string;
  /** Abort signal — tools doing long work should check this. */
  signal: AbortSignal;
  /** Per-tool timeout in ms (from ToolDefinition). */
  timeoutMs: number;
  /**
   * Parent turn's provider — consumed by `dispatch_agent` to spawn a
   * sub-agent against the same LLM endpoint. Other tools ignore this.
   * Set by the orchestrator before each dispatch.
   */
  provider?: Provider;
  /**
   * Parent turn's model id — sub-agents inherit it. Consumed by
   * `dispatch_agent`; ignored by other tools.
   */
  modelId?: string;
  /**
   * Usage accumulator — folds a sub-agent's token usage into the parent
   * turn's aggregate so the context-window meter reflects sub-agent cost.
   * Consumed by `dispatch_agent`; ignored by other tools.
   */
  onUsage?: (u: Usage) => void;
  /**
   * Sub-agent streaming delta hook. When `dispatch_agent` spawns a sub-agent,
   * each token the sub-agent emits fires this callback so the orchestrator
   * can emit a `tool_call_delta` event to the renderer — giving the user
   * live progress inside the dispatch card instead of a frozen spinner
   * for the entire sub-agent turn.
   *
   * Consumed by `dispatch_agent`; ignored by other tools.
   */
  onDelta?: (delta: string) => void;
  /** Active session id — used by todo_write to key its per-session store
   *  and broadcast updates to the renderer. Other tools ignore it. */
  sessionId?: string;
}

/** Result returned by every executor. */
export interface ToolResult {
  status: 'executed' | 'failed' | 'rejected' | 'timeout' | 'aborted';
  /** Model-facing summary. Must be short; bills tokens every turn. */
  output: string;
  /** Richer UI-facing payload. Optional. */
  display?: ToolDisplay;
  /** Duration in ms — filled in by the orchestrator if the executor doesn't. */
  durationMs?: number;
  /** Short metadata line for the card footer, e.g. "412 lines". */
  meta?: string;
}

/** An executor function. */
export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

/** Registration entry pairing a definition with its executor. */
export interface ToolRegistration {
  name: ToolName;
  definition: {
    name: ToolName;
    description: string;
    input_schema: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
  riskTier: 'read_only' | 'write' | 'destructive';
  requiresWorktree: boolean;
  timeoutMs: number;
  autoApproveIn: ('plan' | 'ask' | 'edit' | 'full')[];
  execute: ToolExecutor;
}

/** Build a one-line preview string from a tool's args — for the UI card. */
export function formatArgPreview(toolName: ToolName, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file': {
      const p = String(args.path ?? '');
      const lines = args.maxLines ? `, ${args.maxLines} lines` : '';
      return `${p}${lines}`;
    }
    case 'list_dir':
      return String(args.path ?? '');
    case 'glob': {
      const pat = String(args.pattern ?? '');
      const p = args.path ? ` in ${args.path}` : '';
      return pat + p;
    }
    case 'grep': {
      const pat = String(args.pattern ?? '');
      const p = args.path ? ` in ${args.path}` : '';
      return `/${pat}/${p}`;
    }
    case 'bash':
      return String(args.command ?? '').slice(0, 80);
    case 'edit_file':
      return String(args.path ?? '');
    case 'multi_edit': {
      const p = String(args.path ?? '');
      const n = Array.isArray(args.edits) ? args.edits.length : 0;
      return `${p} · ${n} edit${n === 1 ? '' : 's'}`;
    }
    case 'write_file':
      return String(args.path ?? '');
    case 'notebook_edit': {
      const p = String(args.path ?? '');
      const mode = String(args.edit_mode ?? 'replace');
      const idx = typeof args.cell_index === 'number' ? ` #${args.cell_index}` : '';
      return `${p} · ${mode}${idx}`;
    }
    case 'git':
      return Array.isArray(args.args) ? (args.args as string[]).join(' ') : '';
    case 'bash_output':
    case 'kill_shell':
      return String(args.shell_id ?? '');
    case 'dispatch_agent':
      return String(args.name ?? '');
    case 'web_fetch':
      return String(args.url ?? '');
    case 'web_search':
      return String(args.query ?? '');
    case 'todo_write': {
      const n = Array.isArray(args.todos) ? args.todos.length : 0;
      return `${n} todo${n === 1 ? '' : 's'}`;
    }
    case 'ask_followup_question': {
      const q = String(args.question ?? '');
      return q.length > 60 ? q.slice(0, 57) + '…' : q;
    }
    case 'exit_plan_mode':
      return 'plan ready';
    case 'compact': {
      const k = typeof args.keep_last === 'number' ? args.keep_last : 6;
      return `keep last ${k}`;
    }
    case 'slash_command':
      return `/${String(args.command ?? '')}`;
    case 'memory': {
      const q = String(args.query ?? '');
      return q.length > 60 ? q.slice(0, 57) + '…' : q;
    }
    case 'mcp':
      return String(args.server ?? args.name ?? '');
    default:
      return '';
  }
}
