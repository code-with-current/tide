/** Extensions config — now stored in config.json (migrated from extensions.json).
 *  Holds a `disabled` allowlist: items NOT listed are enabled by default.
 *  Wraps the store's getExtensions/setExtensions with the same interface
 *  callers expect (getDisabled, setEnabled). */
import * as store from './store.js';
import { createLogger } from './logger.js';

const log = createLogger('extensions');

export type ExtensionDomain = 'agents' | 'skills' | 'mcp';

export interface ExtensionsConfig {
  agents: string[];
  skills: string[];
  mcp: string[];
}

const DEFAULT_DISABLED_MCP = ['tide-filesystem'];

/** Factory returns an object with the same interface as before — getDisabled
 *  and setEnabled — but backed by config.json instead of extensions.json. */
export function createExtensionsStore(_rootDir: string) {
  function getDisabled(): ExtensionsConfig {
    const ext = store.getExtensions();
    return {
      agents: ext.disabled.agents ?? [],
      skills: ext.disabled.skills ?? [],
      mcp: ext.disabled.mcp ?? [...DEFAULT_DISABLED_MCP],
    };
  }

  function setEnabled(domain: ExtensionDomain, name: string, enabled: boolean): ExtensionsConfig {
    const ext = store.getExtensions();
    const list = ext.disabled[domain] ?? [];
    if (enabled) {
      ext.disabled[domain] = list.filter((n) => n !== name);
    } else {
      if (!list.includes(name)) list.push(name);
      ext.disabled[domain] = list;
    }
    store.setExtensions(ext);
    return getDisabled();
  }

  return { getDisabled, setEnabled, path: '(config.json)' };
}

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;
