/** Best-effort session title generation using the session's own provider+model. Returns null on failure. */
import { generateText } from 'ai';
import { resolveModel } from './provider-factory.js';
import { resolveProtocolOptions } from './protocols/index.js';
import { resolveMaxOutputTokens } from './model-capabilities.js';
import { createLogger } from '../logger.js';
import type { Provider } from '../../../src/types';

const log = createLogger('title');

const TITLE_SYSTEM =
  'You are a session title generator for a coding workspace. Generate a concise 3-5 word title ' +
  'naming WHAT the session is about, not what was asked. ' +
  'Lead with the primary identifier: the function, file, feature, error, or system the work centers on. ' +
  'Use sentence case — capitalize only the first word and proper nouns (APIs, class names keep their casing). ' +
  'No request verbs (fix, add, implement, update, refactor), no "How to", no questions, no quotes, ' +
  'no trailing punctuation, no explanation. ' +
  'Examples: "fix auth token refresh" → "Auth token refresh"; ' +
  '"why does useChatStream re-render on every keystroke" → "useChatStream re-renders"; ' +
  '"can you add dark mode" → "Dark mode". ' +
  'Reply with ONLY the title. ' +
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

/** Clamp so the title model never sees a huge paste — it only needs the gist. */
const MAX_SUBJECT_CHARS = 6_000;
const MAX_EXCERPT_CHARS = 800;

export interface TitleAttachment {
  path: string;
  kind: string;
  content?: string;
}

/** Subject for title generation: the message text, or — when the user only
 *  attached files / pasted long text (which the composer stores as a virtual
 *  attachment with empty display text) — the attachment names plus a short
 *  excerpt of the first inline one. Long text is clamped. */
export function buildTitleSubject(firstMessage: string, attachments: TitleAttachment[]): string {
  const text = firstMessage.trim();
  const names = attachments
    .map((a) => a.path.split('/').pop() || a.path)
    .filter(Boolean)
    .join(', ');
  if (!text) {
    if (!names) return '';
    const excerpt = attachments.find((a) => a.content?.trim())?.content?.trim().slice(0, MAX_EXCERPT_CHARS);
    return excerpt ? `Attached files: ${names}\n\n${excerpt}` : `Attached files: ${names}`;
  }
  if (text.length <= MAX_SUBJECT_CHARS) return text;
  return text.slice(0, MAX_SUBJECT_CHARS) + '…';
}

/** @returns cleaned title or null */
export async function generateSessionTitle(
  firstMessage: string,
  source: TitleModelSource,
  attachments: TitleAttachment[] = [],
): Promise<string | null> {
  const { stripped, prompt } = extractSubject(buildTitleSubject(firstMessage, attachments));
  if (!stripped && !prompt) return null;

  if (!source.provider.apiKey) {
    log.warn('title-gen: provider has no apiKey', { provider: source.provider.id });
    return null;
  }

  try {
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
      // Reasoning models burn tokens on internal reasoning; too small a budget
      // leaves nothing for the title text. Title is sliced to 80 chars below.
      maxOutputTokens: Math.min(proto.maxOutputTokens, 1024),
      abortSignal: AbortSignal.timeout(30_000),
    });

    const clean = (result.text ?? '')
      .trim()
      .replace(/^["'`]+|["'`.]+$/g, '')
      .replace(/\s*[.\s]+$/, '')
      .slice(0, 80);
    if (!clean) {
      const usage = (result as any).usage;
      log.warn('title-gen returned empty text', {
        provider: source.provider.id,
        modelId: source.modelId,
        reasoningTokens: usage?.reasoningTokens ?? usage?.completionTokensDetails?.reasoningTokens,
        totalTokens: usage?.totalTokens,
        finishReason: (result as any).finishReason,
      });
    }
    return clean || null;
  } catch (e: any) {
    log.warn('title-gen failed', { err: e?.message, provider: source.provider.id, modelId: source.modelId });
    return null;
  }
}
