import { useState, useEffect, useMemo } from 'react';
import { Bot, Wrench, Search, Check, FileText } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/quick-tooltip';
import { cn } from '@/lib/utils';
import * as api from '@/lib/api/client';
import { useUi } from '@/lib/stores/ui';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/lib/logger';

const log = createLogger('useMentionCatalog');

type MentionKind = 'agent' | 'skill' | 'mcp' | 'context';

interface Mention {
  id: string;
  kind: MentionKind;
  name: string;
  description: string;
  /** Full file content for project-level entries (skills/agents/context).
   *  When present, the composer prepends it as guidance to the user's
   *  message on pick. Undefined for built-in agents and mocked entries. */
  content?: string;
  /** Source — distinguishes project-defined from built-in or user-installed.
   *  Drives a small badge in the picker so the user knows where it came from. */
  source?: 'builtin' | 'project' | 'user';
  /** Relative path for project entries (for display in a tooltip). */
  filePath?: string;
  /** Absolute path to the entry's file. Handed to the model so it can
   *  `read_file` the skill/agent on demand (progressive disclosure),
   *  including user-level entries that live outside the workspace. */
  absPath?: string;
}

const TABS: { kind: MentionKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'agent',   label: 'Agents',   icon: <Bot className="size-3.5" /> },
  { kind: 'skill',   label: 'Skills',   icon: <Wrench className="size-3.5" /> },
  { kind: 'context', label: 'Context',  icon: <FileText className="size-3.5" /> },
  // MCP tab removed — managed in Settings → Extensions → MCP until runtime ships.
];

const kindColor: Record<MentionKind, string> = {
  agent: 'text-primary bg-primary/10 p-2 rounded-md',
  skill: 'text-info bg-info/10 p-2 rounded-md',
  context: 'text-muted-foreground bg-muted-foreground/10 p-2 rounded-md',
  mcp: 'text-reasoning bg-reasoning/10 p-2 rounded-md',
};

/** Build the mention catalog (built-in agents + project + user entries) for the active workspace; shared between the `/` toolbar picker and the inline slash picker. Fetches lazily; returns a flat Mention[]. */
export function useMentionCatalog(activeWorkspaceId: string | null): Mention[] {
  const [agents, setAgents] = useState<Mention[]>([]);
  const [projectEntries, setProjectEntries] = useState<{
    contextFiles: api.ProjectEntry[];
    skills: api.ProjectEntry[];
    agents: api.ProjectEntry[];
  }>({ contextFiles: [], skills: [], agents: [] });
  // Disabled extensions config — fetched once so disabled items are filtered
  // from the picker. Refreshed when the window regains focus so toggles made
  // in Settings are picked up without a full re-mount.
  const [disabledConfig, setDisabledConfig] = useState<{ agents: string[]; skills: string[] } | null>(null);
  useEffect(() => {
    const fetchDisabled = () => window.tideIpc?.listExtensions().then(setDisabledConfig).catch(() => {});
    fetchDisabled();
    const onFocus = () => fetchDisabled();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  // Built-in agents: fetch once on mount (don't gate on workspaceId — they're global).
  useEffect(() => {
    let cancelled = false;
    api.listAgents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list.map((a) => ({
          id: `agent_${a.name}`,
          kind: 'agent' as const,
          name: a.name,
          description: a.whenToUse,
          source: 'builtin',
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Project + user entries: re-fetch whenever the workspace changes.
  // No ref-based cache — always fetches fresh so newly-added skills
  // appear without an app reload.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    api.listProjectEntries(activeWorkspaceId)
      .then((entries) => {
        if (cancelled) return;
        // DIAGNOSTIC: log source breakdown so we can verify project
        // skills are reaching the renderer. Remove once verified.
        const projectSkills = entries.skills.filter(s => s.source === 'project');
        const userSkills = entries.skills.filter(s => s.source === 'user');
        log.debug('catalog', {
          workspace: activeWorkspaceId,
          contextFiles: entries.contextFiles.length,
          projectSkills: projectSkills.length,
          userSkills: userSkills.length,
          projectSkillNames: projectSkills.map(s => s.name),
          agents: entries.agents.length,
        });
        setProjectEntries(entries);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);

  return useMemo(() => {
    const projectAgentMentions: Mention[] = projectEntries.agents.map((e) => ({
      id: `proj_agent_${e.name}`,
      kind: 'agent' as const,
      name: e.name,
      description: e.description,
      content: e.content,
      source: e.source ?? 'project',
      filePath: e.path,
      absPath: e.absPath,
    }));
    const projectSkillMentions: Mention[] = projectEntries.skills.map((e) => ({
      id: `proj_skill_${e.name}`,
      kind: 'skill' as const,
      name: e.name,
      description: e.description,
      content: e.content,
      source: e.source ?? 'project',
      filePath: e.path,
      absPath: e.absPath,
    }));
    const contextMentions: Mention[] = projectEntries.contextFiles.map((e) => ({
      id: `proj_ctx_${e.name}`,
      kind: 'context' as const,
      name: e.name,
      description: e.description,
      content: e.content,
      source: e.source ?? 'project',
      filePath: e.path,
      absPath: e.absPath,
    }));
    // Built-in slash commands — appear in the / picker but have no file path.
    // They're intercepted by MainScreen.handleSend before reaching the model.
    const builtinCommands: Mention[] = [
      {
        id: 'cmd_compact',
        kind: 'skill' as const,
        name: 'compact',
        description: 'Summarize earlier conversation to free context space',
        source: 'builtin',
      },
    ];

    // Filter out disabled extensions (Settings → Extensions toggles).
    const all = [...builtinCommands, ...agents, ...projectAgentMentions, ...projectSkillMentions, ...contextMentions];
    if (!disabledConfig) return all;
    return all.filter((m) => {
      if (m.kind === 'agent') return !disabledConfig.agents.includes(m.name);
      if (m.kind === 'skill') return !disabledConfig.skills.includes(m.name);
      return true;
    });
  }, [agents, projectEntries, disabledConfig]);
}

export function MentionButton({
  onPick,
  onClickTrigger,
}: {
  onPick: (mention: Mention) => void;
  /** When set, clicking the button calls this handler instead of opening the
   *  built-in popover. Used to unify with the inline SlashPicker — the
   *  button inserts `/` into the editor and the same inline picker opens. */
  onClickTrigger?: () => void;
}) {
  // ── Trigger-only mode: delegate to the parent's handler ──
  if (onClickTrigger) {
    return (
      <Tip label="Insert skill / agent / context" side="right">
        <Button
          variant="ghost"
          size={'icon-sm'}
          onClick={onClickTrigger}
          className="size-8 rounded-md flex items-center justify-center text-input-foreground hover:text-foreground hover:bg-secondary transition-colors"
          aria-label="Insert skill / agent / context"
        >
          /
        </Button>
      </Tip>
    );
  }

  // ── Legacy mode: full Popover picker (tabbed) ──
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<MentionKind>('agent');
  const [query, setQuery] = useState('');
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const catalog = useMentionCatalog(activeWorkspaceId);

  const filtered = catalog.filter(
    (m) => m.kind === tab && (m.name.includes(query.toLowerCase()) || m.description.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Tip label="Insert skill / agent / context" side="right">
          <Button
            variant="ghost"
            size={'icon-sm'}
            className="size-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            aria-label="Insert skill / agent / context"
          >
            {/*<Slash className="size-3.5" />*/}
            /
          </Button>
        </Tip>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-[320px] p-0"
      >
        {/* Tabs */}
        <div className="flex items-center justify-around border-b border-border px-1.5">
          {TABS.map((t) => (
            <Button
              variant="ghost"
              size="sm"
              key={t.kind}
              onClick={() => setTab(t.kind)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-2 text-[12px] font-medium -mb-px transition-colors rounded-none',
                tab === t.kind
                  ? ''
                  : 'text-muted-foreground/60 border-transparent hover:text-primary',
              )}
            >
              {t.icon}
              {t.label}
            </Button>
          ))}
        </div>

        {/* Search */}
        <div className="p-2 border-b border-input">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary border border-border">
            <Search className="size-3 text-muted-foreground/60" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${tab}s…`}
              className="bg-transparent border-0 outline-none text-xs flex-1 placeholder:text-muted-foreground/60"
            />
          </div>
        </div>

        {/* List */}
        <div className="max-h-[260px] overflow-y-auto overflow-x-hidden scroll py-1">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground/60">No matches.</div>
          )}
          {filtered.map((m) => (
            <Button
              variant="ghost"
              size="lg"
              key={m.id}
              onClick={() => {
                onPick(m);
                setOpen(false);
              }}
              title={m.filePath ? `Project file: ${m.filePath}` : undefined}
              className="w-full text-left transition-colors flex items-center gap-2 rounded-none overflow-hidden"
            >
              <span className={cn('mr-1 ', kindColor[m.kind])}>
                {TABS.find((t) => t.kind === m.kind)?.icon}
              </span>
              <div className="flex-1 min-w-0 ml-auto">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium font-mono truncate">/{m.name}</span>
                  {(m.source === 'project' || m.source === 'user') && (
                    <span
                      className={cn(
                        'text-[9px] uppercase tracking-wider bg-secondary border border-input px-1 py-px rounded',
                        m.source === 'project' ? 'text-secondary-foreground/60/70' : 'text-primary/70',
                      )}
                    >
                      {m.source}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground/60 truncate">{m.description}</div>
              </div>
              <Check className="size-3 text-muted-foreground/60 opacity-0 group-hover:opacity-100 shrink-0" />
            </Button>
          ))}
        </div>

        <div className="px-3 py-1.5 border-t border-input text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
          <kbd className="font-mono text-[10px] px-1 py-0 bg-muted-foreground/50 text-muted border border-border rounded">/</kbd>
          to insert · adds to your prompt
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type { Mention, MentionKind };
