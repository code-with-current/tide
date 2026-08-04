/**
 * LLM session-title generation.
 *
 * Prefers the SAME provider + model the session chats with (so title-gen
 * works whenever a turn would — no separate credential surface to set up).
 * Falls back to the app's system model (agent/system-model.ts) when the
 * session's provider isn't resolvable — e.g. a deleted provider or a missing
 * API key. If neither is available, returns null and the caller keeps the
 * placeholder.
 *
 * One-shot, no tools, ~80 token cap, 30s abort. Strips `/skill` and `@agent`
 * prefixes first (stripCommandPrefix) so the title reflects the task, not the
 * invocation. Also strips leading `[/label/](path)` attachment/file-link
 * blocks the composer now embeds into content.
 *
 * Lifecycle: fire-and-forget from the renderer right after a NEW session is
 * created. The session already has a locally-stripped placeholder title, so
 * the sidebar is sane instantly; this call refines it and renames via
 * `sessions.renameSession` when it returns. On any failure (provider error,
 * timeout, empty result) it returns null and the caller keeps the placeholder
 * — title generation never blocks the user.
 */
import { generateText, type LanguageModel } from 'ai';
import { runSystemTask, isSystemModelConfigured } from './system-model.js';
import { resolveModel } from './provider-factory.js';
import { stripCommandPrefix } from '../../src/lib/session-title.js';
import type { Provider } from '../../src/types';

const TITLE_SYSTEM =
  'Generate a concise 3-5 word title summarizing what the user is asking for. ' +
  'Reply with ONLY the title — no quotes, no trailing punctuation, no explanation.';

export interface TitleModelSource {
  /** The session's chat provider (already API-key-resolved by the store). */
  provider?: Provider;
  /** The modelId the session chats with. */
  modelId?: string;
}

/**
 * @param firstMessage  The session's first user message (raw — stripped here).
 * @param source        The session's chat provider+model. When resolvable,
 *                      title-gen runs on that model. Falls back to the system
 *                      model; if neither is usable, returns null.
 * @returns A cleaned short title, or null if no model was available,
 *          generation failed, or there was no subject to summarize. Callers
 *          keep the placeholder on null.
 */
export async function generateSessionTitle(
  firstMessage: string,
  source?: TitleModelSource,
): Promise<string | null> {
  const subject = stripCommandPrefix(firstMessage);
  if (!subject) return null;

  // Resolve the model to run title-gen on. Prefer the session's chat model;
  // fall back to the system model. If neither resolves, bail (keep the
  // placeholder) — title generation is best-effort.
  let model: LanguageModel | null = null;
  if (source?.provider && source.provider.apiKey && source.modelId) {
    // Match the orchestrator's model-entry lookup: find the Model whose
    // modelId the session uses so resolveModel gets a well-formed entry.
    const modelEntry = source.provider.models.find(
      (m) => m.modelId === source.modelId,
    );
    try {
      model = resolveModel(
        source.provider,
        modelEntry ?? {
          id: source.modelId,
          alias: source.modelId,
          modelId: source.modelId,
          contextWindow: 0,
          providerId: source.provider.id,
        },
      );
    } catch {
      model = null; // fall through to system model
    }
  }
  if (!model && !isSystemModelConfigured()) return null;

  try {
    const raw = model
      ? (
          await generateText({
            model,
            system: TITLE_SYSTEM,
            prompt: subject,
            maxOutputTokens: 80,
            abortSignal: AbortSignal.timeout(30_000),
          })
        ).text
      : await runSystemTask({
          system: TITLE_SYSTEM,
          prompt: subject,
          maxOutputTokens: 80,
          abortSignal: AbortSignal.timeout(30_000),
        });
    const clean = raw
      .trim()
      .replace(/^["'`]+|["'`.]+$/g, '') // strip wrapping quotes / backticks
      .replace(/\s*[.\s]+$/, '') // trailing period / whitespace
      .slice(0, 80);
    return clean || null;
  } catch {
    // Provider error, timeout, or non-200 — keep the placeholder. Don't
    // surface: title generation is best-effort, never user-facing as a fault.
    return null;
  }
}
