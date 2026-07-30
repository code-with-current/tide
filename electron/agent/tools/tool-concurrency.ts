/**
 * Tool concurrency — partition tool calls into parallel/sequential batches.
 *
 * Read-only tools (read_file, glob, grep, etc.) have no side effects and can
 * safely run in parallel. Write/bash tools mutate state and must run
 * sequentially. This module provides the partitioning logic that a future
 * manual loop (or streaming tool executor) would use to dispatch tools.
 *
 * NOTE: The Vercel AI SDK currently executes tools sequentially within each
 * step. This partition logic is forward-looking — it's ready for when a
 * manual loop or SDK-level parallelism is available. Today it's used for:
 *   - Permission batching (ask once for N safe tools, not N times)
 *   - Documentation of which tools are concurrency-safe
 */

/** Tools safe to run in parallel (read-only, no shared mutable state). */
const CONCURRENCY_SAFE_TOOLS = new Set<string>([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
]);

/**
 * Is this tool safe to run concurrently with other safe tools?
 * Write tools (edit_file, write_file, bash, git) are NOT safe — they
 * mutate the filesystem or shell state.
 */
export function isConcurrencySafe(toolName: string): boolean {
  return CONCURRENCY_SAFE_TOOLS.has(toolName);
}

/**
 * Partition a list of tool calls into batches. Consecutive concurrency-safe
 * tools form one batch (eligible for parallel execution); non-safe tools
 * each get their own single-element batch (must run alone, in order).
 *
 * Example:
 *   [read_file, glob, grep, bash, read_file]
 *   → [[read_file, glob, grep], [bash], [read_file]]
 *
 * Mirrors Claude Code's partitionToolCalls in toolOrchestration.ts.
 */
export function partitionToolCalls<T extends { toolName: string }>(
  calls: T[],
): T[][] {
  const batches: T[][] = [];
  let currentBatch: T[] = [];
  let currentSafe = false;

  for (const call of calls) {
    const safe = isConcurrencySafe(call.toolName);

    if (safe && currentBatch.length > 0 && currentSafe) {
      // Extend the current safe batch
      currentBatch.push(call);
    } else {
      // Flush the current batch (if any) and start a new one
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [call];
      currentSafe = safe;
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Maximum number of tools to run in parallel within a batch.
 * Claude Code defaults to 10 (CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY).
 */
export const MAX_TOOL_CONCURRENCY = 10;
