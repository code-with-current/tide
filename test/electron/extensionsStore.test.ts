import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createExtensionsStore } from '../../app/core/extensionsStore';

const { getExtensionsMock, setExtensionsMock } = vi.hoisted(() => ({
  getExtensionsMock: vi.fn(),
  setExtensionsMock: vi.fn(),
}));

vi.mock('../../app/core/store.js', () => ({
  getExtensions: getExtensionsMock,
  setExtensions: setExtensionsMock,
}));

function freshConfig() {
  return { disabled: { agents: [], skills: [] } };
}

describe('extensionsStore', () => {
  beforeEach(() => {
    getExtensionsMock.mockReset();
    setExtensionsMock.mockReset();
    getExtensionsMock.mockReturnValue(freshConfig());
    setExtensionsMock.mockImplementation((cfg: ReturnType<typeof freshConfig>) => {
      getExtensionsMock.mockReturnValue(cfg);
    });
  });

  it('returns empty disabled map for a fresh install', () => {
    const store = createExtensionsStore('/tmp');
    expect(store.getDisabled()).toEqual({ agents: [], skills: [], mcp: ['tide-filesystem'] });
  });

  it('toggles a skill off then on', () => {
    const store = createExtensionsStore('/tmp');
    store.setEnabled('skills', 'brainstorming', false);
    expect(store.getDisabled().skills).toContain('brainstorming');
    store.setEnabled('skills', 'brainstorming', true);
    expect(store.getDisabled().skills).not.toContain('brainstorming');
  });

  it('toggles an agent off', () => {
    const store = createExtensionsStore('/tmp');
    store.setEnabled('agents', 'explore', false);
    expect(store.getDisabled().agents).toContain('explore');
  });

  it('persists across store instances (re-read from disk)', () => {
    const s1 = createExtensionsStore('/tmp');
    s1.setEnabled('skills', 'writing-plans', false);
    const s2 = createExtensionsStore('/tmp');
    expect(s2.getDisabled().skills).toContain('writing-plans');
  });

  it('falls back to empty config on corrupt JSON', () => {
    getExtensionsMock.mockReturnValue(freshConfig());
    const store = createExtensionsStore('/tmp');
    expect(store.getDisabled().agents).toEqual([]);
    expect(store.getDisabled().skills).toEqual([]);
  });

  it('does not duplicate entries on repeated disable', () => {
    const store = createExtensionsStore('/tmp');
    store.setEnabled('skills', 'brainstorming', false);
    store.setEnabled('skills', 'brainstorming', false);
    expect(store.getDisabled().skills.filter((s) => s === 'brainstorming')).toHaveLength(1);
  });
});
