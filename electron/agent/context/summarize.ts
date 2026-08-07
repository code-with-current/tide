/** Shared LLM-summarization helpers — used by auto-compact (context compression) and session-fork (carrying context to a new model). */
import { generateText } from 'ai';
import { resolveModel } from '../provider-factory.js';
import { resolveProtocolOptions } from '../protocols/index.js';
import { resolveMaxOutputTokens } from '../model-capabilities.js';
import type { Provider } from '../../../src/types/index.js';
import type { ModelMessage } from 'ai';

/** LLM-summarize a conversation into a concise "Prior Context" block. Uses the given provider/model; best-effort (throws on missing key so callers can fall back). */
export async function generateSessionSummary(
  messages: ModelMessage[],
  ctx: { provider: Provider; modelId: string; signal: AbortSignal },
): Promise<string> {
  if (!ctx.provider.apiKey) {
    throw new Error('Cannot summarize: provider has no API key');
  }

  const model = resolveModel(ctx.provider, { modelId: ctx.modelId, contextWindow: 0 } as any);
  const modelEntry = ctx.provider.models.find((m) => m.modelId === ctx.modelId);
  const proto = resolveProtocolOptions(
    ctx.provider.apiStyle,
    { budgetTokens: 4096 },
    { hasTools: false, modelId: ctx.modelId, maxOutputTokens: resolveMaxOutputTokens(ctx.modelId, modelEntry) },
  );

  const serialized = serializeForSummary(messages);

  const result = await generateText({
    model,
    system:
      'You are a conversation summarizer. Create a concise, information-dense summary ' +
      'of the conversation below. Preserve: decisions made, files created/edited, ' +
      'errors encountered and their resolutions, the current task state, and any ' +
      'important context the model needs to continue. Drop pleasantries, redundant ' +
      'tool outputs, and anything not essential for continuing the work. ' +
      'Format as bullet points under a "## Prior Context" heading.',
    prompt: serialized,
    providerOptions: proto.providerOptions,
    maxOutputTokens: Math.min(proto.maxOutputTokens, 4096),
    abortSignal: ctx.signal,
  });

  return (result.text ?? '').trim() || '(Summary generation returned empty content)';
}

/** Serialize messages into a text block for summarization, capping each message at 2000 chars to keep input manageable. */
export function serializeForSummary(messages: ModelMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    if (typeof msg.content === 'string') {
      parts.push(`[${role}]\n${msg.content.slice(0, 2000)}`);
    } else if (Array.isArray(msg.content)) {
      const texts: string[] = [];
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          texts.push(String((part as { text: string }).text).slice(0, 2000));
        }
      }
      if (texts.length > 0) {
        parts.push(`[${role}]\n${texts.join('\n')}`);
      }
    }
  }
  return parts.join('\n\n---\n\n');
}
