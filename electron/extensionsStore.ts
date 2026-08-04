/**
 * Extensions config store — persistence for the Extensions management UI.
 *
 * Holds a `disabled` allowlist: items NOT in the list are enabled by default.
 * New skills/agents appearing on disk → ON by default. Mirrors the
 * settingsStore pattern (factory, lazy cache, best-effort write).
 *
 * File: `<userData>/extensions.json` (i.e. ~/.tide/extensions.json)
 */
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('extensions');

export type ExtensionDomain = 'agents' | 'skills' | 'mcp';

export interface ExtensionsConfig {
  agents: string[];
  skills: string[];
  mcp: string[];
}

export interface ExtensionsFile {
  disabled?: Partial<Record<ExtensionDomain, string[]>>;
}

const EMPTY: ExtensionsConfig = { agents: [], skills: [], mcp: [] };

/**
 * Built-in MCP servers that are disabled by default. Seeded into the disabled
 * list ONLY on first run (when extensions.json doesn't exist yet). After that,
 * the user's choices are respected — if they toggle a server on (removing it
 * from the disabled list), it stays on across restarts.
 */
const DEFAULT_DISABLED_MCP = ['tide-filesystem'];

/** Build the initial config for first run — seeds default-disabled builtins. */
function firstRunConfig(): ExtensionsConfig {
  return { agents: [], skills: [], mcp: [...DEFAULT_DISABLED_MCP] };
}

export function createExtensionsStore(rootDir: string) {
  const filePath = path.join(rootDir, 'extensions.json');
  let cache: ExtensionsConfig | null = null;

  function read(): ExtensionsConfig {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ExtensionsFile;
      cache = {
        agents: parsed.disabled?.agents ?? [],
        skills: parsed.disabled?.skills ?? [],
        mcp: parsed.disabled?.mcp ?? [],
      };
      return cache;
    } catch {
      // File doesn't exist or is corrupt — first run. Seed defaults.
      cache = firstRunConfig();
      return cache;
    }
  }

  function write(cfg: ExtensionsConfig): void {
    cache = cfg;
    try {
      fs.mkdirSync(rootDir, { recursive: true });
      const fileContent: ExtensionsFile = {
        disabled: { agents: cfg.agents, skills: cfg.skills, mcp: cfg.mcp },
      };
      fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2), 'utf-8');
    } catch (e: any) {
      log.warn('failed to write extensions.json', { err: e });
    }
  }

  function getDisabled(): ExtensionsConfig {
    return { ...read() };
  }

  function setEnabled(domain: ExtensionDomain, name: string, enabled: boolean): ExtensionsConfig {
    const cfg = read();
    const list = cfg[domain];
    if (enabled) {
      cfg[domain] = list.filter((n) => n !== name);
    } else {
      if (!list.includes(name)) list.push(name);
    }
    write(cfg);
    return { ...cfg };
  }

  return { getDisabled, setEnabled, path: filePath };
}

export type ExtensionsStore = ReturnType<typeof createExtensionsStore>;
