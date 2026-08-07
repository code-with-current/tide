/** LLM session-title generation: uses the SAME provider+model+protocol as the session's chat turn — no separate model resolution, no system-model fallback. Returns null (caller keeps placeholder) on any failure. Fire-and-forget, best-effort. */
import { generateText } from 'ai';
import { resolveModel } from './provider-factory.js';
import { resolveProtocolOptions } from './protocols/index.js';
import { resolveMaxOutputTokens } from './model-capabilities.js';
import { createLogger } from '../logger.js';
import type { Provider } from '../../src/types';

const log = createLogger('title');

const TITLE_SYSTEM =
  'You are a Project Manager and System Engineer.' +
  'Generate a concise 3-5 word title summarizing what the user is asking for the workspace. ' +
  'Reply with ONLY the title — no quotes, no trailing punctuation, no explanation. ' +
  'If the message starts with a /command or @agent (e.g. /code-reviewer, @planner), ' +
  'that context is relevant — reflect the invocation in the title when it adds meaning.';

function extractSubject(raw: string): { stripped: string; prompt: string } {
  const trimmed = raw.trim();
  const cmdMatch = trimmed.match(/^\/([A-Za-z0-9_-]+)(?:\s+(.*))?$/s);
  const agentMatch = trimmed.match(/^@([A-Za-z0-9_-]+)(?:\s+(.*))?$/s);
  const skill = cmdMatch?.[1];
  const agent = agentMatch?.[1];
  const rest = cmdMatch?.[2] ?? agentMatch?.[2] ?? trimmed;
  const stripped = (rest ?? '').trim();
  const parts: string[] = [];
  if (skill) parts.push(`Skill invoked: ${skill}`);
  if (agent) parts.push(`Agent: ${agent}`);
  if (rest?.trim()) parts.push(rest.trim());
  const prompt = parts.length > 1 ? parts.join('\n') : (rest?.trim() ?? trimmed);
  return { stripped, prompt };
}

export interface TitleModelSource {
  provider: Provider;
  modelId: string;
}

/** Generate a session title using the session's own provider+model (same resolution path as the orchestrator). @returns cleaned title or null. */
export async function generateSessionTitle(
  firstMessage: string,
  source: TitleModelSource,
): Promise<string | null> {
  const { stripped, prompt } = extractSubject(firstMessage);
  if (!stripped && !prompt) return null;

  if (!source.provider.apiKey) {
    log.warn('title-gen: provider has no apiKey', { provider: source.provider.id });
    return null;
  }

  try {
    // Mirror the orchestrator's exact model + protocol resolution.
    const model = resolveModel(source.provider, { modelId: source.modelId, contextWindow: 0 } as any);
    const modelEntry = source.provider.models.find((m) => m.modelId === source.modelId);
    const proto = resolveProtocolOptions(
      source.provider.apiStyle,
      null, // no thinking for title-gen
      { hasTools: false, modelId: source.modelId, maxOutputTokens: resolveMaxOutputTokens(source.modelId, modelEntry) },
    );

    const result = await generateText({
      model,
      system: TITLE_SYSTEM,
      prompt,
      providerOptions: proto.providerOptions,
      maxOutputTokens: Math.min(proto.maxOutputTokens, 80),
      abortSignal: AbortSignal.timeout(30_000),
    });

    const clean = (result.text ?? '')
      .trim()
      .replace(/^["'`]+|["'`.]+$/g, '')
      .replace(/\s*[.\s]+$/, '')
      .slice(0, 80);
    return clean || null;
  } catch (e: any) {
    log.warn('title-gen failed', { err: e?.message, provider: source.provider.id, modelId: source.modelId });
    return null;
  }
}
