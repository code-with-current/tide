/**
 * Per-execute toolCallId context.
 *
 * `buildToolset` wraps each tool's execute in `runWithToolCallId(id, ...)`, so
 * `withPermission` can read the current id via `currentToolCallId()` WITHOUT
 * every tool threading it as an explicit parameter (avoids ~20 mechanical
 * edits). AsyncLocalStorage propagates across `await` (the permission wait),
 * and each parallel execute gets its own context — no race between concurrent
 * tool calls in the same SDK step.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

/** The toolCallId of the currently-executing tool, if inside a wrapped execute. */
export function currentToolCallId(): string | undefined {
  return storage.getStore();
}

/** Run `fn` with `toolCallId` set as the current context (propagates through awaits). */
export function runWithToolCallId<T>(toolCallId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(toolCallId, fn);
}
