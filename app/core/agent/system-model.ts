/** System app model: a lightweight OpenAI-compatible model for internal non-user tasks (title gen, etc.), distinct from user chat providers — creds in .env, fixed defaults, throws on misconfiguration so callers catch and degrade. */
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

/** True iff an API key is configured, so callers can cheaply skip tasks when the system model isn't set up. */
export function isSystemModelConfigured(): boolean {
  return !!process.env[ENV.apiKey];
}

/** Resolve (and memoize) the system LanguageModel; @throws if TIDE_SYSTEM_API_KEY is unset (gate on isSystemModelConfigured for a soft skip). */
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

/** One-shot text generation on the system model for lightweight transforms (no tools/thinking); @throws on provider/timeout/abort/config errors so callers catch and degrade. */
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
// Parallels the chat path above: same OpenRouter creds + base URL, but hits /embeddings via .embeddingModel(). One new env var (TIDE_RAG_EMBEDDING_MODEL); auth is shared with title generation so RAG introduces no new credential surface.

let cachedEmbedder: EmbeddingModel | null = null;

/** True iff an API key is configured; gates the cloud embedder (separate from isSystemModelConfigured so RAG code reads intent). */
export function isRagCloudConfigured(): boolean {
  return !!process.env[ENV.apiKey];
}

/** Resolve (and memoize) the cloud EmbeddingModel via .embeddingModel() with shared creds; @throws if TIDE_SYSTEM_API_KEY is unset. */
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

/** Embed a batch via the cloud path with a 30s abort (generous for OpenRouter free-route queueing). */
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
