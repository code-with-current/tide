/** Partition tool calls into parallel/sequential batches: read-only tools run in parallel, write/bash tools run sequentially. Forward-looking (SDK runs sequentially today); currently used for permission batching and concurrency-safety documentation. */

/** Tools safe to run in parallel (read-only, no shared mutable state). */
const CONCURRENCY_SAFE_TOOLS = new Set<string>([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
]);

/** Is this tool safe to run concurrently? Write tools (edit_file, write_file, bash, git) are NOT — they mutate the filesystem or shell state. */
export function isConcurrencySafe(toolName: string): boolean {
  return CONCURRENCY_SAFE_TOOLS.has(toolName);
}

/** Partition tool calls into batches: consecutive concurrency-safe tools batch together (parallel-eligible); non-safe tools get their own single-element batch (must run alone, in order). Mirrors Claude Code's partitionToolCalls. */
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
