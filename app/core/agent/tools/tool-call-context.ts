/** Per-execute toolCallId context via AsyncLocalStorage: buildToolset wraps each execute so withPermission can read the current id without explicit threading; propagates across awaits and gives each parallel execute its own context (no races between concurrent tool calls in the same step). */
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
