/**
 * Anthropic Messages API streaming, tool-aware.
 *
 * Replaces the older `streamAnthropic` in `electron/ipc/chat.ts`. Handles
 * every SSE event type the orchestrator needs:
 *
 *   - `content_block_start` with `tool_use`   → onToolCallStart
 *   - `content_block_delta` with `text_delta` → onDelta (assistant text)
 *   - `content_block_delta` with `thinking_delta` → onReasoning
 *   - `content_block_delta` with `input_json_delta` → onToolCallDelta
 *   - `content_block_stop`                     → close any open tool call
 *   - `message_delta` with `delta.stop_reason` + `usage` → onUsage + stopReason
 *   - `message_stop`                           → end stream
 *
 * Also falls back to OpenAI-shaped events for Anthropic-compatible proxies
 * that respond in OpenAI format (some z.ai routes do this).
 */

import type { Usage } from '../../src/types/index';
import { createLogger } from '../logger.js';
// undici ships with Node 18+ — used here for HTTP keep-alive across calls.
// Without a shared dispatcher, every streamAnthropicOnce call opens a fresh
// TCP+TLS handshake (~100-400ms each on cold connections to api.anthropic.com).
// With keep-alive, the connection is reused across iterations within a turn
// AND across sub-agent dispatches — eliminating that per-call latency floor.
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * Shared connection pool for Anthropic (and Anthropic-compatible) endpoints.
 *
 *   keepAliveTimeout — idle connection kept open for 5 min (Anthropic's
 *     server-side idle limit is generous; this matches typical proxy behavior).
 *   connections — allows up to 16 concurrent in-flight requests per origin,
 *     which covers the parent turn + several parallel sub-agent dispatches.
 *
 * This is module-scoped: the same pool is reused for the lifetime of the
 * process. The first call eats the handshake; every subsequent call to the
 * same baseUrl reuses the warm socket.
 */
const agent = new Agent({
  keepAliveTimeout: 5 * 60 * 1000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
  connections: 16,
});

const log = createLogger('stream');

/** A tool call accumulated during streaming. */
export interface StreamedToolCall {
  id: string;
  toolName: string;
  /** Raw JSON string fragments collected from input_json_delta events. */
  inputJsonParts: string[];
}

export interface StreamResult {
  /** Stop reason from `message_delta` (or null if unknown). */
  stopReason: string | null;
  /** Per-call usage from `message_delta.usage`. */
  usage: Usage | null;
}

/** Callbacks fired as events arrive. */
export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onReasoning: (delta: string) => void;
  onToolCallStart: (id: string, toolName: string) => void;
  onToolCallDelta: (id: string, delta: string) => void;
  onToolCallEnd: (id: string, toolName: string, parsedArgs: Record<string, unknown>) => void;
  onUsage: (usage: Usage) => void;
}

interface Provider {
  apiKey: string;
  baseUrl: string;
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  stream: true;
  /** Anthropic accepts `system` as either a plain string OR an array of
   *  text blocks. The array form supports `cache_control` markers for
   *  prompt caching — we always use the array form so caching kicks in. */
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description: string; input_schema: unknown; cache_control?: { type: 'ephemeral' } }>;
  /**
   * Anthropic-native extended thinking payload.
   * Per https://platform.claude.com/docs/en/build-with-claude/extended-thinking:
   *   - `{ type: 'enabled', budget_tokens: N }` — cap reasoning at N tokens
   *     (minimum 1024). When set, max_tokens MUST exceed budget_tokens.
   *   - `{ type: 'disabled' }` — thinking off entirely.
   */
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
}

/**
 * Anthropic content-block shape for messages we send back to the model.
 * Either a plain text string or an array of typed blocks (text/tool_use/tool_result).
 */
type AnthropicContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
    >;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContent;
}

/**
 * Run a single model call against the Anthropic Messages API and stream events.
 * Resolves with the final stop reason + usage. Throws on HTTP errors.
 */
export async function streamAnthropicOnce(
  provider: Provider,
  payload: {
    modelId: string;
    system: string;
    /** Conversation history in the rich Anthropic shape. */
    messages: AnthropicMessage[];
    /** Tool definitions to expose to the model. */
    tools?: Array<{ name: string; description: string; input_schema: unknown }>;
    /**
     * Anthropic-native extended thinking payload (see THINKING_BUDGET in
     * orchestrator.ts). `null` = disabled; an object is sent verbatim.
     */
    thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' } | null;
    maxTokens?: number;
  },
  signal: AbortSignal,
  cb: StreamCallbacks,
): Promise<StreamResult> {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`;

  // Enforce the docs' constraint: when thinking is enabled, max_tokens MUST
  // exceed budget_tokens. Default the output cap to budget + 8192 if the
  // caller didn't pass an explicit maxTokens.
  let maxTokens = payload.maxTokens ?? 8192;
  if (payload.thinking && payload.thinking.type === 'enabled' && maxTokens <= payload.thinking.budget_tokens) {
    maxTokens = payload.thinking.budget_tokens + 8192;
  }

  // ─── Prompt caching ────────────────────────────────────────────
  // Anthropic prompt caching (and z.ai's Anthropic-compatible endpoint)
  // lets the provider cache a prefix of the prompt for ~5 min. Marking
  // `cache_control: { type: 'ephemeral' }` on the last block of a cacheable
  // section tells the provider "everything up to here can be reused if the
  // next call sends the same prefix." For Tide this matters in three places:
  //
  //   1. System prompt — identical across every dispatch to the same agent.
  //      First call eats the processing; subsequent dispatches (within 5 min)
  //      skip ~1-2s of re-processing.
  //
  //   2. Tool definitions — the 20 built-in tools are identical across every
  //      parent iteration. Caching the LAST tool's definition marks the whole
  //      tool list as cacheable. Saves ~0.5-1s per iteration after the first.
  //
  //   3. Conversation history — grows each iteration. Marking the last
  //      message's last content block makes iteration N+1's prefix a cache
  //      hit up to the new assistant turn + tool result.
  //
  // If the provider doesn't support caching, `cache_control` is silently
  // ignored — no breakage, just no benefit. The usage response includes
  // `cache_read_input_tokens` / `cache_creation_input_tokens` to confirm.
  const CACHE = { type: 'ephemeral' } as const;

  // System prompt — array form with cache_control on the (single) block.
  const systemBlocks = payload.system
    ? [{ type: 'text' as const, text: payload.system, cache_control: CACHE }]
    : undefined;

  // Tools — mark cache_control on the LAST tool only (the cache prefix
  // extends up to and including the marked block).
  const tools = payload.tools && payload.tools.length > 0
    ? payload.tools.map((t, i) =>
        i === payload.tools.length - 1
          ? { ...t, cache_control: CACHE }
          : t,
      )
    : undefined;

  // Conversation history — mark cache_control on the last content block of
  // the last message. Deep-clones the messages array so we don't mutate
  // the caller's conversation state.
  const messages = payload.messages.map((msg, i) => {
    if (i !== payload.messages.length - 1) return msg;
    if (typeof msg.content === 'string') {
      // String content → convert to a single text block with cache_control.
      return { ...msg, content: [{ type: 'text' as const, text: msg.content, cache_control: CACHE }] };
    }
    if (!Array.isArray(msg.content) || msg.content.length === 0) return msg;
    // Array content → mark the LAST block.
    const content = msg.content.map((block, j) =>
      j === msg.content.length - 1
        ? { ...block, cache_control: CACHE }
        : block,
    );
    return { ...msg, content };
  });

  const body: AnthropicRequestBody = {
    model: payload.modelId,
    max_tokens: maxTokens,
    stream: true,
    system: systemBlocks,
    messages,
  };
  if (tools) body.tools = tools;
  // Two cases:
  //   - explicit thinking payload (enabled or disabled) → send verbatim
  //   - undefined/null → send thinking.type:'disabled' so the model doesn't
  //     burn tokens reasoning when the user didn't ask for it
  body.thinking = payload.thinking ?? { type: 'disabled' };

  const effortLog = payload.thinking && payload.thinking.type === 'enabled'
    ? `budget=${payload.thinking.budget_tokens}`
    : 'off';
  log.debug('POST', { url, tools: payload.tools?.length ?? 0, thinking: effortLog, maxTokens });

  const resp = await undiciFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
    // Reuse the warm TCP+TLS connection from the shared pool instead of
    // opening a fresh handshake per call. Major win for turns that do
    // multiple iterations or dispatch multiple sub-agents.
    dispatcher: agent,
  });

  if (!resp.ok) {
    const text = await resp.text();
    log.error('HTTP error', { status: resp.status, body: text.slice(0, 500) });
    throw new Error(`Anthropic API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let stopReason: string | null = null;
  let usage: Usage | null = null;

  // Per-block state — Anthropic emits content_block_start/delta/stop keyed by `index`.
  const openBlocks = new Map<number, { type: string; id?: string; name?: string; jsonParts: string[] }>();

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

      let evt: any;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }

      // ─── Anthropic event types ──────────────────────────────

      if (evt.type === 'content_block_start' && evt.index != null) {
        const block = evt.content_block ?? {};
        openBlocks.set(evt.index, { type: block.type ?? 'text', id: block.id, name: block.name, jsonParts: [] });
        if (block.type === 'tool_use' && block.id && block.name) {
          cb.onToolCallStart(block.id, block.name);
        }
        continue;
      }

      if (evt.type === 'content_block_delta' && evt.index != null) {
        const open = openBlocks.get(evt.index);
        const delta = evt.delta ?? {};

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          cb.onDelta(delta.text);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          cb.onReasoning(delta.thinking);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (open) open.jsonParts.push(delta.partial_json);
          if (open?.id) cb.onToolCallDelta(open.id, delta.partial_json);
        }
        // OpenAI-compat fallback — some Anthropic proxies emit OpenAI shapes.
        if (delta.content && typeof delta.content === 'string') {
          cb.onDelta(delta.content);
        }
        continue;
      }

      if (evt.type === 'content_block_stop' && evt.index != null) {
        const open = openBlocks.get(evt.index);
        if (open?.type === 'tool_use' && open.id && open.name) {
          let parsedArgs: Record<string, unknown> = {};
          if (open.jsonParts.length > 0) {
            try {
              parsedArgs = JSON.parse(open.jsonParts.join(''));
            } catch {
              // leave empty — orchestrator will surface as failed tool call
            }
          }
          cb.onToolCallEnd(open.id, open.name, parsedArgs);
        }
        openBlocks.delete(evt.index);
        continue;
      }

      if (evt.type === 'message_delta') {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) {
          usage = {
            inputTokens: evt.usage.input_tokens ?? usage?.inputTokens ?? 0,
            outputTokens: evt.usage.output_tokens ?? usage?.outputTokens ?? 0,
            cacheRead: evt.usage.cache_read_input_tokens ?? usage?.cacheRead ?? 0,
            cacheWrite: evt.usage.cache_creation_input_tokens ?? usage?.cacheWrite ?? 0,
            reasoningTokens: 0, // not surfaced separately by Anthropic in message_delta
            calls: (usage?.calls ?? 0) + 1,
            costUsd: 0,
          };
          if (usage) cb.onUsage(usage);
        }
        continue;
      }

      if (evt.type === 'message_start' && evt.message?.usage) {
        // message_start carries the input-side usage. Combine with message_delta's output-side.
        const u = evt.message.usage;
        usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          reasoningTokens: 0,
          calls: 1,
          costUsd: 0,
        };
        // Cache diagnostics — shows whether the provider honored our
        // cache_control markers. cacheRead > 0 = cache hit (fast path);
        // cacheWrite > 0 = cache miss but wrote to cache (first call);
        // both 0 = provider doesn't support caching or prompt changed.
        const cacheStatus = usage.cacheRead > 0
          ? `cache hit (${usage.cacheRead} tokens)`
          : usage.cacheWrite > 0
            ? `cache miss, wrote ${usage.cacheWrite} tokens`
            : 'no cache';
        log.debug('cache status', { cache: cacheStatus });
        cb.onUsage(usage);
        continue;
      }

      if (evt.type === 'message_stop') {
        break;
      }

      if (evt.type === 'error') {
        throw new Error(`Anthropic stream error: ${evt.error?.message ?? JSON.stringify(evt.error)}`);
      }

      // ─── OpenAI-compat fallback (some proxies) ──────────────
      if (evt.choices?.[0]?.delta?.content) {
        cb.onDelta(evt.choices[0].delta.content);
      }
      if (evt.choices?.[0]?.delta?.reasoning_content) {
        cb.onReasoning(evt.choices[0].delta.reasoning_content);
      }
      if (evt.choices?.[0]?.finish_reason) {
        stopReason = mapOpenAiFinish(evt.choices[0].finish_reason);
      }
      if (evt.usage) {
        usage = {
          inputTokens: evt.usage.prompt_tokens ?? 0,
          outputTokens: evt.usage.completion_tokens ?? 0,
          cacheRead: evt.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWrite: 0,
          reasoningTokens: evt.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          calls: 1,
          costUsd: 0,
        };
        cb.onUsage(usage);
      }
    }
  }

  return { stopReason, usage };
}

function mapOpenAiFinish(reason: string): string {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'content_filter';
    default: return reason;
  }
}

export type { AnthropicMessage, AnthropicContent };
