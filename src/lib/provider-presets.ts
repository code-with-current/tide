import type { ApiStyle } from '@/types';

export type PresetGroup = 'first-party' | 'aggregator' | 'local';

export interface ProviderPreset {
  id: string;
  name: string;
  group: PresetGroup;
  apiStyle: ApiStyle;
  baseUrl: string;
  requiresKey: boolean;
  keyUrl?: string;
  keyPlaceholder?: string;
  recommended: string[];
  accent: string;
  /** Providers whose models live on DIFFERENT wire endpoints per model
   *  (OpenCode Zen). Matched (substring, lowercase) model ids are servable
   *  on that ApiStyle; everything else is hidden from the model picker.
   *  Absent = every fetched model is offered. */
  modelRouting?: Partial<Record<ApiStyle, string[]>>;
  /** Canonical baseUrl per alternate API style, when the provider serves
   *  both wire formats at DIFFERENT URLs (z.ai). Absent = same URL. */
  altUrls?: Partial<Record<ApiStyle, string>>;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic', name: 'Anthropic', group: 'first-party', apiStyle: 'anthropic',
    baseUrl: 'https://api.anthropic.com', requiresKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: 'sk-ant-…',
    recommended: ['claude-sonnet', 'claude-opus'], accent: '#d97757',
  },
  {
    id: 'openai', name: 'OpenAI', group: 'first-party', apiStyle: 'openai',
    baseUrl: 'https://api.openai.com/v1', requiresKey: true,
    keyUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-…',
    recommended: ['gpt-5', 'gpt-4.1'], accent: '#10a37f',
  },
  {
    id: 'google', name: 'Google Gemini', group: 'first-party', apiStyle: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresKey: true,
    keyUrl: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza…',
    recommended: ['gemini-2.5-pro', 'gemini-2.5-flash'], accent: '#ffffff',
  },
  {
    id: 'xai', name: 'xAI Grok', group: 'first-party', apiStyle: 'openai',
    baseUrl: 'https://api.x.ai/v1', requiresKey: true,
    keyUrl: 'https://console.x.ai', keyPlaceholder: 'xai-…',
    recommended: ['grok-4'], accent: '#111111',
  },
  {
    id: 'openrouter', name: 'OpenRouter', group: 'aggregator', apiStyle: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true,
    keyUrl: 'https://openrouter.ai/keys', keyPlaceholder: 'sk-or-v1-…',
    recommended: ['claude-sonnet', 'gpt-5', 'gemini-2.5-pro'], accent: '#ffffff',
  },
  {
    id: 'zai', name: 'z.ai', group: 'aggregator', apiStyle: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic', requiresKey: true,
    keyUrl: 'https://z.ai/manage-apikey/apikey.html', keyPlaceholder: '…',
    recommended: ['glm-5', 'glm-4.6'], accent: '#ffffff',
    altUrls: { openai: 'https://api.z.ai/api/paas/v4' },
  },
  {
    id: 'deepseek', name: 'DeepSeek', group: 'aggregator', apiStyle: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', requiresKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys', keyPlaceholder: 'sk-…',
    recommended: ['deepseek-chat', 'deepseek-reasoner'], accent: '#4d6bfe',
  },
  {
    // Zen routes models per wire endpoint: Claude + Qwen on Anthropic
    // /messages (this preset's default), GLM/Kimi/DeepSeek/MiniMax + the
    // free tier on OpenAI /chat/completions (flip API style in Advanced).
    // GPT/Grok/Muse/Ox models live ONLY on the OpenAI Responses endpoint —
    // a wire format Tide doesn't speak — so modelRouting hides them.
    id: 'opencode', name: 'OpenCode Zen', group: 'aggregator', apiStyle: 'anthropic',
    baseUrl: 'https://opencode.ai/zen', requiresKey: true,
    keyUrl: 'https://opencode.ai/auth', keyPlaceholder: '…',
    recommended: ['claude-sonnet', 'claude-opus', 'claude-haiku', 'qwen'], accent: '#ffffff',
    altUrls: { openai: 'https://opencode.ai/zen/v1' },
    modelRouting: {
      anthropic: ['claude', 'qwen'],
      // OpenAI-style routing verified live (2026-08-22, full 64-model sweep):
      // x-preview/hy3/nemotron/laguna/muse-spark completed; big-pickle/mimo
      // returned FreeUsageLimitError (= routed, rate-limited); paid models
      // (glm/kimi/deepseek/minimax) hit the billing gate pre-routing — docs
      // based. deepseek-v4-flash-free's upstream is dead on both styles.
      openai: ['glm', 'kimi', 'deepseek', 'minimax', 'big-pickle', 'mimo', 'hy3', 'nemotron', 'laguna', 'x-preview', 'muse-spark'],
    },
  },
  {
    id: 'groq', name: 'Groq', group: 'aggregator', apiStyle: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true,
    keyUrl: 'https://console.groq.com/keys', keyPlaceholder: 'gsk_…',
    recommended: ['llama-3.3-70b', 'qwen3-coder'], accent: '#f55036',
  },
  {
    id: 'mistral', name: 'Mistral', group: 'aggregator', apiStyle: 'openai',
    baseUrl: 'https://api.mistral.ai/v1', requiresKey: true,
    keyUrl: 'https://console.mistral.ai/api-keys', keyPlaceholder: '…',
    recommended: ['devstral', 'mistral-large'], accent: '#fa520f',
  },
  {
    id: 'together', name: 'Together', group: 'aggregator', apiStyle: 'openai',
    baseUrl: 'https://api.together.xyz/v1', requiresKey: true,
    keyUrl: 'https://www.together.ai/settings/api-keys', keyPlaceholder: '…',
    recommended: ['coder'], accent: '#ffffff',
  },
  {
    id: 'fireworks', name: 'Fireworks', group: 'aggregator', apiStyle: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1', requiresKey: true,
    keyUrl: 'https://firework.ai/account/api-keys', keyPlaceholder: 'fw_…',
    recommended: ['deepseek-v3', 'kimi-k2'], accent: '#f3f3f3',
  },
  {
    id: 'ollama', name: 'Ollama', group: 'local', apiStyle: 'openai',
    baseUrl: 'http://localhost:11434/v1', requiresKey: false,
    recommended: ['qwen3-coder', 'devstral'], accent: '#ffffff',
  },
  {
    id: 'lmstudio', name: 'LM Studio', group: 'local', apiStyle: 'openai',
    baseUrl: 'http://localhost:1234/v1', requiresKey: false,
    recommended: [], accent: '#ffffff',
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** Filter fetched models down to what this preset's apiStyle can serve.
 *  No routing table = pass-through. */
export function filterPresetModels<T extends { modelId: string }>(
  models: T[],
  preset: ProviderPreset | undefined,
  apiStyle: ApiStyle,
): T[] {
  const matchers = preset?.modelRouting?.[apiStyle];
  if (!matchers) return models;
  const rs = matchers.map((m) => m.toLowerCase());
  return models.filter((m) => rs.some((r) => m.modelId.toLowerCase().includes(r)));
}

/** Canonical baseUrl a style maps to: the preset's own URL for its default
 *  style, its altUrls entry otherwise; falls back to the protocol default. */
export function canonicalUrlForStyle(
  preset: ProviderPreset | undefined,
  style: ApiStyle,
  protocolDefault: string,
): string {
  if (!preset) return protocolDefault;
  return preset.apiStyle === style ? preset.baseUrl : preset.altUrls?.[style] ?? preset.baseUrl;
}

/** Patch for an API-style flip: follow the URL to the new style's canonical
 *  endpoint — but only when the current URL is still the old style's
 *  canonical one (untouched). A user-customized URL is never clobbered. */
export function styleFlipPatch(
  currentUrl: string,
  fromStyle: ApiStyle,
  toStyle: ApiStyle,
  preset: ProviderPreset | undefined,
  protocolDefaults: Record<ApiStyle, string>,
): { apiStyle: ApiStyle; baseUrl?: string } {
  const patch: { apiStyle: ApiStyle; baseUrl?: string } = { apiStyle: toStyle };
  const cur = currentUrl.trim();
  const fromCanonical = canonicalUrlForStyle(preset, fromStyle, protocolDefaults[fromStyle]);
  if (!cur || cur === fromCanonical) {
    patch.baseUrl = canonicalUrlForStyle(preset, toStyle, protocolDefaults[toStyle]);
  }
  return patch;
}

const hostOf = (url: string) =>
  url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();

export function matchPresetByBaseUrl(baseUrl: string): ProviderPreset | undefined {
  const url = baseUrl.trim().toLowerCase();
  if (!url) return undefined;
  const byExact = PROVIDER_PRESETS.find((p) => p.baseUrl.toLowerCase() === url);
  if (byExact) return byExact;
  return PROVIDER_PRESETS.find(
    (p) => hostOf(p.baseUrl) !== '' && hostOf(p.baseUrl) === hostOf(url),
  );
}
