import { describe, expect, it, vi } from 'vitest';
import { registerExtensionsRpc, type ExtensionsDomain } from '../../../app/rpc/extensions';
import { BUILTIN_AGENTS } from '../../../app/core/agent/agents/registry';

function fakeStore(): ExtensionsDomain & { state: { disabled: { agents: string[]; skills: string[] } } } {
  const state = {
    disabled: { agents: ['explore'], skills: [] } as { agents: string[]; skills: string[] },
  };
  return {
    state,
    getDisabled: () => state.disabled,
    setEnabled: (domain, name, enabled) => {
      const list = state.disabled[domain];
      const idx = list.indexOf(name);
      if (enabled && idx >= 0) list.splice(idx, 1);
      if (!enabled && idx < 0) list.push(name);
    },
  };
}

describe('extensions rpc', () => {
  it('extensionsList returns the disabled set verbatim', () => {
    const store = fakeStore();
    const h = registerExtensionsRpc(store);
    expect(h.extensionsList({})).toEqual({ agents: ['explore'], skills: [] });
  });

  it('extensionsSetEnabled toggles through the store', () => {
    const store = fakeStore();
    const h = registerExtensionsRpc(store);
    h.extensionsSetEnabled({ domain: 'agents', name: 'explore', enabled: true });
    expect(store.state.disabled.agents).toEqual([]);
    h.extensionsSetEnabled({ domain: 'skills', name: 'my-skill', enabled: false });
    expect(store.state.disabled.skills).toEqual(['my-skill']);
  });

  it('extensionsListAgents merges builtins with the disabled flags', () => {
    const h = registerExtensionsRpc(fakeStore());
    const entries = h.extensionsListAgents({ workspaceRoot: '/definitely/not/real' });
    expect(entries.length).toBeGreaterThanOrEqual(BUILTIN_AGENTS.filter((a) => !a.hidden).length);
    const explore = entries.find((e) => e.name === 'explore');
    expect(explore?.enabled).toBe(false);
    const others = entries.filter((e) => e.name !== 'explore');
    expect(others.every((e) => e.enabled)).toBe(true);
    expect(others.every((e) => e.source === 'builtin')).toBe(true);
  });

  it('extensionsListSkills returns empty for an unscannable root', () => {
    const h = registerExtensionsRpc(fakeStore());
    expect(h.extensionsListSkills({ workspaceRoot: '/definitely/not/real' })).toEqual([]);
  });
});
