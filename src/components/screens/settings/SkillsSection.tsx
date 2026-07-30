import { useState, useMemo, useEffect } from 'react';
import { Search } from 'lucide-react';
import { SettingsHeader } from './shared';
import { ExtensionList, type ExtensionItem } from './ExtensionList';
import { useWorkspaces } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';

export function SkillsSection() {
  const [skills, setSkills] = useState<ExtensionItem[]>([]);
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
      const result = await window.tideIpc.listExtensionSkills(workspaceRoot);
      setSkills(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [workspaceRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleToggle(name: string, enabled: boolean) {
    setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
    try {
      await window.tideIpc?.setExtensionEnabled('skills', name, enabled);
    } catch {
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled: !enabled } : s)));
    }
  }

  // Detect naming collisions: a skill in both project and user dirs.
  const shadowedUserNames = useMemo(() => {
    const projectNames = new Set(skills.filter((s) => s.source === 'project').map((s) => s.name));
    return new Set(
      skills.filter((s) => s.source === 'user' && projectNames.has(s.name)).map((s) => s.name),
    );
  }, [skills]);

  const groups = useMemo(() => {
    const q = query.toLowerCase().trim();
    const filtered = q
      ? skills.filter(
          (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
        )
      : skills;

    return [
      { label: 'Project', items: filtered.filter((s) => s.source === 'project') },
      { label: 'User', items: filtered.filter((s) => s.source === 'user') },
    ];
  }, [skills, query]);

  const activeCount = skills.filter((s) => s.enabled).length;

  return (
    <>
      <SettingsHeader
        title="Extensions → Skills"
        description={`${skills.length} installed · ${activeCount} active`}
      />

      <div className="relative mb-4">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter skills…"
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
          renderBadges={(item) =>
            shadowedUserNames.has(item.name) ? (
              <span
                title="A project-level skill with this name shadows this one."
                className="text-[9px] text-warn uppercase tracking-wide"
              >
                shadowed
              </span>
            ) : undefined
          }
          resetKey={query}
        />
      )}
    </>
  );
}
