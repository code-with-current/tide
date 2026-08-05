/** LLM session-title generation: prefers the session's own provider+model, falls back to the system model, and returns null (caller keeps placeholder) on any failure. Fire-and-forget, best-effort, ~80 tokens / 30s. */
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

/** @param firstMessage raw first user message (stripped here); @param source chat provider+model (falls back to system model); @returns cleaned title or null (caller keeps placeholder). */
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
