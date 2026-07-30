/**
 * Extensions IPC — power the Extensions management UI.
 *
 * Mirrors the settingsStore pattern: a singleton store created at module init
 * from `app.getPath('userData')` (post-relocation: ~/.tide / ~/.tide-dev),
 * plus a single `registerExtensionsHandlers()` registration entry point.
 *
 * Five handlers:
 *   tide:extensions:list        → { agents, skills } disabled-name allowlist
 *   tide:extensions:setEnabled  → flip one item on/off (domain, name, enabled)
 *   tide:extensions:listAgents  → unified catalog (builtins + project + user)
 *   tide:extensions:listSkills  → unified catalog (project + user)
 *   tide:extensions:listMcp     → MCP server list (stub until MCP runtime lands)
 *
 * The list handlers merge the persisted disabled-set into each entry so the
 * renderer gets a single ready-to-render list per domain. Scan failures are
 * swallowed — builtins are always returned for agents, skills return empty.
 */
import { ipcMain, app } from 'electron';
import { createExtensionsStore } from '../extensionsStore.js';
import { scanProjectEntries } from '../agent/project-context.js';
import { BUILTIN_AGENTS } from '../agent/agents/registry.js';
import { createLogger } from '../logger.js';

const log = createLogger('extensions');

// Singleton — created on first import (after app.whenReady, since this module
// is imported lazily from main.ts inside the whenReady callback).
const store = createExtensionsStore(app.getPath('userData'));

export interface AgentEntry {
  name: string;
  description: string;
  whenToUse: string;
  source: 'builtin' | 'project' | 'user';
  path?: string;
  enabled: boolean;
}

export interface SkillEntry {
  name: string;
  description: string;
  source: 'project' | 'user';
  path: string;
  absPath: string;
  enabled: boolean;
}

export function registerExtensionsHandlers(): void {
  ipcMain.handle('tide:extensions:list', () => store.getDisabled());

  ipcMain.handle(
    'tide:extensions:setEnabled',
    (_e: unknown, domain: 'agents' | 'skills', name: string, enabled: boolean) => {
      log.info('extension toggled', { domain, name, enabled });
      return store.setEnabled(domain, name, enabled);
    },
  );

  ipcMain.handle('tide:extensions:listAgents', (_e: unknown, workspaceRoot: string) => {
    const disabled = store.getDisabled();
    const entries: AgentEntry[] = [];
    for (const a of BUILTIN_AGENTS) {
      entries.push({
        name: a.name,
        description: a.description,
        whenToUse: a.whenToUse,
        source: 'builtin',
        enabled: !disabled.agents.includes(a.name),
      });
    }
    try {
      const scanned = scanProjectEntries(workspaceRoot);
      for (const a of scanned.agents) {
        entries.push({
          name: a.name,
          description: a.description,
          whenToUse: '',
          source: a.source,
          path: a.absPath,
          enabled: !disabled.agents.includes(a.name),
        });
      }
    } catch {
      /* scan failure — return builtins only */
    }
    return entries;
  });

  ipcMain.handle('tide:extensions:listSkills', (_e: unknown, workspaceRoot: string) => {
    const disabled = store.getDisabled();
    const entries: SkillEntry[] = [];
    try {
      const scanned = scanProjectEntries(workspaceRoot);
      for (const s of scanned.skills) {
        entries.push({
          name: s.name,
          description: s.description,
          source: s.source,
          path: s.path,
          absPath: s.absPath,
          enabled: !disabled.skills.includes(s.name),
        });
      }
    } catch {
      /* scan failure — return empty */
    }
    return entries;
  });

  // MCP runtime isn't wired yet — return a stable stub shape so the renderer
  // can render an "MCP not configured" empty state without a separate probe.
  ipcMain.handle('tide:extensions:listMcp', () => ({
    runtimeReady: false,
    servers: [] as Array<{ name: string; command: string }>,
  }));
}
