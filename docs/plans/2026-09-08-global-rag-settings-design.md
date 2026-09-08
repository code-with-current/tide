# Global Memory & RAG Settings — Design (v2, research-informed)

Date: 2026-09-08 · Branch: `feature/global-rag-settings` · Status: design
v2 adds an embedding **dimension lock** and other changes adopted from
research into [supermemory](https://github.com/supermemoryai/supermemory)
(§6). An implementation plan follows separately.

## 0. Current state

| Fact | Where |
|---|---|
| Two hardcoded embedders: vendored local ONNX (`local-code-512`, 384d) and system-key cloud (`cloud-base`) | `crates/rag/src/resolve.rs:34` |
| No user-facing embedder choice; build always prefers local, cloud is a hidden fallback (`cloud_allowed` never persisted) | `crates/rag/src/resolve.rs:70` |
| Only persisted RAG setting is `rag_enabled_workspaces` | `crates/store/src/config.rs:35` |
| **vec0 DDL hardcodes 384 dims** (`EMBED_DIM`), blocking any other model | `crates/rag/src/store.rs:19` |
| Indexes already record `embedderId` per chunk and query-time resolves by it (never crosses vector spaces) | `crates/rag/src/resolve.rs:120` |
| Hybrid retrieval already exists: FTS5 (bm25) + vector fused via RRF k=60 | `crates/tools/src/tools/memory.rs:111`, `crates/backend/src/rag.rs:148` |
| Chunking is already AST-aware (tree-sitter, one chunk per top-level symbol) | `crates/rag/src/chunker.rs` |
| Local models live at `<data>/models/<MODEL_ID>/` (HF repo id keyed) | `crates/rag/src/embedder.rs:53` |
| UI: per-project enable/build card + knowledge sources; no model picker | `src/app/rag_settings.rs` |

## 1. Catalog and config model

**Embedding catalog** (`crates/rag/src/catalog.rs`, new). Static list of
curated local ONNX models. Display uses the **original HF model names**; the
short id stays internal (it is what `embedderId` records).

| id | original name (display) | dims | max tokens | languages |
|---|---|---|---|---|
| `local-code-512` | `isuruwijesiri/all-MiniLM-L6-v2-code-search-512` | 384 | 512 | en |
| `local-mle5-small` | `Xenova/multilingual-e5-small` | 384 | 512 | multilingual |
| `local-bge-m3` | `Xenova/bge-m3` | 1024 | 8192 | multilingual |

Each entry: id, display name, dim, max tokens, languages, HF base URL, file
list, download size. `local-code-512` stays vendored + default. The generic
`LocalOnnxEmbedder` keeps its shape; `MODEL_ID`/`MODEL_FILES`/`HF_BASE`
constants become per-entry data (the `<data>/models/<repo>/` layout already
supports multiple repos side by side).

The `languages` field exists because the default model is English-only:
non-English content ingests fine while **dense** recall silently weakens
(supermemory documents exactly this failure and ships multilingual local
models for it; our FTS lane keeps exact-token recall alive, but the dense
lane needs the right model). The picker badges entries "English" /
"Multilingual". Note `local-mle5-small` shares 384 dims with the default
while being a **different vector space** — the id-based lock (§2), not the
dims check, is what catches that switch.

**Config** — new `RagSettings` block in `crates/store/src/config.rs`, next to
`rag_enabled_workspaces`, all-optional fields (existing configs round-trip
via the `extra` flatten):

```jsonc
"rag": {
  "embedderId": "local-code-512",     // catalog id | "cloud-base" | "custom-<name>"
  "cloudAllowed": false,              // build-time fallback toggle
  "cloudModelId": null,               // sent to system OpenRouter endpoint
                                      // (TIDE_RAG_EMBEDDING_MODEL stays as fallback)
  "customEndpoints": [ /* §3 shape */ ],
  "topK": 5,
  "minSimilarity": null,
  "chunkSize": null,                  // null = chunker default
  "chunkOverlap": null
}
```

## 2. Resolution semantics and the switch flow

**The invariant (unchanged):** an index never crosses vector spaces. Query
time embeds with the embedder the index **records**, not the global config —
so after a switch, old local-built indexes stay queryable while the global
setting points elsewhere.

**New — embedding plan / dimension lock.** The vec0 table dimension is fixed
at `CREATE` time, so dims must be known before the DDL runs. Indexes gain a
meta record written **at creation, before the vec0 DDL**:

```jsonc
// meta key "embeddingPlan" in each rag/<workspaceId>/index.db (+ knowledge db)
{ "embedderId": "local-code-512", "dims": 384, "createdAt": 1694... }
```

- `RagStore::open_at` takes the intended plan (embedder id + dims) from the
  resolved embedder; it is used only when creating a fresh db. Existing dbs
  read the plan from meta. `SCHEMA_VERSION` → 3: v3 backfills
  `embeddingPlan = {local-code-512, 384}` (correct for every existing index —
  both current embedders are 384d) and the DDL parameterizes
  `float[{dims}]` instead of the hardcoded `EMBED_DIM` (`store.rs:19`).
- Every embed call — ingest **and** query — asserts `embedder_id` matches the
  plan and the vector length equals the plan dims. Violation is an explicit
  "rebuild required" error, never a silent empty result. Supermemory's
  v0.0.5 bug (write path used OpenAI, query path used local, exact-match
  searches silently returned `{"results":[]}`; fixed in v0.0.7 by locking an
  embedding plan in the store across all paths) is the cautionary tale — our
  per-index `embedderId` already prevented the id half; the plan record adds
  the dims half and makes both checks structural instead of belt-and-braces.

**Build time:** the configured `embedder_id` resolves through the catalog —
`local-*` needs its model downloaded (only the default stays vendored),
`cloud-base` needs the system key, `custom-*` needs a decryptable endpoint
key. Unavailable primary + `cloud_allowed` + cloud configured → cloud embeds
and the index honestly records `cloud-base` (same fallback as today). Ingest
into an index whose plan names a different embedder id is **blocked** (index
marked stale) rather than mixing spaces.

**Switch flow (ask-on-switch):** saving a new `embedder_id` (or chunking
values) returns the affected workspaces — enabled ones whose indexes were
built with a different embedder or older chunking. One dialog: **"Rebuild all
now"** (serialized background re-init via existing `RagInitWorkspace`,
aggregate progress) or **"Later"** — stale indexes stay queryable via their
recorded embedder and carry a "rebuild required" badge (the 2 s poll already
renders transient build states). Deleting a downloaded model or endpoint that
owns indexes shows the same confirm dialog.

## 3. Wire protocol and the settings UI

**New commands** (RAG family in `protocol.rs`, camelCase):

- `RagConfigGet` / `RagConfigUpdate` — update returns
  `affectedWorkspaces: Vec<RagAffectedWorkspace>` (project id, name, built-with
  embedder id) to drive the switch dialog
- `RagModelsList` — catalog joined with on-disk state: original name, dims,
  max tokens, languages, download size, downloaded/vendored status
- `RagModelDownload` / `RagModelDelete` — progress rides the existing event
  pump
- Rebuild-all composes existing per-workspace `RagInitWorkspace`

**BYOK endpoints** — key handling mirrors `TideAddProvider` (raw key travels
once on a dedicated command, encrypted at the daemon boundary via
`encrypted_key`, never echoed back):

```rust
RagEndpointAdd { name, base_url, model_id, api_key, max_tokens? } // -> RagEndpoint
RagEndpointSetKey { id, api_key }                                  // -> Ack
RagEndpointRemove { id }                                           // -> Ack
RagEndpointsList                                                   // -> Vec<RagEndpoint>
```

Persisted shape (config store; wire view is the same minus the key, plus
`hasKey: bool`): `{ id, name, baseUrl, modelId, dims, maxTokens }`.

`RagEndpointAdd` **probes before it persists**: one test embedding POST to
`<base_url>/embeddings`; the measured vector length becomes `dims`; upstream
HTTP/auth errors surface inline in the add sheet and nothing is saved. Auth is
`Bearer` only — covers OpenAI, OpenRouter, Together, Ollama
(`http://localhost:11434/v1`), LM Studio. A generalized `RemoteEmbedder
{ base_url, model, key }` (today's `CloudEmbedder` with injected credentials)
serves both `cloud-base` and custom ids.

**Key reuse** (adopted from supermemory's boot order — LLM keys load first so
embedding options can reuse them): the add sheet offers "use a key from an
existing provider" (the `secrets`/`encrypted_key` store already holds
provider keys), so the user who configured an OpenRouter/OpenAI provider
doesn't re-paste the key.

**UI — global "Memory & RAG" card stack** at the top of the Knowledge
settings page (existing `card_rows` / `settings_group_head` components):

1. **Embedding model card** — picker listing local catalog entries by
   original model name (sub-label: `local · 384 dim · 512 tokens · English ·
   downloaded`), `cloud-base` (system-key status), and custom endpoints.
   Custom endpoints get an add/edit sheet: name, base URL, model id, API key
   (paste or reuse a provider key).
2. **Local models card** — download/delete with size + progress bars.
3. **Retrieval card** — top-K, minimum similarity.
4. **Advanced card** — cloud fallback toggle, chunk size, chunk overlap
   (changes run through the affected-workspaces dialog when they invalidate
   indexes).

Switch dialog: affected projects + "Rebuild all now / Later".

## 4. Migration, errors, testing

**Migration:** absent `rag` key → today's behavior exactly
(`local-code-512`, fallback off, top-K 5, chunker defaults). Existing
indexes get the v3 plan backfill (§2) and keep working untouched — every
current embedder is 384d. `TIDE_RAG_EMBEDDING_MODEL` survives as the
`cloud_model_id` fallback. `extra` flatten keeps round-trips safe.

**Errors:** probe failure → inline upstream message, nothing persisted;
missing embedder at query/build (deleted model file, removed endpoint) →
explicit "rebuild required"; plan mismatch (id or dims) → explicit error,
never silent empty; rebuild-all is serialized and a failing workspace records
its error while the rest continue; destructive deletes confirm via the
affected-workspaces list.

**Testing:** resolve tests for catalog/custom resolution and blocked ingest
on plan mismatch — including the **same-dims/different-model** case
(`local-code-512` ↔ `local-mle5-small`) that only the id lock catches;
catalog integrity tests (dims, file lists, path layout); plan-lock tests
(fresh db with 768d model creates `float[768]` vec0; reopen asserts plan);
protocol tests that `RagConfigGet`/`RagEndpointsList` never leak keys;
backend tests for stale-marking and rebuild-all continuation; existing
fixture tests pass unchanged (default config ≡ current behavior).

**Prewarm** (adopted): daemon start prewarms the configured embedder when any
workspace has RAG enabled, so the first memory query doesn't pay cold-model
load. (Supermemory exposes pool/threads/batch knobs too — over-tuning at our
scale; skipped.)

**Deliberate cuts (YAGNI):** per-workspace embedder overrides, mixed-space
search, dim migration/re-projection, rerankers, non-Bearer auth styles,
worker pool tuning.

## 5. What research validated (no change needed)

- **Hybrid retrieval.** Supermemory's docs lean on hybrid keyword search to
  rescue recall when dense embeddings fail. We already fuse FTS5 bm25 +
  vector via RRF (k=60) on every memory query.
- **AST-aware chunking.** Already ours (tree-sitter, one chunk per top-level
  symbol, whole-file fallback).
- **No in-place model changes.** Supermemory: "not supported in place —
  fresh data directory or re-ingest." Our ask-on-switch rebuild is strictly
  friendlier (per-workspace indexes; stale ones remain queryable).

## 6. Research record — supermemoryai/supermemory

Read 2026-09-08: repo README, `apps/docs/self-hosting/embeddings.mdx`,
`apps/docs/self-hosting/configuration.mdx`, docs index. Adopted: dimension
lock via a stored embedding plan; multilingual catalog entries + UI badge;
startup prewarm; key-reuse ordering. Rejected as out of product class
(agent-memory platform, not code RAG): fact extraction/graph memory, user
profiles, connectors, managed SuperRAG.
