import { useState, useMemo, useEffect } from 'react';
import { Search } from 'lucide-react';
import { SettingsHeader } from './shared';
import { ExtensionList, type ExtensionItem } from './ExtensionList';
import { useWorkspaces } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';

export function AgentsSection() {
  const [agents, setAgents] = useState<ExtensionItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const workspacesQuery = useWorkspaces();
  const workspaces = workspacesQuery.data ?? [];
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const workspaceRoot = ws?.path ?? '';

  async function refresh() {
    if (!window.tideIpc || !workspaceRoot) return;
    setLoading(true);
    try {
      const result = await window.tideIpc.listExtensionAgents(workspaceRoot);
      setAgents(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [workspaceRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleToggle(name: string, enabled: boolean) {
    setAgents((prev) => prev.map((a) => (a.name === name ? { ...a, enabled } : a)));
    try {
      await window.tideIpc?.setExtensionEnabled('agents', name, enabled);
    } catch {
      setAgents((prev) => prev.map((a) => (a.name === name ? { ...a, enabled: !enabled } : a)));
    }
  }

  const groups = useMemo(() => {
    const q = query.toLowerCase().trim();
    const filtered = q
      ? agents.filter(
          (a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
        )
      : agents;

    return [
      { label: 'Built-in', items: filtered.filter((a) => a.source === 'builtin') },
      { label: 'Project', items: filtered.filter((a) => a.source === 'project') },
      { label: 'User', items: filtered.filter((a) => a.source === 'user') },
    ];
  }, [agents, query]);

  const activeCount = agents.filter((a) => a.enabled).length;

  return (
    <>
      <SettingsHeader
        title="Extensions → Agents"
        description={`${agents.length} installed · ${activeCount} active`}
      />

      <div className="relative mb-4">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter agents…"
          className="w-full pl-8 pr-3 py-1.5 text-sm bg-muted/50 rounded-lg border border-border/50 focus:border-accent/50 focus:outline-none"
        />
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
      ) : (
        <ExtensionList
          groups={groups}
          onToggle={handleToggle}
          onReveal={(path) => window.tideIpc?.showItemInFolder(path)}
          resetKey={query}
        />
      )}
    </>
  );
}
