/** Extensions RPC — port of electron/ipc/extensions.ts (tide:extensions:list /
 * setEnabled / listAgents / listSkills). The disabled-set store lives in
 * appData; list handlers merge it with the built-in agent registry and the
 * workspace scan. Scan failures fall back to builtins (or empty for skills). */

import { scanProjectEntries } from '../core/agent/project-context.js';
import { BUILTIN_AGENTS } from '../core/agent/agents/registry.js';
import type {
  AgentExtensionEntry,
  ExtensionsDisabledSet,
  SkillExtensionEntry,
} from '../../shared/rpc';

/** The extensions-store surface (app/core/extensionsStore satisfies it). */
export interface ExtensionsDomain {
  getDisabled(): ExtensionsDisabledSet;
  setEnabled(domain: 'agents' | 'skills', name: string, enabled: boolean): void;
}

export function registerExtensionsRpc(domain: ExtensionsDomain) {
  return {
    extensionsList: (_: Record<string, never>) => domain.getDisabled(),

    extensionsSetEnabled: ({ domain: extDomain, name, enabled }: { domain: 'agents' | 'skills'; name: string; enabled: boolean }) => {
      domain.setEnabled(extDomain, name, enabled);
      return {};
    },

    extensionsListAgents: ({ workspaceRoot }: { workspaceRoot: string }) => {
      const disabled = domain.getDisabled();
      const entries: AgentExtensionEntry[] = [];
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
    },

    extensionsListSkills: ({ workspaceRoot }: { workspaceRoot: string }) => {
      const disabled = domain.getDisabled();
      const entries: SkillExtensionEntry[] = [];
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
    },
  };
}
