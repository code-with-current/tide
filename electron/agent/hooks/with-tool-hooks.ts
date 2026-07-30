/**
 * withToolHooks — higher-order wrapper that adds PreToolUse/PostToolUse hooks
 * to any SDK tool.
 *
 * Applied in `buildToolset` (registry.ts) AFTER each factory creates its tool.
 * The wrapper intercepts the tool's `execute` function, runs hooks before/after,
 * and handles deny/block/modify results.
 *
 * Hook execution order around a tool call:
 *
 *   1. PreToolUse hooks (can deny, modify input, inject context)
 *   2. Permission check (the tool's own withPermission)
 *   3. Tool execution
 *   4. PostToolUse hooks (can modify output, inject context, block)
 *
 * If no hooks are configured, the wrapper is a pass-through (zero overhead).
 */
import type { CoreTool } from 'ai';
import { runPreToolUseHooks, runPostToolUseHooks } from './tool-hooks.js';
import type { HookConfig } from './hook-config.js';
import type { ToolResult } from '../tools/types.js';

/**
 * Wrap an SDK tool's execute function with hook support.
 *
 * @param toolName   The tool's name (for hook matching).
 * @param sdkTool    The tool object from the factory ({ description, inputSchema, execute }).
 * @param config     Hook config (null = no hooks, pass-through).
 * @param workspaceRoot  The workspace root for hook cwd.
 * @returns          A new tool object with execute wrapped.
 */
export function withToolHooks<T extends CoreTool>(
  toolName: string,
  sdkTool: T,
  config: HookConfig | null,
  workspaceRoot: string,
): T {
  // No hooks configured → zero-overhead pass-through.
  if (!config || (config.preToolUse.length === 0 && config.postToolUse.length === 0)) {
    return sdkTool;
  }

  const originalExecute = sdkTool.execute;
  if (!originalExecute) return sdkTool;

  return {
    ...sdkTool,
    execute: async (args: Record<string, unknown>, ctx?: unknown) => {
      // ── 1. PreToolUse hooks ──
      const preResults = await runPreToolUseHooks(
        toolName,
        args,
        config,
        workspaceRoot,
      );

      // Check for denial
      const denied = preResults.find((r) => r.decision === 'deny');
      if (denied) {
        const result: ToolResult = {
          status: 'rejected',
          output: `Tool "${toolName}" was blocked by a PreToolUse hook: ${denied.reason ?? 'no reason given'}`,
        };
        return result;
      }

      // Apply input modifications (merge all updatedInput from hooks)
      let finalArgs = args;
      for (const r of preResults) {
        if (r.updatedInput) {
          finalArgs = { ...finalArgs, ...r.updatedInput };
        }
      }

      // ── 2+3. Execute the tool (permission + actual work) ──
      const result = (await originalExecute(finalArgs, ctx)) as ToolResult;

      // ── 4. PostToolUse hooks ──
      const postResults = await runPostToolUseHooks(
        toolName,
        finalArgs,
        result,
        config,
        workspaceRoot,
      );

      // Apply output modifications
      let finalResult = result;
      for (const r of postResults) {
        if (r.updatedOutput) {
          finalResult = { ...finalResult, output: r.updatedOutput };
        }
      }

      return finalResult;
    },
  };
}
