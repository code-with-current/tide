/** Stop hooks run on natural termination (finishReason 'stop', no tool calls): they can soft-block (inject a message + re-invoke the model), hard-stop, or inject context. Mirrors Claude Code's Stop hook contract. */
import { exec } from 'child_process';
import { type HookEntry, type HookConfig } from './hook-config.js';

// ─── Types ──────────────────────────────────────────────────────────────

/** Input sent to a stop hook via stdin. */
export interface StopHookInput {
  event: 'Stop';
  /** Whether this stop was triggered by a prior blocking hook (loop guard). */
  stopHookActive: boolean;
  /** The model's final text response. */
  responseText: string;
  /** Workspace root. */
  workspaceRoot: string;
}

/** Result of running stop hooks. */
export interface StopHookResult {
  /** Soft block: messages appended, model re-invoked. */
  blockingErrors: string[];
  /** Hard stop: turn ends immediately. */
  preventContinuation: boolean;
  /** Additional context to inject. */
  additionalContext?: string;
}

// ─── Execution ──────────────────────────────────────────────────────────

/** Run all Stop hooks on natural termination; first hard-stop wins, blocking errors accumulate. */
export async function handleStopHooks(
  config: HookConfig | null,
  input: StopHookInput,
): Promise<StopHookResult> {
  if (!config || config.stop.length === 0) {
    return { blockingErrors: [], preventContinuation: false };
  }

  const blockingErrors: string[] = [];
  let preventContinuation = false;
  let additionalContext: string | undefined;

  for (const hook of config.stop) {
    const result = await executeStopHook(hook, input);

    if (result.blockingError) {
      blockingErrors.push(result.blockingError);
    }
    if (result.preventContinuation) {
      preventContinuation = true;
      break; // hard stop — don't run further hooks
    }
    if (result.additionalContext && !additionalContext) {
      additionalContext = result.additionalContext;
    }
  }

  return { blockingErrors, preventContinuation, additionalContext };
}

// ─── Shell execution ────────────────────────────────────────────────────

/** Execute a single stop hook. */
async function executeStopHook(
  hook: HookEntry,
  input: StopHookInput,
): Promise<{
  blockingError?: string;
  preventContinuation?: boolean;
  additionalContext?: string;
}> {
  return new Promise((resolve) => {
    const stdin = JSON.stringify(input);
    let stdout = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const child = exec(hook.command, {
        cwd: input.workspaceRoot,
        timeout: hook.timeoutMs ?? 10_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOOK_EVENT: 'Stop' },
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
        if (code !== 0) {
          resolve({}); // non-zero = pass-through
          return;
        }
        resolve(parseStopHookOutput(stdout));
      });

      child.on('error', () => {
        if (timer) clearTimeout(timer);
        resolve({});
      });
    } catch {
      if (timer) clearTimeout(timer);
      resolve({});
    }
  });
}

/** Parse stop hook stdout. */
function parseStopHookOutput(stdout: string): {
  blockingError?: string;
  preventContinuation?: boolean;
  additionalContext?: string;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const obj = parsed as Record<string, unknown>;

    // {continue: false, reason: "..."} → blockingError
    // {decision: "block", reason: "..."} → blockingError (Claude Code style)
    const reason = typeof obj.reason === 'string' ? obj.reason : undefined;

    if (obj.continue === false && reason) {
      return { blockingError: reason };
    }
    if (obj.decision === 'block' && reason) {
      return { blockingError: reason };
    }
    if (typeof obj.continue === 'boolean' && !obj.continue && !reason) {
      return { preventContinuation: true };
    }

    return {
      additionalContext: typeof obj.additionalContext === 'string'
        ? obj.additionalContext
        : undefined,
      preventContinuation: typeof obj.continue === 'boolean' && !obj.continue && !reason
        ? true
        : Boolean(obj.preventContinuation),
    };
  } catch {
    return {};
  }
}
