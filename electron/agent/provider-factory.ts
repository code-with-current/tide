/** Provider factory: turns a stored (Provider, Model) pair into an AI SDK LanguageModel, dispatching on declared `apiStyle` (not runtime sniffing) with a diagnostic fetch wrapper (enable with TIDE_DEBUG_SDK=1). */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { createLogger } from '../logger.js';
import type { Provider, Model } from '../../src/types';

const log = createLogger('provider');

/** @param provider User-configured provider entry (apiStyle dispatches). @param model User-configured model entry. @returns SDK LanguageModel. @throws if apiStyle is not 'anthropic' or 'openai'. */
export function resolveModel(provider: Provider, model: Model): LanguageModel {
  const fetchFn = makeDiagnosticFetch(provider);
  switch (provider.apiStyle) {
    case 'anthropic':
      // baseURL empty → undefined so the SDK falls back to api.anthropic.com.
      // Proxies need /v1 in the URL (the SDK appends /messages but only auto-adds /v1 for api.anthropic.com) — see normalizeAnthropicBaseURL.
      return createAnthropic({
        apiKey: provider.apiKey,
        baseURL: normalizeAnthropicBaseURL(provider.baseUrl) || undefined,
        fetch: fetchFn,
      }).languageModel(model.modelId);

    case 'openai':
      // createOpenAICompatible handles Anthropic-compatible proxies that
      // respond in OpenAI shape (some z.ai routes, OpenRouter, etc.).
      // Previously this was stream-anthropic.ts's fallback parser path.
      return createOpenAICompatible({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl,
        name: provider.id,
        fetch: fetchFn,
      }).languageModel(model.modelId);

    default:
      // Future-proof against new ApiStyle values added without a factory branch.
      throw new Error(
        `Unknown apiStyle "${(provider as Provider).apiStyle}" for provider ${provider.id}; ` +
        `expected 'anthropic' or 'openai'.`,
      );
  }
}

/** Wrap fetch with a one-line-per-request log (model, max_tokens, tool count — never prompt content or the key) plus the response status + first ~1KB of a clone, so empty-stream / error-JSON failure modes are diagnosable without a packet capture. Set TIDE_DEBUG_SDK=1 to dump bodies on success too. */
function makeDiagnosticFetch(provider: Provider) {
  const verbose = !!process.env.TIDE_DEBUG_SDK;
  // Detect empty/failed key decryption — safeStorage can silently return ''
  // if the keychain entry is stale (e.g. after OS update, app reinstall, or
  // migration between machines). Log once per provider so it's visible.
  const keyLen = provider.apiKey?.length ?? 0;
  if (keyLen === 0) {
    log.warn(
      'provider has an empty API key — decryption may have failed. Re-enter the key in Settings.',
      { provider: provider.name },
    );
  }
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();

    // Request summary — key fields only, never prompt content or the key.
    let summary: Record<string, unknown> | string = '(no body)';
    if (init?.body && typeof init.body === 'string') {
      try {
        const b = JSON.parse(init.body) as Record<string, unknown>;
        // Thinking is expressed differently per protocol: Anthropic bodies
        // carry a `thinking` block, OpenAI-protocol bodies carry
        // `reasoning_effort`. Show whichever is present so the log reflects
        // what's actually sent (and isn't misleadingly absent on the OpenAI path).
        summary = {
          model: b.model,
          max_tokens: b.max_tokens,
          thinking: (b.thinking as { type?: string; budget_tokens?: number }) ?? null,
          reasoning_effort: (b as { reasoning_effort?: string }).reasoning_effort ?? null,
          stream: b.stream,
          tools: Array.isArray(b.tools) ? b.tools.length : undefined,
          msgs: Array.isArray(b.messages) ? b.messages.length : undefined,
        };
      } catch {
        summary = `(non-JSON body, ${init.body.length}b)`;
      }
    }
    log.debug('request', { provider: provider.name, host, summary });

    // Track whether stream:true was requested: needed to tell a legit non-stream JSON success (generateText) from a provider that failed to stream.
    let requestedStream = true;
    try {
      if (init?.body && typeof init.body === 'string') {
        // streamText sends stream:true; generateText sends stream:false OR
        // omits it. Only an explicit `true` means "stream was requested".
        requestedStream = JSON.parse(init.body).stream === true;
      }
    } catch {
      /* leave default (assume stream) */
    }

    const resp = await fetch(input as RequestInfo, init);

    // Some proxies wrap errors as 200 + JSON (z.ai returns {"code":500,...}); when a STREAMING request gets 2xx + non-event-stream the SDK sees zero events and throws the opaque "No output generated." Re-wrap THAT case as an Anthropic-shaped 502 so the real provider message surfaces. The `requestedStream` gate keeps legit non-streaming (generateText) 2xx+JSON responses untouched.
    const ct = resp.headers.get('content-type') || '';
    const isEventStream = ct.includes('event-stream');
    if (requestedStream && resp.status >= 200 && resp.status < 300 && !isEventStream) {
      const text = await resp.text();
      log.warn('non-stream response', {
        status: resp.status,
        contentType: ct || 'no content-type',
        body: text.slice(0, 500),
      });
      const wrapped = JSON.stringify({
        type: 'error',
        error: {
          type: 'provider_error',
          message: `Provider returned a non-stream ${resp.status} response (${ct || 'no content-type'}): ${text.slice(0, 500)}`,
        },
      });
      return new Response(wrapped, {
        status: 502,
        // statusText must be a ByteString (Latin-1, 0-255) — an em dash here
        // throws "Cannot convert argument to a ByteString" from `new Response`
        // and masks the actual provider error. Plain ASCII only.
        statusText: 'Bad Gateway - provider returned non-stream body',
        headers: { 'content-type': 'application/json' },
      });
    }

    // Otherwise sniff the first ~1KB off a clone so we can report empty/error
    // bodies without disturbing the SDK's stream.
    try {
      const clone = resp.clone();
      const reader = clone.body?.getReader();
      const dec = new TextDecoder();
      let received = 0;
      let preview = '';
      if (reader) {
        while (received < 1024) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (preview.length < 800) preview += dec.decode(value).slice(0, 800 - preview.length);
        }
        reader.cancel().catch(() => {});
      }
      const showBody = verbose || resp.status >= 400 || received === 0 || received < 200;
      const empty = received === 0;
      log.debug('response', {
        status: resp.status,
        statusText: resp.statusText,
        host,
        firstBytes: received,
        empty,
        ...(showBody ? { body: preview } : {}),
      });
    } catch (e: any) {
      log.debug('response (body sniff failed)', { status: resp.status, err: e?.message });
    }
    return resp;
  };
}

/** Ensure an Anthropic-protocol base URL ends with `/v1` — the SDK only auto-adds it for api.anthropic.com; Anthropic-compatible proxies (z.ai, etc.) 404 without it. Idempotent. */
function normalizeAnthropicBaseURL(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.replace(/\/+$/, ''); // strip trailing slashes
  // Already ends with a version segment like /v1, /v2 — leave it.
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}
