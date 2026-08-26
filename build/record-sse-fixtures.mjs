#!/usr/bin/env bun
/**
 * Day-zero SSE fixture recorder (Tauri rewrite, see
 * docs/plans/2026-08-27-tauri-rewrite-design.md — "Record SSE fixtures").
 *
 * Drives the REAL TS adapter stack — provider-factory.resolveModel,
 * protocols.resolveReasoning/resolveProtocolOptions, and ai@7 streamText
 * (which includes the orchestrator's repairToolCall wiring) — against a
 * local mock SSE server on 127.0.0.1. No network, no API keys. The mock
 * payloads are synthetic, hand-crafted from the Anthropic Messages and
 * OpenAI chat-completions streaming wire formats.
 *
 * For each scenario it records:
 *   - the exact HTTP request the adapter stack sent (URL, headers, JSON
 *     body — showing the computed max_tokens / thinking / reasoning_effort,
 *     so carve + strip behaviors are visible),
 *   - the raw SSE bytes the mock served,
 *   - the normalized TextStreamPart sequence the adapter emitted
 *     (the boundary orchestrator.ts translatePart consumes),
 *   - a derived projection to Tide UI events (translatePart's switch).
 *
 * Output: src-tauri/crates/tide-engine/fixtures/sse/<name>.json
 *
 * Temporary scaffolding — deleted together with app/ in a later task.
 * Run: bun build/record-sse-fixtures.mjs
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { streamText, tool } from 'ai';
import { z } from 'zod';

const ROOT = path.resolve(import.meta.dir, '..');
const OUT_DIR = path.join(ROOT, 'src-tauri/crates/tide-engine/fixtures/sse');

const { resolveModel } = await import(
  pathToFileURL(path.join(ROOT, 'app/core/agent/provider-factory.ts')).href
);
const { resolveReasoning, resolveProtocolOptions } = await import(
  pathToFileURL(path.join(ROOT, 'app/core/agent/protocols/index.ts')).href
);
const { repairJsonToolInput } = await import(
  pathToFileURL(path.join(ROOT, 'app/core/agent/tool-input-repair.ts')).href
);

const pkgVersion = (p) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', p, 'package.json'), 'utf8')).version;

const SDK_VERSIONS = {
  ai: pkgVersion('ai'),
  '@ai-sdk/anthropic': pkgVersion('@ai-sdk/anthropic'),
  '@ai-sdk/openai-compatible': pkgVersion('@ai-sdk/openai-compatible'),
  zod: pkgVersion('zod'),
};

// ── Deterministic ids for the SDK-generated parts (re-record diffs stay clean) ──
let idCounter = 0;
const fixedGenerateId = () => `gen-${String(++idCounter).padStart(3, '0')}`;
const fixedNow = () => 0;

// ── SSE payload builders ──────────────────────────────────────────────────

/** Anthropic Messages streaming frames. Each arg is [eventName, dataObject]. */
const aFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function anthropicPlainSse() {
  return [
    aFrame('message_start', { type: 'message_start', message: { id: 'msg_mock_anthropic_plain', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } }),
    aFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The file has 42 lines ' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'and one TODO ' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'on line 17.' } }),
    aFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    aFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 18 } }),
    aFrame('message_stop', { type: 'message_stop' }),
  ].join('');
}

function anthropicThinkingSse() {
  return [
    aFrame('message_start', { type: 'message_start', message: { id: 'msg_mock_anthropic_think', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } }),
    aFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user asked about the flaky test. ' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Midnight flakiness usually means a timezone-dependent assertion. ' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should check for Date.now mocking first.' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'mock-signature-0123456789' } }),
    aFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    aFrame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'The test flakes near midnight because ' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the assertion compares UTC-formatted timestamps ' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'against a local-time fixture.' } }),
    aFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    aFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 412 } }),
    aFrame('message_stop', { type: 'message_stop' }),
  ].join('');
}

function anthropicToolSse() {
  return [
    aFrame('message_start', { type: 'message_start', message: { id: 'msg_mock_anthropic_tool', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 55, output_tokens: 1 } } }),
    aFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me read that file.' } }),
    aFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    aFrame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_mock_anthropic_01', name: 'read_file', input: {} } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pa' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'th": "/tm' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'p/exam' } }),
    aFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ple.txt"}' } }),
    aFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    aFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 64 } }),
    aFrame('message_stop', { type: 'message_stop' }),
  ].join('');
}

/** OpenAI chat.completions streaming frames. */
const oFrame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const oChunk = (id, model, delta, finishReason = null, extra = {}) =>
  oFrame({ id, object: 'chat.completion.chunk', created: 1756300000, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra });

function openaiPlainSse() {
  let s = oChunk('chatcmpl-mock-openai-plain', 'gpt-5.2', { role: 'assistant', content: '' });
  s += oChunk('chatcmpl-mock-openai-plain', 'gpt-5.2', { content: 'The file has 42 lines ' });
  s += oChunk('chatcmpl-mock-openai-plain', 'gpt-5.2', { content: 'and one TODO ' });
  s += oChunk('chatcmpl-mock-openai-plain', 'gpt-5.2', { content: 'on line 17.' });
  s += oFrame({ id: 'chatcmpl-mock-openai-plain', object: 'chat.completion.chunk', created: 1756300000, model: 'gpt-5.2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 18, total_tokens: 60 } });
  return s + 'data: [DONE]\n\n';
}

function openaiZaiThinkingSse() {
  let s = oChunk('chatcmpl-mock-zai-think', 'glm-4.6', { role: 'assistant', content: '' });
  // GLM reasoning arrives as reasoning_content deltas alongside (or before) content.
  s += oChunk('chatcmpl-mock-zai-think', 'glm-4.6', { reasoning_content: 'Flaky near midnight — ' });
  s += oChunk('chatcmpl-mock-zai-think', 'glm-4.6', { reasoning_content: 'probably a timezone-dependent assertion. ' });
  s += oChunk('chatcmpl-mock-zai-think', 'glm-4.6', { reasoning_content: 'Check Date.now mocking first.' });
  s += oChunk('chatcmpl-mock-zai-think', 'glm-4.6', { content: 'The test flakes near midnight because ' });
  s += oChunk('chatcmpl-mock-zai-think', 'glm-4.6', { content: 'the assertion compares UTC timestamps ' });
  s += oChunk('chatcmpl-mock-zai-think', 'glm-4.6', { content: 'against a local-time fixture.' });
  s += oFrame({ id: 'chatcmpl-mock-zai-think', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 412, total_tokens: 454, completion_tokens_details: { reasoning_tokens: 384 } } });
  return s + 'data: [DONE]\n\n';
}

function openaiZaiToolSse() {
  let s = oChunk('chatcmpl-mock-zai-tool', 'glm-4.6', { role: 'assistant', content: '' });
  s += oFrame({ id: 'chatcmpl-mock-zai-tool', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-mock-zai-01', type: 'function', function: { name: 'read_file', arguments: '' } }] }, finish_reason: null }] });
  s += oFrame({ id: 'chatcmpl-mock-zai-tool', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }, finish_reason: null }] });
  s += oFrame({ id: 'chatcmpl-mock-zai-tool', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "/tmp/exam' } }] }, finish_reason: null }] });
  s += oFrame({ id: 'chatcmpl-mock-zai-tool', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ple.txt"}' } }] }, finish_reason: null }] });
  s += oChunk('chatcmpl-mock-zai-tool', 'glm-4.6', { content: 'Reading the file now.' });
  s += oFrame({ id: 'chatcmpl-mock-zai-tool', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 55, completion_tokens: 64, total_tokens: 119 } });
  return s + 'data: [DONE]\n\n';
}

/** GLM-style malformed tool input: a duplicated object — the accumulated
 *  arguments are not valid JSON, exercising repairToolCall → repairJsonToolInput. */
function openaiZaiMalformedToolSse() {
  let s = oChunk('chatcmpl-mock-zai-bad', 'glm-4.6', { role: 'assistant', content: '' });
  s += oFrame({ id: 'chatcmpl-mock-zai-bad', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-mock-zai-02', type: 'function', function: { name: 'read_file', arguments: '' } }] }, finish_reason: null }] });
  const dup = '{"path": "/tmp/example.txt"}';
  s += oFrame({ id: 'chatcmpl-mock-zai-bad', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: dup } }] }, finish_reason: null }] });
  s += oFrame({ id: 'chatcmpl-mock-zai-bad', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: dup } }] }, finish_reason: null }] });
  s += oFrame({ id: 'chatcmpl-mock-zai-bad', object: 'chat.completion.chunk', created: 1756300000, model: 'glm-4.6', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 55, completion_tokens: 64, total_tokens: 119 } });
  return s + 'data: [DONE]\n\n';
}

// ── Scenario table ────────────────────────────────────────────────────────

const readFileTool = tool({
  description: 'Read a file from the local filesystem.',
  inputSchema: z.object({ path: z.string().describe('Absolute file path') }),
});

const SCENARIOS = [
  {
    name: 'anthropic-plain-text',
    summary: 'Anthropic protocol, thinking off, no tools — baseline text streaming.',
    apiStyle: 'anthropic', host: 'api.anthropic.com', modelId: 'claude-sonnet-4-5',
    thinkingLevel: 'off', contracts: [{ type: 'budget_tokens' }],
    maxOutputTokens: 8192, hasTools: false,
    messages: [{ role: 'user', content: 'Summarize /tmp/example.txt.' }],
    sse: anthropicPlainSse(),
  },
  {
    name: 'anthropic-thinking-budget',
    summary: 'Anthropic protocol via api.z.ai host with budget_tokens thinking + tools: budget carved out of the floored output pool (never stacked), thinking_delta → reasoning parts.',
    apiStyle: 'anthropic', host: 'api.z.ai', modelId: 'claude-sonnet-4-5',
    thinkingLevel: 'high', contracts: [{ type: 'budget_tokens' }],
    maxOutputTokens: 8192, hasTools: true,
    messages: [{ role: 'user', content: 'Why does test/time-format.test.ts flake near midnight?' }],
    sse: anthropicThinkingSse(),
  },
  {
    name: 'anthropic-tool-call-streamed-input',
    summary: 'Anthropic protocol tool_use with streamed input_json_delta fragments; tool-output floor raises wire max_tokens.',
    apiStyle: 'anthropic', host: 'api.anthropic.com', modelId: 'claude-sonnet-4-5',
    thinkingLevel: 'off', contracts: [{ type: 'budget_tokens' }],
    maxOutputTokens: 8192, hasTools: true,
    messages: [{ role: 'user', content: 'Read /tmp/example.txt and summarize it.' }],
    sse: anthropicToolSse(),
  },
  {
    name: 'anthropic-non-native-thinking-strip',
    summary: 'Anthropic protocol on a non-allowlisted host (OpenRouter-style aggregator): reasoning instruction resolved but the thinking block is STRIPPED from the request.',
    apiStyle: 'anthropic', host: 'openrouter.local', modelId: 'anthropic/claude-sonnet-4.5',
    thinkingLevel: 'high', contracts: [{ type: 'budget_tokens' }],
    maxOutputTokens: 8192, hasTools: true,
    messages: [{ role: 'user', content: 'Why does test/time-format.test.ts flake near midnight?' }],
    sse: anthropicPlainSse(),
  },
  {
    name: 'openai-plain-text',
    summary: 'OpenAI-compatible protocol, thinking off — baseline chat.completion.chunk streaming.',
    apiStyle: 'openai', host: 'api.openai.local', modelId: 'gpt-5.2',
    thinkingLevel: 'off', contracts: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    maxOutputTokens: 8192, hasTools: false,
    messages: [{ role: 'user', content: 'Summarize /tmp/example.txt.' }],
    sse: openaiPlainSse(),
  },
  {
    name: 'openai-zai-thinking',
    summary: 'OpenAI-compatible (z.ai GLM shape): budget_tokens contract lossily derives reasoning_effort; reasoning_content deltas split into reasoning parts vs text.',
    apiStyle: 'openai', host: 'api.z.ai', modelId: 'glm-4.6',
    thinkingLevel: 'high', contracts: [{ type: 'budget_tokens' }],
    maxOutputTokens: 8192, hasTools: false,
    messages: [{ role: 'user', content: 'Why does test/time-format.test.ts flake near midnight?' }],
    sse: openaiZaiThinkingSse(),
  },
  {
    name: 'openai-zai-tool-call',
    summary: 'OpenAI-compatible tool_calls chunks with streamed function.arguments; interleaved content + tool deltas; tool-output floor raises wire max_tokens.',
    apiStyle: 'openai', host: 'api.z.ai', modelId: 'glm-4.6',
    thinkingLevel: 'off', contracts: [{ type: 'budget_tokens' }],
    maxOutputTokens: 8192, hasTools: true,
    messages: [{ role: 'user', content: 'Read /tmp/example.txt and summarize it.' }],
    sse: openaiZaiToolSse(),
  },
  {
    name: 'openai-zai-malformed-tool-input',
    summary: 'GLM-style duplicated tool-input fragments: accumulated arguments fail JSON parse → repairToolCall → repairJsonToolInput keeps the LAST parseable object.',
    apiStyle: 'openai', host: 'api.z.ai', modelId: 'glm-4.6',
    thinkingLevel: 'off', contracts: [{ type: 'budget_tokens' }],
    maxOutputTokens: 8192, hasTools: true,
    messages: [{ role: 'user', content: 'Read /tmp/example.txt and summarize it.' }],
    sse: openaiZaiMalformedToolSse(),
  },
];

const SYSTEM_PROMPT = 'You are Tide, a local-first coding assistant.';

// ── Mock SSE server ───────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** slug → raw SSE string; filled per scenario run. */
const servedSse = new Map();

function startMockServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const slug = new URL(req.url, 'http://127.0.0.1').pathname.split('/').filter(Boolean)[0];
        const sse = servedSse.get(slug);
        if (!sse) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `no canned SSE for scenario "${slug}"` }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        // Serve frame-by-frame so the SDK genuinely parses a chunked stream.
        for (const frame of sse.split(/(?<=\n\n)/)) {
          await sleep(5);
          if (!frame) continue;
          await new Promise((r) => res.write(frame, 'utf8', r));
        }
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ── Global fetch interception ─────────────────────────────────────────────
// provider-factory's diagnostic fetch calls global fetch with the provider's
// real base URL (e.g. http://api.z.ai:<port>/...). Rewrite host:port to the
// local mock while RECORDING the original URL — that keeps
// protocols/anthropic.ts's host allowlist (api.z.ai, api.anthropic.com)
// behaviorfully exercised.

const recordedRequests = new Map(); // slug → request record

function headersToObj(h) {
  if (!h) return {};
  if (typeof h.entries === 'function') return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h };
}

function installFetchInterceptor(port) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(urlStr);
    const slug = u.pathname.split('/').filter(Boolean)[0];
    recordedRequests.set(slug, {
      url: urlStr,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers: headersToObj(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : '(non-string body)',
    });
    const local = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
    return realFetch.call(globalThis, local, init);
  };
  return () => { globalThis.fetch = realFetch; };
}

// ── Serialization ─────────────────────────────────────────────────────────

function toJSONable(v, depth = 0) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (depth > 12) return '(depth limit)';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'function' || typeof v === 'undefined') return undefined;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, val]) => [k, toJSONable(val, depth + 1)]));
  if (v instanceof Set) return [...v].map((x) => toJSONable(x, depth + 1));
  if (Array.isArray(v)) return v.map((x) => toJSONable(x, depth + 1));
  if (v instanceof Uint8Array) return `(uint8[${v.length}])`;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const s = toJSONable(val, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

/** Derived projection of the adapter's TextStreamParts onto the Tide event
 *  names the orchestrator emits — mirrors the switch in
 *  app/core/agent/orchestrator.ts translatePart(). Part types translatePart
 *  ignores (start/text-start/text-end/finish/raw/...) are omitted. */
function projectTideEvents(parts) {
  const out = [];
  for (const p of parts) {
    switch (p.type) {
      case 'text-delta':
        if (p.text) out.push({ type: 'delta', text: p.text });
        break;
      case 'reasoning-delta':
        if (p.text) out.push({ type: 'reasoning', delta: p.text });
        break;
      case 'tool-input-start':
        out.push({ type: 'tool_call_start', toolCallId: p.id, toolName: p.toolName });
        break;
      case 'tool-input-delta':
        out.push({ type: 'tool_call_delta', toolCallId: p.id, delta: p.delta ?? '' });
        break;
      case 'tool-call':
        out.push({ type: 'tool_call', toolCallId: p.toolCallId, toolName: p.toolName, arguments: p.input });
        break;
      case 'finish-step':
        if (p.usage) out.push({ type: 'usage', tokens: p.usage });
        break;
      case 'error':
        out.push({ type: 'error', message: p.errorText ?? String(p.error ?? 'Stream error') });
        break;
      default:
        break;
    }
  }
  return out;
}

// ── Scenario runner ───────────────────────────────────────────────────────

async function runScenario(sc, port) {
  const provider = {
    id: `mock-${sc.host.replace(/\./g, '-')}`,
    name: `Mock ${sc.host}`,
    apiStyle: sc.apiStyle,
    baseUrl: `http://${sc.host}:${port}/${sc.name}`,
    apiKey: 'test-key-local-mock',
    enabled: true,
    models: [],
  };
  const modelEntry = {
    id: 'mock-model', alias: 'Mock Model', modelId: sc.modelId,
    contextWindow: 200_000, providerId: provider.id,
    max_completion_tokens: sc.maxOutputTokens,
    reasoning: true,
  };

  const model = resolveModel(provider, modelEntry);

  const reasoning = resolveReasoning(sc.thinkingLevel, sc.contracts, sc.apiStyle, sc.maxOutputTokens);

  // Mirror the orchestrator's two-phase resolution (orchestrator.ts ~416/456):
  // baseProtocol from the model's known max output, then per-step resolution
  // re-fed with baseProtocol.maxOutputTokens (the tool floor re-applies).
  const baseCtx = { hasTools: sc.hasTools, modelId: sc.modelId, maxOutputTokens: sc.maxOutputTokens, providerBaseUrl: provider.baseUrl };
  const baseProtocol = resolveProtocolOptions(sc.apiStyle, reasoning, baseCtx);
  const perStep = resolveProtocolOptions(sc.apiStyle, reasoning, {
    ...baseCtx,
    maxOutputTokens: baseProtocol.maxOutputTokens,
  });

  servedSse.set(sc.name, sc.sse);

  const events = [];
  let streamError = null;
  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    messages: sc.messages,
    tools: sc.hasTools ? { read_file: readFileTool } : undefined,
    toolChoice: sc.hasTools ? undefined : 'none',
    maxRetries: 0,
    maxOutputTokens: perStep.maxOutputTokens,
    providerOptions: perStep.providerOptions,
    repairToolCall: async ({ toolCall }) => {
      const input = toolCall.input;
      if (typeof input !== 'string') return toolCall;
      const repaired = repairJsonToolInput(input);
      return repaired ? { ...toolCall, input: repaired } : null;
    },
    onError: ({ error }) => { streamError = error?.message ?? String(error); },
    _internal: { now: fixedNow, generateId: fixedGenerateId, generateCallId: fixedGenerateId },
  });

  for await (const part of result.stream) {
    events.push(toJSONable(part));
  }

  const request = recordedRequests.get(sc.name);
  return {
    scenario: sc.name,
    summary: sc.summary,
    recordedAt: new Date().toISOString(),
    provenance: {
      server: 'synthetic local mock SSE server (127.0.0.1) — no external network, no API keys',
      adapterCode: 'real TS adapter stack (app/core/agent/protocols + provider-factory + ai SDK streamText)',
      liveRecording: 'deferred to tide-engine record mode (M2) per docs/plans/2026-08-27-tauri-rewrite-design.md',
      sdkVersions: SDK_VERSIONS,
    },
    input: {
      provider: { apiStyle: sc.apiStyle, baseUrl: provider.baseUrl, modelId: sc.modelId },
      system: SYSTEM_PROMPT,
      messages: sc.messages,
      tools: sc.hasTools ? ['read_file (zod: { path: string })'] : [],
      thinkingLevel: sc.thinkingLevel,
      reasoningContracts: sc.contracts,
      modelMaxOutputTokens: sc.maxOutputTokens,
    },
    resolution: {
      reasoningInstruction: reasoning,
      baseProtocol,
      perStepCall: perStep,
    },
    request,
    sse: sc.sse,
    events,
    tideEvents: projectTideEvents(events),
    ...(streamError ? { streamError } : {}),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

const server = await startMockServer();
const port = server.address().port;
const restoreFetch = installFetchInterceptor(port);

fs.mkdirSync(OUT_DIR, { recursive: true });
const failed = [];
for (const sc of SCENARIOS) {
  try {
    const fixture = await runScenario(sc, port);
    const file = path.join(OUT_DIR, `${sc.name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    const evTypes = fixture.events.map((e) => e.type);
    console.log(`✓ ${sc.name}  →  ${path.relative(ROOT, file)}`);
    console.log(`    events: ${evTypes.join(', ')}`);
  } catch (err) {
    failed.push(sc.name);
    console.error(`✗ ${sc.name}: ${err?.stack ?? err}`);
  }
}

restoreFetch();
server.close();

if (failed.length > 0) {
  console.error(`\n${failed.length} scenario(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nWrote ${SCENARIOS.length} fixtures to ${path.relative(ROOT, OUT_DIR)}/`);
