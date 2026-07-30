import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createExtensionsStore } from '../extensionsStore';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-ext-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extensionsStore', () => {
  it('returns empty disabled map for a fresh install', () => {
    const store = createExtensionsStore(tmpDir);
    expect(store.getDisabled()).toEqual({ agents: [], skills: [] });
  });

  it('toggles a skill off then on', () => {
    const store = createExtensionsStore(tmpDir);
    store.setEnabled('skills', 'brainstorming', false);
    expect(store.getDisabled().skills).toContain('brainstorming');
    store.setEnabled('skills', 'brainstorming', true);
    expect(store.getDisabled().skills).not.toContain('brainstorming');
  });

  it('toggles an agent off', () => {
    const store = createExtensionsStore(tmpDir);
    store.setEnabled('agents', 'explore', false);
    expect(store.getDisabled().agents).toContain('explore');
  });

  it('persists across store instances (re-read from disk)', () => {
    const s1 = createExtensionsStore(tmpDir);
    s1.setEnabled('skills', 'writing-plans', false);
    const s2 = createExtensionsStore(tmpDir);
    expect(s2.getDisabled().skills).toContain('writing-plans');
  });

  it('falls back to empty config on corrupt JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'extensions.json'), '{not valid json');
    const store = createExtensionsStore(tmpDir);
    expect(store.getDisabled()).toEqual({ agents: [], skills: [] });
  });

  it('does not duplicate entries on repeated disable', () => {
    const store = createExtensionsStore(tmpDir);
    store.setEnabled('skills', 'brainstorming', false);
    store.setEnabled('skills', 'brainstorming', false);
    expect(store.getDisabled().skills.filter((s) => s === 'brainstorming')).toHaveLength(1);
  });
});
