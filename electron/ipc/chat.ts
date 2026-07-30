/**
 * Chat streaming via raw fetch + SSE parsing.
 *
 * Bypasses the Vercel AI SDK's provider adapters (which are too strict for
 * some Anthropic-compatible proxies like z.ai). Sends the request in the
 * provider's native format and parses SSE events manually.
 */

import { ipcMain } from 'electron';
import * as store from '../store.js';
import { createLogger } from '../logger.js';

const log = createLogger('chat');

const controllers = new Map<number, AbortController>();

interface ChatPayload {
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  modelId: string;
  providerId: string;
}

export function registerChatHandlers() {
  ipcMain.handle('tide:chat:stream', async (e, payload: ChatPayload) => {
    const webContents = e.sender;

    // Resolve provider — fall back to any enabled provider serving the modelId
    // if the session's providerId is stale (provider was deleted). Mirrors the
    // orchestrator's recovery so orphaned sessions don't hard-fail.
    const providers = store.listProviders();
    const provider =
      providers.find((p) => p.id === payload.providerId) ??
      (payload.modelId ? providers.find((p) => p.enabled && p.models.some((m) => m.modelId === payload.modelId)) : undefined);
    if (!provider) {
      webContents.send('chat:error', { message: `Provider ${payload.providerId} not found` });
      return;
    }
    if (!provider.apiKey) {
      webContents.send('chat:error', { message: `No API key for ${provider.name}` });
      return;
    }

    log.info('stream start', {
      provider: provider.name,
      apiStyle: provider.apiStyle,
      baseUrl: provider.baseUrl,
      model: payload.modelId,
      messages: payload.messages.length,
      hasSystem: payload.messages.some((m) => m.role === 'system'),
    });

    // Abort existing
    const existing = controllers.get(webContents.id);
    if (existing) existing.abort();

    const controller = new AbortController();
    controllers.set(webContents.id, controller);

    try {
      if (provider.apiStyle === 'anthropic') {
        await streamAnthropic(webContents, provider, payload, controller.signal);
      } else {
        await streamOpenAI(webContents, provider, payload, controller.signal);
      }

      if (!controller.signal.aborted) {
        webContents.send('chat:done', {});
      }
    } catch (err: any) {
      if (controller.signal.aborted) {
        webContents.send('chat:done', { aborted: true });
      } else {
        log.error('stream error', { err: err?.message });
        webContents.send('chat:error', { message: err?.message || 'Stream failed' });
      }
    } finally {
      controllers.delete(webContents.id);
    }
  });

  ipcMain.handle('tide:chat:abort', (e) => {
    const c = controllers.get(e.sender.id);
    if (c) { c.abort(); controllers.delete(e.sender.id); }
  });
}

// ── Anthropic Messages API streaming ──────────────────────────

async function streamAnthropic(
  wc: Electron.WebContents,
  provider: { apiKey: string; baseUrl: string },
  payload: ChatPayload,
  signal: AbortSignal,
) {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`;
  const body = {
    model: payload.modelId,
    max_tokens: 4096,
    stream: true,
    messages: payload.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content })),
  };
  const systemMsg = payload.messages.find((m) => m.role === 'system');

  log.debug('POST', { url });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ ...body, ...(systemMsg ? { system: systemMsg.content } : {}) }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    log.error('HTTP error', { status: resp.status, body: text.slice(0, 500) });
    throw new Error(`API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  // Parse SSE stream
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const evt = JSON.parse(data);

        // Anthropic: content_block_delta with text_delta
        if (evt.type === 'content_block_delta' && evt.delta?.text) {
          wc.send('chat:delta', { text: evt.delta.text });
          tokenCount++;
        }

        // OpenAI-compat fallback (some Anthropic proxies return OpenAI format)
        if (evt.choices?.[0]?.delta?.content) {
          wc.send('chat:delta', { text: evt.choices[0].delta.content });
          tokenCount++;
        }
      } catch (e) {
        // Malformed SSE line — log so malformed streams leave a trace.
        log.warn('SSE line parse failed', { line: line.slice(0, 100), error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  log.info('Anthropic stream done', { tokens: tokenCount });
}

// ── OpenAI Chat Completions streaming ──────────────────────────

async function streamOpenAI(
  wc: Electron.WebContents,
  provider: { apiKey: string; baseUrl: string },
  payload: ChatPayload,
  signal: AbortSignal,
) {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: payload.modelId,
    stream: true,
    messages: payload.messages,
  };

  log.debug('POST', { url });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text();
    log.error('HTTP error', { status: resp.status, body: text.slice(0, 500) });
    throw new Error(`API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done || signal.aborted) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const evt = JSON.parse(data);
        const content = evt.choices?.[0]?.delta?.content;
        if (content) {
          wc.send('chat:delta', { text: content });
          tokenCount++;
        }
      } catch (e) {
        log.warn('SSE line parse failed', { line: line.slice(0, 100), error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  log.info('OpenAI stream done', { tokens: tokenCount });
}
