import { useState, useMemo, useEffect } from 'react';
import { Search } from 'lucide-react';
import { toast } from '@/lib/toast';
import { SettingsHeader } from './shared';
import { ReloadButton } from './ReloadButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ExtensionList, type ExtensionItem } from './ExtensionList';
import { useWorkspaces } from '@/lib/queries';
import { useUi } from '@/lib/stores/ui';

type StatusFilter = 'all' | 'active' | 'disabled';

export function SkillsSection() {
  const [skills, setSkills] = useState<ExtensionItem[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
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
    } catch (e) {
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled: !enabled } : s)));
      toast.error("Couldn't update — reverted", { description: e instanceof Error ? e.message : undefined });
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
    const filtered = skills.filter((s) => {
      // status filter
      if (status === 'active' && !s.enabled) return false;
      if (status === 'disabled' && s.enabled) return false;
      // text filter
      if (q && !(s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))) {
        return false;
      }
      return true;
    });

    return [
      { label: 'Project', items: filtered.filter((s) => s.source === 'project') },
      { label: 'User', items: filtered.filter((s) => s.source === 'user') },
    ];
  }, [skills, query, status]);

  const activeCount = skills.filter((s) => s.enabled).length;

  return (
    <>
      <SettingsHeader
        title="Extensions → Skills"
        description={`${skills.length} installed · ${activeCount} active`}
        action={
          <ReloadButton
            loading={loading}
            onClick={refresh}
            title="Reload skills from workspace + user folders"
          />
        }
      />

      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter skills…"
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-muted/50 rounded-lg border border-border/50 focus:border-accent/50 focus:outline-none"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-[8.5rem] h-8 text-[12px] capitalize">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
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
          resetKey={`${query}|${status}`}
        />
      )}
    </>
  );
}
