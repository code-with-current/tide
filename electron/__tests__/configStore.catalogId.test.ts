import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createConfigStore } from '../configStore.js';

const identityCrypto = { encrypt: (s: string) => s, decrypt: (s: string) => s };

describe('configStore catalogId persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-cfg-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips catalogId through add + update + reload', () => {
    // Real factory signature is createConfigStore(rootDir, crypto); the config
    // file lives at path.join(rootDir, 'config.json'). A new store on the same
    // dir re-reads from disk, proving real persistence (not in-memory cache).
    const store = createConfigStore(dir, identityCrypto);
    const p = store.addProvider({
      name: 'Anthropic',
      apiStyle: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'k',
      models: [
        {
          alias: 'Sonnet',
          modelId: 'claude-sonnet-4-5',
          contextWindow: 200000,
          catalogId: 'anthropic/claude-sonnet-4-5',
        },
      ],
    });
    expect(p.models[0].catalogId).toBe('anthropic/claude-sonnet-4-5');

    store.updateProvider(p.id, {
      models: [
        {
          id: p.models[0].id,
          alias: 'Sonnet',
          modelId: 'claude-sonnet-4-5',
          contextWindow: 200000,
          providerId: p.id,
          catalogId: 'anthropic/claude-sonnet-4-5',
        },
      ],
    });

    // Re-read from disk by creating a new store on the same dir.
    const reloaded = createConfigStore(dir, identityCrypto);
    const providers = reloaded.listProviders();
    expect(providers[0].models[0].catalogId).toBe('anthropic/claude-sonnet-4-5');
  });

  it('addProvider works without catalogId (backward compat)', () => {
    const store = createConfigStore(dir, identityCrypto);
    const p = store.addProvider({
      name: 'OpenAI',
      apiStyle: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      models: [{ alias: 'GPT', modelId: 'gpt-5', contextWindow: 200000 }],
    });
    expect(p.models[0].catalogId).toBeUndefined();
  });
});
