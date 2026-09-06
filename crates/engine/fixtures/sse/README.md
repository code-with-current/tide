# SSE adapter-behavior fixtures (day-zero capture)

Behavioral spec for the Rust `tide-engine` crate's replay tests, recorded
from the **real TS adapter stack** before `app/` is deleted
(see `docs/plans/2026-08-27-tauri-rewrite-design.md`, "Day zero").

## Provenance

**Synthetic.** These were NOT recorded against live providers — no API keys
were available. A local mock SSE server on `127.0.0.1` (built into the
recorder script) served hand-crafted payloads following the Anthropic
Messages and OpenAI chat-completions streaming wire formats, while the real
adapter code ran against it. Live-provider recording is deferred to
`tide-engine`'s record mode in M2.

The adapter stack that ran (unmodified, imported directly):

- `app/core/agent/provider-factory.ts` — `resolveModel` (apiStyle dispatch,
  baseURL normalization incl. the `/v1` append, diagnostic fetch wrapper,
  SSE idle watchdog, non-stream 2xx rewrap)
- `app/core/agent/protocols/` — `resolveReasoning` (contract-aware thinking
  resolution) + `resolveProtocolOptions` (per-protocol wire params: thinking
  block, budget carve, effort mapping, strip logic, tool-output floor)
- `ai@7` `streamText` over `@ai-sdk/anthropic@4` / `@ai-sdk/openai-compatible@3`,
  including the orchestrator's exact `repairToolCall` wiring backed by
  `app/core/agent/tool-input-repair.ts` (`repairJsonToolInput`)

Global `fetch` was intercepted to reroute `api.anthropic.com` / `api.z.ai` /
`openrouter.local` hostnames to the local server, so the host-based
thinking-strip allowlist in `protocols/anthropic.ts` exercised its real
logic. Recorder: `build/record-sse-fixtures.mjs` (temporary scaffolding,
deleted with `app/`); run with `bun build/record-sse-fixtures.mjs`.

## Fixture shape

Each `<name>.json` contains:

| Key | Contents |
|---|---|
| `input` | Provider config, messages, tools, thinking level + contracts fed to the adapters |
| `resolution` | `reasoningInstruction`, `baseProtocol`, `perStepCall` — the protocol builders' output incl. the diagnostic `label` (carve/strip math is spelled out there) |
| `request` | The exact HTTP request the adapter stack sent: URL, headers, JSON body (shows computed `max_tokens`, `thinking`, `reasoning_effort`, tool schemas) |
| `sse` | The raw SSE bytes the mock served (verbatim, frame by frame) |
| `events` | The normalized `TextStreamPart` sequence the adapter emitted — the boundary `orchestrator.ts` `translatePart()` consumes |
| `tideEvents` | Derived projection onto Tide's UI event names (`delta`, `reasoning`, `tool_call_start/delta`, `tool_call`, `usage`), mirroring the `translatePart` switch; part types it ignores are omitted |

Notes: request URLs contain the recorder's ephemeral port (re-records will
differ there); SDK-generated ids were made deterministic via
`streamText`'s `_internal.generateId`.

## Scenarios

| Fixture | What it pins down |
|---|---|
| `anthropic-plain-text` | Baseline text streaming, thinking off: `max_tokens=8192` default, no thinking block |
| `anthropic-thinking-budget` | budget_tokens thinking via the `api.z.ai` host with tools: output pool floored to 16384, budget **carved out of it** (6553), never stacked — wire `max_tokens` stays 16384 while the SDK adds budgetTokens on top of the reduced 9831; `thinking_delta` → `reasoning-delta` parts |
| `anthropic-tool-call-streamed-input` | `input_json_delta` fragments accumulate into `tool-input-delta` parts and a parsed final `tool-call`; tool-output floor raises wire `max_tokens` to 16384 |
| `anthropic-non-native-thinking-strip` | Anthropic protocol on a non-allowlisted host (OpenRouter-style): reasoning instruction is resolved but the `thinking` block is **stripped** from the request (`label: "(non-native, thinking stripped)"`) |
| `openai-plain-text` | Baseline chat.completion.chunk streaming, thinking off |
| `openai-zai-thinking` | z.ai GLM shape: budget contract lossily derives `reasoning_effort=low`; `reasoning_content` deltas are split into reasoning vs text parts; usage separates `reasoningTokens` (384) from text output |
| `openai-zai-tool-call` | `tool_calls` chunks: name-first then streamed `function.arguments`; content delta interleaved between argument fragments |
| `openai-zai-malformed-tool-input` | GLM-style duplicated tool-input fragments: accumulated arguments fail JSON parse → `repairToolCall` → `repairJsonToolInput` keeps the LAST parseable object (the `remend` parity case) |

## Rust porting notes

- The carve rule (`protocols/anthropic.ts`): `budget = max(1024, min(requested, floor(maxBase*0.8), maxBase-1024))`, `streamText maxOutputTokens = maxBase - budget`, and the SDK stacks budget on top — so the wire `max_tokens` equals the (floored) pool. The per-step re-resolution does not compound because the 16384 tool floor re-applies to the carved value.
- The thinking-strip allowlist is host-based and currently exactly `{api.anthropic.com, api.z.ai}`.
- The TS stack has **no stream-side thinking filter** — reasoning deltas flow through untouched wherever the provider emits them. (The design doc's "strip thinking deltas for no-op models" post-filter is new Rust behavior, not a port; `openai-zai-thinking` records the pre-filter shape it will operate on.)
- The tool-input repair contract: on non-JSON input, scan top-level balanced objects and prefer the LAST parseable one, after stripping `<tool_call>`-style tags.
