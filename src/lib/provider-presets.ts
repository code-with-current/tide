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
  },
  {
    id: 'deepseek', name: 'DeepSeek', group: 'aggregator', apiStyle: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', requiresKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys', keyPlaceholder: 'sk-…',
    recommended: ['deepseek-chat', 'deepseek-reasoner'], accent: '#4d6bfe',
  },
  {
    // Zen's per-model API shapes differ: Claude/Qwen on Anthropic /messages
    // (this preset), GLM/Kimi/DeepSeek on OpenAI /chat/completions — flip
    // apiStyle + URL in the wizard's Advanced for those.
    id: 'opencode', name: 'OpenCode Zen', group: 'aggregator', apiStyle: 'anthropic',
    baseUrl: 'https://opencode.ai/zen', requiresKey: true,
    keyUrl: 'https://opencode.ai/auth', keyPlaceholder: '…',
    recommended: ['claude-sonnet', 'claude-opus', 'claude-haiku', 'qwen'], accent: '#ffffff',
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
