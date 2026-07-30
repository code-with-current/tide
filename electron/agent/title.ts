/**
 * LLM session-title generation via the system app model.
 *
 * The system model (agent/system-model.ts) is a lightweight, app-owned model
 * distinct from the user's chat providers — credentials in `.env`, no
 * per-session provider/model resolution, not billed to the user's chat quota.
 * Title generation is the canonical system-model task.
 *
 * One-shot, no tools, ~80 token cap, 30s abort. Strips `/skill` and `@agent`
 * prefixes first (stripCommandPrefix) so the title reflects the task, not the
 * invocation.
 *
 * Lifecycle: fire-and-forget from the renderer right after a NEW session is
 * created. The session already has a locally-stripped placeholder title, so
 * the sidebar is sane instantly; this call refines it and renames via
 * `sessions.renameSession` when it returns. On any failure (no key configured,
 * provider error, timeout, empty result) it returns null and the caller keeps
 * the placeholder — title generation never blocks the user.
 */
import { runSystemTask, isSystemModelConfigured } from './system-model.js';
import { stripCommandPrefix } from '../../src/lib/session-title.js';

const TITLE_SYSTEM =
  'Generate a concise 3-5 word title summarizing what the user is asking for. ' +
  'Reply with ONLY the title — no quotes, no trailing punctuation, no explanation.';

/**
 * @param firstMessage  The session's first user message (raw — stripped here).
 * @returns A cleaned short title, or null if the system model is unconfigured,
 *          generation failed, or there was no subject to summarize. Callers
 *          keep the placeholder on null.
 */
export async function generateSessionTitle(
  firstMessage: string,
): Promise<string | null> {
  const subject = stripCommandPrefix(firstMessage);
  if (!subject || !isSystemModelConfigured()) return null;
  try {
    const raw = await runSystemTask({
      system: TITLE_SYSTEM,
      prompt: subject,
      maxOutputTokens: 80,
      // 30s, not the usual ~15s: the system model rides a free OpenRouter
      // route whose cold-start / queue latency occasionally blows past 15s
      // (observed in testing). Fire-and-forget, so the longer budget has no
      // UX cost — it just cuts spurious "keep the placeholder" failures.
      abortSignal: AbortSignal.timeout(30_000),
    });
    const clean = raw
      .trim()
      .replace(/^["'`]+|["'`.]+$/g, '') // strip wrapping quotes / backticks
      .replace(/\s*[.\s]+$/, '') // trailing period / whitespace
      .slice(0, 80);
    return clean || null;
  } catch {
    // Unconfigured, provider error, timeout, or non-200 — keep the
    // placeholder. Don't surface: title generation is best-effort, never
    // user-facing as a fault.
    return null;
  }
}
