# Global Memory & RAG Settings — Implementation Plan

Design: [2026-09-08-global-rag-settings-design.md](2026-09-08-global-rag-settings-design.md)

Status: implemented on `feature/global-rag-settings` (commits dc33207 →
9c67bf2, phases 1–6). One deviation: provider-key reuse in the BYOK sheet
was deferred — endpoints are paste-a-key only (documented in §6.2).

Phases land independently buildable. Gate each phase with `cargo test --locked
-p rag -p store -p protocol -p backend` (add `-p tide` once UI lands) plus a
debug build of the app. The dev watcher builds `target/debug/Tide Debug.app`.
Verify visible changes there against a real workspace with an existing index
(migration path) and a fresh one (creation path).

Crate names for `-p`: `tide` (root app, `src/`), `backend`, `client`, `engine`,
`protocol`, `store`, `tools`, `rag`.

## Phase 1 — Store: embedding plan + dynamic dims (`crates/rag/src/store.rs`)

The vec0 DDL hardcodes 384 (`EMBED_DIM`, store.rs:19). Everything else keys
off making dims per-index data.

1. New type `EmbeddingPlan` (serde camelCase): `{ embedder_id: String, dims:
   usize, chunk_size: Option<u64>, chunk_overlap: Option<u64>, created_at:
   i64 }`. Stored as JSON at meta key `embeddingPlan`. Chunk fields ride the
   plan so chunking changes compute "affected" the same way embedder changes
   do (null = chunker defaults).
2. Constructors: keep `open_at(path)` (delegates with the legacy plan
   `{local-code-512, 384}` — existing tests/call sites unchanged); add
   `open_at_with_plan(path, &EmbeddingPlan)` used by the ingest paths. Same
   for the `open(data_dir, workspace_id)` convenience twin.
3. Restructure `migrate()`:
   - Fresh db (no `schemaVersion`): write the plan meta **first**, then run
     the v1 DDL with `float[{plan.dims}]` in the vec0 statement.
   - Existing db: `SCHEMA_VERSION` → 3. The v3 step backfills
     `embeddingPlan` from existing meta (`embedderId` if present, else
     `local-code-512`; dims 384 — correct for every embedder that exists
     today) and is a no-op for dbs that already carry a plan (crash-safe
     re-entry, mirroring the guarded v2 ALTER).
   - The v1 DDL only ever runs on fresh dbs now, so parameterizing it cannot
     desync an existing table.
4. `plan()` getter (parse meta, `Err` on corrupt JSON rather than defaulting
   — same honesty as the schemaVersion parse above it).
5. Dims become structural: `upsert_vectors` rejects any embedding whose
   length ≠ plan dims; `query_by_vector` rejects a query vector of the wrong
   length. Errors are strings the callers already thread.
6. Tests: fresh 768-dim plan creates `float[768]` vec0 and round-trips
   768-dim vectors + FTS; v2 fixture db migrates to v3 with the backfilled
   plan and its 384-dim vectors stay queryable; wrong-length upsert and
   query both error; plan round-trips through `open_at_with_plan` →
   `open_at`.

## Phase 2 — Catalog + generalized embedders (`crates/rag/src/catalog.rs` new, `embedder.rs`, `resolve.rs`)

1. `LocalModelEntry` static catalog — fields: `id`, `repo` (original HF
   name — the display string), `dims`, `max_tokens`, `languages` (`"en"` /
   `"multilingual"`), `hf_base`, `files: &[&str]`, `download_size`,
   `vendored: bool`, `passage_prefix`/`query_prefix: Option<&'static str>`:

   | id | repo | dims | tokens | languages | vendored |
   |---|---|---|---|---|---|
   | `local-code-512` | `isuruwijesiri/all-MiniLM-L6-v2-code-search-512` | 384 | 512 | en | yes |
   | `local-mle5-small` | `Xenova/multilingual-e5-small` | 384 | 512 | multilingual | no |
   | `local-bge-m3` | `Xenova/bge-m3` | 1024 | 8192 | multilingual | no |

   The e5 entry carries `query_prefix "query: "` / `passage_prefix
   "passage: "` (e5 models are trained with instruction prefixes; skipping
   them quietly degrades recall). bge-m3 and the MiniLM tune take none.
   **Verify each Xenova repo's file list at implementation time** (HEAD the
   `onnx/model_quantized.onnx` + tokenizer files) before freezing the
   catalog — the sizes and file names in the table are best-effort.
2. `LocalEmbedder` becomes entry-parameterized (`new(data_dir, entry)`):
   model resolution per entry (`<models>/<repo>/…`, vendored fallback ONLY
   when `entry.vendored` — the two `include_bytes!` statics stay
   local-code-512-only), truncation from `entry.max_tokens`, prefix applied
   before tokenize (`passage_prefix` — ingest and query both embed
   passages/queries through the same seam, so plumb a `Kind::Query |
   Kind::Passage` flag or a second method; queries use `query_prefix`).
   Keep the pool/normalize numerics untouched. `dim()` returns `entry.dims`;
   keep the runtime shape-read as an assert (catches a wrong repo layout).
3. Local instance memoization: replace `shared_local(data_dir)`'s
   single OnceLock with a process-wide `id → Arc<LocalEmbedder>` map.
   `shared_local` stays as the default-model shorthand for existing tests.
4. `download_model(data_dir, entry, on_progress)` — parameterized over the
   entry; progress callback gains the model id. `local_model_exists` gains
   an entry parameter (default-model variant kept for status compat).
5. `CloudEmbedder` → `RemoteEmbedder { id, base_url, model, api_key, dims,
   max_tokens }` with `Embedder` implemented over the same blocking POST.
   Constructor `RemoteEmbedder::system()` reproduces today's env behavior
   (`TIDE_SYSTEM_API_KEY`, `TIDE_SYSTEM_BASE_URL`, model from
   `cloud_model_id` param falling back to `TIDE_RAG_EMBEDDING_MODEL`, then
   the base default) so `cloud-base` behaves identically until configured
   otherwise.
6. `resolve.rs`: retire the `EmbedderKind` enum. New contract:
   - `RagConfigInput` grows `cloud_model_id: Option<String>` and
     `custom_endpoints: Vec<CustomEndpointSpec>` where the spec carries
     **already-resolved** credentials (`{ id, base_url, model_id, api_key,
     dims, max_tokens }`) — decryption stays in the backend/config layer,
     the rag crate never sees the secrets store.
   - `resolve_for_build(&config, data_dir) -> Result<Arc<dyn Embedder>,
     String>`: catalog id → downloaded-or-vendored check then local
     embedder; `cloud-base` → `RemoteEmbedder::system()`; `custom-<id>` →
     matching spec. Preserved fallback: primary unavailable +
     `cloud_allowed` + cloud configured → cloud, error strings keep the
     current tone.
   - `resolve_for_query(index_embedder_id, &config, data_dir) ->
     Result<Arc<dyn Embedder>, String>` — resolves by the **index's** id,
     not the global config; missing model/key/deleted endpoint → the
     existing "rebuild required" style messages.
   - Update the two re-export wrappers (`resolve_embedder_for_build/query`)
     and delete the old enum.
7. Tests: catalog integrity (unique ids, dims > 0, non-empty files,
   exactly one vendored); resolve build/query per id kind; **same-dims
   different-model blocking** (`local-code-512` index queried under a
   `local-mle5-small` config errors — the id lock, not dims); fallback
   order; e5 query prefix applied (tokenize a probe string, inspect ids).

## Phase 3 — Config: `RagSettings` (`crates/store/src/config.rs`)

1. `RagCustomEndpoint` (persisted): `{ id, name, base_url, model_id, dims,
   max_tokens: Option<u64>, encrypted_key: Option<String> }` — the key
   encrypted with the same `store::secrets` scheme `StoredProvider.
   encrypted_key` uses (see the provider save path in
   `crates/backend/src/tide_providers.rs` for the encrypt call to reuse).
2. `RagSettings` (all-optional fields, camelCase): `embedder_id`,
   `cloud_allowed`, `cloud_model_id`, `custom_endpoints: Vec<
   RagCustomEndpoint>`, `top_k`, `min_similarity`, `chunk_size`,
   `chunk_overlap`. Plus `EffectiveRagSettings` + `effective()` layering
   exactly like `AgentSettings`→`EffectiveAgentSettings` (defaults:
   `local-code-512`, false, None, 5, None, None, None).
3. `Config` gains `rag: Option<RagSettings>` (skip-serializing-if none)
   next to `rag_enabled_workspaces` (config.rs:35). The `extra` flatten
   already covers forward-compat.
4. Helper `Config::rag_effective() -> EffectiveRagSettings` (default when
   absent) — the single hydration point every reader uses.
5. Tests: absent `rag` ≡ current behavior; partial fields layer over
   defaults; full round-trip preserves unknown sibling fields.

## Phase 4 — Service wiring (`crates/backend/src/rag.rs`, `ingest.rs`, `knowledge.rs`)

1. Replace `default_rag_config()` (rag.rs:30) with `effective_rag_config()`
   — reads config fresh, hydrates `RagConfigInput`, decrypts custom
   endpoint keys in-process. Every existing call site switches over.
2. Ingest paths (`rag::ingest_workspace`, `ingest_documents`): resolve for
   build → construct `EmbeddingPlan` from the resolved embedder (id + dims
   + configured chunk values) → `open_at_with_plan`. Existing db: parse its
   plan; resolved embedder id/dims or chunk fields differ → `Err` (ingest
   blocked, index stale — never a mixed write). The belt-and-braces
   vector-length check moves into the store (Phase 1.5).
3. Memory seam fixes (backend/rag.rs):
   - `RagMemoryIndex::embed_query` resolves against the **per-index plan**
     (open the project db, read plan, `resolve_for_query(plan.embedder_id,
     …)`), not the global config. Knowledge half: the first-embedder-wins
     pinning check (meta `embedderId`, rag.rs:~170) reads the plan record
     instead. Resolution failure degrades exactly as today (vector lane
     empty, FTS lane alive).
   - Query vector length is asserted by the store (Phase 1.5) — a
     wrong-space embed can never silently return `[]`.
4. `status()`: `embedder_id` reads the index plan (currently hardcoded
   `"local-code-512"`, rag.rs:~369); add `plan_stale: bool` — plan differs
   from the effective config's embedder/chunking — driving the
   "rebuild required" badge.
5. Model management generalizes: `ensure_model_downloaded` /
   `model_download_state` become keyed by model id (map, not singleton);
   add `delete_model(id)` (refuses while any enabled index's plan names
   it — returns the affected list for the confirm dialog).
6. Prewarm at boot: after `install_memory_index()` (daemon.rs), spawn a
   low-priority thread — if any workspace is RAG-enabled or the knowledge
   db exists, resolve the configured embedder and embed one probe string.
   Failures log-and-drop (first query retries naturally).
7. Tests: backend-level — stale index blocks ingest; switch + affected
   computation (same-dims/different-id counts as affected); prewarm
   idempotent; status reflects plan and staleness.

## Phase 5 — Protocol + daemon arms (`crates/protocol/src/protocol.rs`, `crates/backend/src/daemon.rs`)

1. Wire types (camelCase): `RagConfigWire` (effective settings, no keys),
   `RagEndpointWire { id, name, base_url, model_id, dims, max_tokens,
   has_key }`, `RagModelWire { id, name (original repo), dims, max_tokens,
   languages, vendored, downloaded, download_size, download_state }`,
   `RagAffectedWorkspace { project_id, name, built_with }`.
2. `Command` variants: `RagConfigGet`; `RagConfigUpdate { patch }`;
   `RagModelsList`; `RagModelDownload { id }`; `RagModelDelete { id }`;
   `RagEndpointsList`; `RagEndpointAdd { name, base_url, model_id, api_key,
   max_tokens }`; `RagEndpointSetKey { id, api_key }`;
   `RagEndpointRemove { id }`.
   `ResponsePayload`: `RagConfig { config, endpoints }`, `RagAffected
   { workspaces }` (from update, model delete, endpoint remove), `RagModels
   { models }`, `RagEndpoint { endpoint }`, `RagOpResult`-style acks.
3. Daemon arms (daemon.rs:332 block + the permission list at :1441 — add
   every new variant there too):
   - `RagConfigUpdate`: write under `TIDE_CONFIG_LOCK`; compute affected =
     enabled projects whose index plan ≠ new embedder/chunking (plus the
     knowledge db's plan) → return the list. The UI drives the rebuild.
   - `RagEndpointAdd`: **probe first** — POST one test embedding with the
     supplied key (10 s timeout), measure dims, surface the upstream
     HTTP/auth error; only then persist with `encrypted_key`. Provider-key
     reuse is a UI concern (the sheet can pass an already-decrypted key
     through the same command).
   - `RagEndpointRemove` / `RagModelDelete`: return affected, refuse while
     in-flight downloads reference them.
4. Tests: serde round-trips; `RagConfigGet`/`RagEndpointsList` responses
   contain no key material (serialize and grep); probe failure → error,
   nothing persisted; affected includes the knowledge index when pinned.

## Phase 6 — UI (`src/app/rag_settings.rs`, `src/app/settings.rs`, `runtime.rs`, locales)

1. Panel state grows: `config: Option<RagConfigWire>`, `models`, `endpoints`,
   picker/draft state, rebuild-dialog state (`Vec<RagAffectedWorkspace>` +
   pending flag), per-row pending states. Ops-event enum extends
   (`RagOpsEvent::Config`, `::Models`, `::Endpoints`, `::Affected`).
2. Global card stack at the top of the Knowledge page (existing
   `settings_group_head` / `card_rows` components), above the per-project
   cards:
   - **Embedding model** — picker (popover menu) listing catalog entries by
     original repo name with sub-label `local · 384 dim · 512 tokens ·
     English · downloaded`, then `cloud-base` (system-key status), then
     custom endpoints. Selecting re-dispatches `RagConfigUpdate`; a
     non-empty `RagAffected` reply opens the rebuild dialog.
   - **Local models** — per-entry rows: size, languages badge, download
     progress (poll-fed), delete with affected-confirm.
   - **Retrieval** — top-K stepper, min-similarity field.
   - **Advanced** — cloud fallback toggle, cloud model id, chunk size /
     overlap fields (changes route through the same affected dialog).
   - **Endpoints** — list + add/edit sheet (name, base URL, model id,
     API-key field with "reuse a provider key" popover over configured
     providers, optional max-tokens), inline probe errors, set-key and
     remove actions.
3. Rebuild dialog: affected project list + "Rebuild all now / Later".
   Rebuild-all dispatches `RagInitWorkspace` per project **serially**
   (chain on completion events through the ops channel); progress reuses
   the existing 2 s poll states. "Later" leaves the badge (plan_stale).
4. Dispatch helpers in `runtime.rs` following the git-settings
   spawned-thread pattern; page-switch triggers `RagConfigGet` +
   `RagModelsList` + `RagEndpointsList`.
5. Keyboard/focus per house rules (tab focus + focus_visible on all
   controls, enter/escape in sheets/popovers, arrows in the picker).
   Locales: `rag.*` keys, en first then the existing translated set.

## Phase 7 — Final verification

1. Full gate: `cargo test --locked` (all crates) + debug build + manual pass
   in `Tide Debug.app`.
2. Manual matrix: (a) existing v2 index from current build → migrate →
   still queryable, status shows plan; (b) switch to a 768-dim model →
   affected dialog → rebuild → memory tool returns hits; (c) switch back
   without rebuilding → stale badge, old index still queryable; (d) BYOK
   endpoint add with bad key → inline error, nothing persisted; with
   Ollama base URL → works end-to-end; (e) delete a model that owns an
   index → confirm dialog; (f) config file hand-edit (absent/partial
   `rag`) → defaults, no crash, round-trip preserves the rest.
3. Perf spot-check: memory tool latency on first query after daemon start
   (prewarm) vs cold.

## Risks / open items

- **Xenova repo file lists** (Phase 2.1) must be HEAD-verified before the
  catalog freezes — file naming varies (`model_quantized.onnx` vs
  `onnx/model.onnx`) and bge-m3 is a large download (~1.2 GB quantized).
- **e5 prefixes**: confirm the multilingual-e5 tokenizer tolerates the
  prefix gracefully on code text (it does by training; spot-check
  recall on a fixture before shipping the catalog entry).
- **vec0 dims are fixed at CREATE** — the plan-before-DDL ordering in
  Phase 1.3 is load-bearing; a fresh db created without a plan falls back
  to the legacy 384 shape and must be treated as always-384.
- Git hygiene: this workspace is a fresh repo (everything untracked so
  far). Stage only the files each phase touches, by name.
