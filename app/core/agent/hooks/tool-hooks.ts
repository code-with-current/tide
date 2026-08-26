/** PreToolUse / PostToolUse hooks: user-configured shell commands run around each tool call, receiving JSON on stdin and returning JSON on stdout to control behavior (non-JSON or non-zero exit = pass-through). Mirrors Claude Code's hook contract. */
import { exec } from 'child_process';
import { toolPatternMatches, type HookEntry, type HookConfig } from './hook-config.js';
import type { ToolResult } from '../tools/types.js';

// ─── Types ──────────────────────────────────────────────────────────────

/** Input sent to a hook via stdin (JSON). */
export interface HookInput {
  /** Hook event type. */
  event: 'PreToolUse' | 'PostToolUse';
  /** Tool name being called. */
  toolName: string;
  /** Tool input arguments. */
  input: Record<string, unknown>;
  /** Tool output (PostToolUse only). */
  output?: ToolResult;
  /** Workspace root. */
  workspaceRoot: string;
}

/** Parsed result from a hook's stdout. */
export interface ToolHookResult {
  /** Controls whether the tool proceeds. PreToolUse only. */
  decision?: 'allow' | 'deny' | 'ask';
  /** Reason for the decision (shown to the model). */
  reason?: string;
  /** Modified tool input (PreToolUse only). */
  updatedInput?: Record<string, unknown>;
  /** Modified tool output text (PostToolUse only). */
  updatedOutput?: string;
  /** Additional context to inject as a user message. */
  additionalContext?: string;
  /** Hard-stop the entire turn. */
  preventContinuation?: boolean;
}

// ─── Execution ──────────────────────────────────────────────────────────

/** Run all PreToolUse hooks matching the tool name. Hooks run sequentially — a later hook sees the earlier hook's input modifications. */
export async function runPreToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  config: HookConfig | null,
  workspaceRoot: string,
): Promise<ToolHookResult[]> {
  if (!config || config.preToolUse.length === 0) return [];

  const matching = config.preToolUse.filter((h) =>
    toolPatternMatches(h.tools ?? '*', toolName),
  );
  if (matching.length === 0) return [];

  const results: ToolHookResult[] = [];
  let currentInput = input;

  for (const hook of matching) {
    const hookInput: HookInput = {
      event: 'PreToolUse',
      toolName,
      input: currentInput,
      workspaceRoot,
    };
    const result = await executeHook(hook, hookInput);
    results.push(result);

    // Chain input modifications
    if (result.updatedInput) {
      currentInput = { ...currentInput, ...result.updatedInput };
    }

    // If a hook denies, stop running further hooks
    if (result.decision === 'deny') break;
  }

  return results;
}

/**
 * Run all PostToolUse hooks matching the tool name. Returns an array of
 * results (one per matching hook).
 */
export async function runPostToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  output: ToolResult,
  config: HookConfig | null,
  workspaceRoot: string,
): Promise<ToolHookResult[]> {
  if (!config || config.postToolUse.length === 0) return [];

  const matching = config.postToolUse.filter((h) =>
    toolPatternMatches(h.tools ?? '*', toolName),
  );
  if (matching.length === 0) return [];

  const results: ToolHookResult[] = [];
  for (const hook of matching) {
    const hookInput: HookInput = {
      event: 'PostToolUse',
      toolName,
      input,
      output,
      workspaceRoot,
    };
    const result = await executeHook(hook, hookInput);
    results.push(result);
    if (result.preventContinuation) break;
  }

  return results;
}

// ─── Shell execution ────────────────────────────────────────────────────

/** Execute a single hook: run its shell command, feed JSON on stdin, parse JSON from stdout (empty result on non-JSON or non-zero exit = pass-through). */
async function executeHook(
  hook: HookEntry,
  input: HookInput,
): Promise<ToolHookResult> {
  return new Promise((resolve) => {
    const stdin = JSON.stringify(input);
    let stdout = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const child = exec(hook.command, {
        cwd: input.workspaceRoot,
        timeout: hook.timeoutMs ?? 10_000,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env, HOOK_EVENT: input.event, HOOK_TOOL: input.toolName },
      });

      timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({}); // timeout = pass-through
      }, hook.timeoutMs ?? 10_000);

      child.stdin?.write(stdin);
      child.stdin?.end();

      child.stdout?.on('data', (data: Buffer | string) => {
        stdout += data.toString();
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        // Non-zero exit = hook errored, pass through
        if (code !== 0) {
          resolve({});
          return;
        }
        // Try to parse stdout as JSON
        resolve(parseHookOutput(stdout));
      });

      child.on('error', () => {
        if (timer) clearTimeout(timer);
        resolve({}); // error = pass-through
      });
    } catch {
      if (timer) clearTimeout(timer);
      resolve({}); // any error = pass-through
    }
  });
}

/** Parse hook stdout into a ToolHookResult. Non-JSON → empty (pass-through). */
function parseHookOutput(stdout: string): ToolHookResult {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const obj = parsed as Record<string, unknown>;
    return {
      decision: obj.decision === 'allow' || obj.decision === 'deny' || obj.decision === 'ask'
        ? obj.decision
        : undefined,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      updatedInput: typeof obj.updatedInput === 'object' && obj.updatedInput !== null
        ? obj.updatedInput as Record<string, unknown>
        : undefined,
      updatedOutput: typeof obj.updatedOutput === 'string' ? obj.updatedOutput : undefined,
      additionalContext: typeof obj.additionalContext === 'string'
        ? obj.additionalContext
        : undefined,
      preventContinuation: typeof obj.continue === 'boolean'
        ? !obj.continue // {continue: false} → preventContinuation
        : Boolean(obj.preventContinuation),
    };
  } catch {
    return {}; // non-JSON = pass-through
  }
}
