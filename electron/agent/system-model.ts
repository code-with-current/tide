/**
 * System app model — a single lightweight model the app uses for internal,
 * non-user-facing tasks (session-title generation today; future: summaries,
 * classifications, etc.).
 *
 * Distinct from the user-configured chat providers in three ways:
 *   1. Credentials live in the app's `.env` (app infrastructure), not in the
 *      encrypted per-user provider store. Loaded once at process start by
 *      `process.loadEnvFile()` in electron/main.ts.
 *   2. The endpoint/model are fixed app defaults — title generation is never
 *      billed against the user's chat quota and never depends on which
 *      provider a session happens to use.
 *   3. It has no tools, no thinking, no per-call provider options — it's the
 *      narrow "transform this text" path.
 *
 * `runSystemTask` is the general-purpose entry point: a one-shot `generateText`
 * with caller-supplied system prompt + token cap. Callers wrap their own
 * try/catch to map failure to their UX (title gen → null → keep placeholder);
 * this module throws rather than swallowing, so a genuinely broken config is
 * diagnosable at the call site instead of silently degrading.
 *
 * The endpoint is OpenAI-compatible (OpenRouter by default). The base URL is
 * normalized: a trailing `/chat/completions` is stripped so both the full
 * endpoint and the bare base (`.../v1`) work as TIDE_SYSTEM_BASE_URL — pasting
 * either form from an OpenRouter dashboard "chat completions" URL just works.
 */
import { generateText, embedMany, type LanguageModel, type EmbeddingModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// Env var names are namespaced so they don't collide with user-set vars.
const ENV = {
  baseUrl: 'TIDE_SYSTEM_BASE_URL',
  apiKey: 'TIDE_SYSTEM_API_KEY',
  model: 'TIDE_SYSTEM_MODEL',
  embeddingModel: 'TIDE_RAG_EMBEDDING_MODEL',
} as const;

// Defaults ship with the app's chosen lightweight model so a minimal `.env`
// (key only) is enough. Override via env if a different OpenAI-compatible
// endpoint or model is wanted.
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it:free';
// Cloud fallback embedder: the base all-MiniLM-L6-v2 (NOT the code-tuned
// fine-tune the local path uses). Same 384-dim, but a different embedding
// space — see src/types RagConfig/EmbedderId for why the two are bound
// per-index and never mixed.
const DEFAULT_EMBEDDING_MODEL = 'sentence-transformers/all-minilm-l6-v2';

let cached: LanguageModel | null = null;

interface ResolvedConfig {
  baseUrl: string;
  apiKey: string | undefined;
  modelId: string;
}

function readConfig(): ResolvedConfig {
  const baseUrl = (process.env[ENV.baseUrl] || DEFAULT_BASE_URL).replace(
    /\/chat\/completions\/?$/,
    '',
  );
  const apiKey = process.env[ENV.apiKey];
  const modelId = process.env[ENV.model] || DEFAULT_MODEL;
  return { baseUrl, apiKey, modelId };
}

/**
 * True iff an API key is configured. Cheap check for callers that want to skip
 * the task entirely (and avoid constructing a model) when the system model
 * isn't set up — e.g. a dev machine without a key shouldn't spam the console.
 */
export function isSystemModelConfigured(): boolean {
  return !!process.env[ENV.apiKey];
}

/**
 * Resolve (and memoize) the LanguageModel for the system app model.
 * @throws if TIDE_SYSTEM_API_KEY is unset — callers who prefer a soft skip
 *         should gate on `isSystemModelConfigured()` first.
 */
export function getSystemModel(): LanguageModel {
  if (cached) return cached;
  const { baseUrl, apiKey, modelId } = readConfig();
  if (!apiKey) {
    throw new Error(
      'System model not configured: set TIDE_SYSTEM_API_KEY in .env. ' +
        'Lightweight tasks (title generation, etc.) will be skipped.',
    );
  }
  cached = createOpenAICompatible({
    apiKey,
    baseURL: baseUrl,
    name: 'tide-system',
  }).languageModel(modelId);
  return cached;
}

export interface SystemTaskInput {
  system: string;
  prompt: string;
  /** Default 512. Title gen passes ~80 to keep responses tight. */
  maxOutputTokens?: number;
  /** Caller-supplied; typically AbortSignal.timeout(ms). */
  abortSignal?: AbortSignal;
}

/**
 * General-purpose one-shot text generation on the system model. No tools, no
 * thinking — for lightweight transformation tasks (summarize, classify,
 * title-ify). Returns the raw model text; the caller is responsible for any
 * cleaning/trimming specific to its use case.
 *
 * @throws on provider error, timeout, abort, or missing configuration. The
 *         contract is: failures surface here, not silently absorbed. Most
 *         callers should catch and degrade gracefully.
 */
export async function runSystemTask(input: SystemTaskInput): Promise<string> {
  const result = await generateText({
    model: getSystemModel(),
    system: input.system,
    prompt: input.prompt,
    maxOutputTokens: input.maxOutputTokens ?? 512,
    abortSignal: input.abortSignal,
  });
  return result.text;
}

// ─── Embedding path ────────────────────────────────────────────────────
// Parallels the chat path above: same OpenRouter creds + base URL, but
// hits the /embeddings route via .embeddingModel() instead of the chat
// route. One new env var (TIDE_RAG_EMBEDDING_MODEL); auth is shared with
// title generation so RAG introduces no new credential surface.

let cachedEmbedder: EmbeddingModel | null = null;

/**
 * True iff an API key is configured — gates the cloud embedder. Same gate
 * as isSystemModelConfigured; exported separately so RAG code reads intent
 * ("can I embed?") rather than mechanism ("is the key set?").
 */
export function isRagCloudConfigured(): boolean {
  return !!process.env[ENV.apiKey];
}

/**
 * Resolve (and memoize) the EmbeddingModel for the cloud embedder. Same
 * construction as getSystemModel — createOpenAICompatible with the shared
 * base URL + key — but via .embeddingModel() against the /embeddings
 * route with TIDE_RAG_EMBEDDING_MODEL (default base MiniLM).
 *
 * @throws if TIDE_SYSTEM_API_KEY is unset — callers should gate on
 *         isRagCloudConfigured() first if they prefer a soft skip.
 */
export function getSystemEmbedder(): EmbeddingModel {
  if (cachedEmbedder) return cachedEmbedder;
  const { baseUrl, apiKey } = readConfig();
  if (!apiKey) {
    throw new Error(
      'RAG cloud embedder not configured: set TIDE_SYSTEM_API_KEY in .env.',
    );
  }
  const modelId = process.env[ENV.embeddingModel] || DEFAULT_EMBEDDING_MODEL;
  cachedEmbedder = createOpenAICompatible({
    apiKey,
    baseURL: baseUrl,
    name: 'tide-system',
  }).embeddingModel(modelId);
  return cachedEmbedder;
}

/**
 * Embed a batch via the cloud path. 30s abort — generous for OpenRouter
 * free-route queueing (observed in title-gen). Ingestion calls batch for
 * throughput; per-query calls embed a single-element array.
 */
export async function runSystemEmbedding(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: getSystemEmbedder(),
    values: texts,
    abortSignal: AbortSignal.timeout(30_000),
  });
  return embeddings;
}

/** Test-only: bust the embedder memo so env-override tests can observe a
 *  fresh construction. No-op in production. */
export function _resetSystemEmbedderForTests(): void {
  cachedEmbedder = null;
}
