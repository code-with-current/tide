import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, GitFork, FolderGit2, ChevronDown, ChevronRight, Settings2, X } from 'lucide-react';
import { ChatComposer } from './chat-composer';
import { useModelOption, useWorkspaces, supportsThinking } from '@/lib/queries';
import { highestThinkingLevelForModel } from './composer/thinking-level-selector';
import * as api from '@/lib/api/client';
import { useUi } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';
import { Kbd } from '../ui/kbd';

/** New-session screen: composer + worktree panel that auto-suggests a branch name, picks a base branch, and toggles per-session isolation. */
export function EmptyChatState({
  onSend,
  isStreaming = false,
}: {
  onSend?: (payload: {
    text: string;
    /** Enriched text — display text + full skill/agent content blocks injected inline. Shipped to the orchestrator as the user message; dropping it (prior bug) left the model seeing a bare `/name` token and misinvoking slash_command. */
    promptText?: string;
    mentions?: Array<{ name: string; kind: 'skill' | 'agent' | 'context' | 'mcp'; source?: 'project' | 'user' | 'builtin' }>;
    attachments: import('@/types').MessageAttachment[];
    worktree?: { enabled: boolean; branchName: string; baseBranch: string; configFiles?: string[] };
  }) => void;
  isStreaming?: boolean;
}) {
  const activeWorkspaceId = useUi((s) => s.activeWorkspaceId);
  const activeDraftId = useUi((s) => s.activeDraftId);
  const pendingFork = useUi((s) => s.pendingFork);
  const startNewDraft = useUi((s) => s.startNewDraft);
  const touchDraft = useUi((s) => s.touchDraft);
  const { data: workspaces } = useWorkspaces();
  const workspace = workspaces?.find((w) => w.id === activeWorkspaceId);

  // Every new session pre-selects the highest thinking level the selected
  // model supports. Keyed on model + published efforts so a late effort load
  // re-applies, while a manual level change (which doesn't touch the key)
  // sticks. The ref resets on remount — leaving and re-entering the new-session
  // screen counts as a new session and pre-selects again.
  const selectedModelId = useUi((s) => s.selectedModelId);
  const selectedProviderId = useUi((s) => s.selectedProviderId);
  const modelOption = useModelOption(selectedProviderId, selectedModelId);
  const appliedModelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!modelOption) return;
    if (!(modelOption.reasoning ?? supportsThinking(modelOption.modelId, modelOption)) && !modelOption.reasoningMandatory) return;
    const efforts = modelOption.supportedEfforts?.join(',') ?? '';
    const key = `${selectedProviderId}:${modelOption.modelId}:${efforts}`;
    if (appliedModelKeyRef.current === key) return;
    appliedModelKeyRef.current = key;
    const top = highestThinkingLevelForModel(modelOption);
    if (top) useUi.getState().setThinkingLevel(top);
  }, [modelOption, selectedProviderId]);

  // Ensure the new-session composer always has a draft slot bound to the
  // active workspace (so typed text shows as a draft in the session list).
  // Re-runs when the workspace changes — startNewDraft needs activeWorkspaceId
  // to assign a slot, and on startup the workspace may not be set yet when
  // this component first mounts (splash-screen IPC restore is async).
  useEffect(() => {
    if (!activeDraftId) startNewDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId]);

  // ── Worktree config state ──
  // Disabled by default — worktree isolation is opt-in per session. The user
  // toggles it on when they want branch-scoped edits; most quick chats don't.
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branchTouched, setBranchTouched] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [composerText, setComposerText] = useState('');
  // Config files to copy into the worktree (e.g., .env, .env.local).
  // Auto-populated from listConfigFiles when settings expand; user can
  // add custom paths too. Without these, dev servers in the worktree
  // can't read API keys / DB URLs.
  const [configFiles, setConfigFiles] = useState<string[]>([]);

  // Default base branch = workspace's current branch.
  useEffect(() => {
    if (workspace?.branch) setBaseBranch(workspace.branch);
  }, [workspace?.branch]);

  // Auto-suggest branch name from composer text until the user manually
  // edits the field. macOS-Save-As-style behavior: typing in the composer
  // updates the suggestion; focusing + editing the branch field sticks.
  useEffect(() => {
    if (branchTouched) return;
    setBranchName(slugify(composerText) || 'session');
  }, [composerText, branchTouched]);

  // When settings expand, fire a one-shot auto-detection of likely
  // config files (.env etc.) and pre-select them. Doesn't re-run on
  // every render — only when showSettings flips true.
  const detectedRef = useRef(false);
  useEffect(() => {
    if (!showSettings || detectedRef.current) return;
    if (!activeWorkspaceId) return;
    detectedRef.current = true;
    api.listConfigFiles(activeWorkspaceId).then((found) => {
      // Seed the selection with detected files. User can untick them
      // individually or add custom paths.
      setConfigFiles((cur) => {
        const set = new Set(cur);
        for (const f of found) set.add(f);
        return [...set];
      });
    }).catch(() => { /* IPC failure — leave selection empty */ });
  }, [showSettings, activeWorkspaceId]);

  return (
    <div className="flex-1 overflow-y-auto scroll relative">
      {/* Invisible drag region — keeps the window movable on macOS
          now that the top bar is hidden on this screen. */}
      <div className="drag-region absolute inset-x-0 top-0 h-10 z-10" />
      <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 gap-6 min-h-full">
        {/* Workspace context strip */}
        {workspace && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
            <FolderGit2 className="size-3" />
            <span className="text-muted-foreground">{workspace.name}</span>
            {workspace.branch && (
              <>
                <span>·</span>
                <span className="font-mono inline-flex items-center gap-1">
                  <GitBranch className="size-2.5" />
                  {workspace.branch}
                </span>
              </>
            )}
          </div>
        )}

        {/* Hero — fork variant when landing here via initiateFork, so a
            fork never looks identical to a plain new session. */}
        {pendingFork ? (
          <div className="flex flex-col items-center gap-1.5 max-w-[40rem]">
            <div className="flex items-center gap-2 min-w-0">
              <GitFork className="size-4 shrink-0 text-primary" />
              <h2 className="text-2xl font-semibold tracking-tight text-center truncate max-w-[34rem]">
                Forked from “{pendingFork.sourceTitle}”
              </h2>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {pendingFork.origin === 'model'
                ? 'The model is locked once a session has messages — pick a new model below, then send.'
                : 'The last answer is attached as context — take the thread in a new direction.'}
            </p>
            <button
              type="button"
              onClick={() => useUi.getState().setPendingFork(null)}
              className="text-[11px] text-muted-foreground/60 hover:text-foreground underline underline-offset-2 transition-colors"
            >
              Start a blank session Instead
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight text-center">
              Let's build something great{workspace ? <> on <span className="pl-2 text-primary italic">"{workspace.name}"</span></> : ' — what are we working on?'}
            </h2>
          </div>
        )}

        {/* Fork source strip — mirrors the workspace strip above, but names
            the session this fork continues from. */}
        {/*{pendingFork && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60 -mt-3">
            <GitFork className="size-3" />
            <span className="truncate max-w-[24rem]">forked from “{pendingFork.sourceTitle}”</span>
            <span>·</span>
            <span className="font-mono truncate max-w-[14rem]">{pendingFork.sourceModelId}</span>
          </div>
        )}*/}

        {/* Composer */}
        <div className="w-full max-w-[40rem]">
          <ChatComposer
            key={activeDraftId ?? '__new__'}
            compact={false}
            placeholder="Describe what you want to build, fix, or explain…"
            inProgress={isStreaming}
            onChange={(text) => {
              setComposerText(text);
              touchDraft(activeWorkspaceId ?? '', text);
            }}
            onSubmit={(payload) => {
              if (!payload.text.trim()) return;
              onSend?.({
                text: payload.text,
                promptText: payload.promptText,
                mentions: payload.mentions,
                attachments: payload.attachments,
                worktree: worktreeEnabled
                  ? { enabled: true, branchName, baseBranch, configFiles }
                  : { enabled: false, branchName, baseBranch },
              });
              setComposerText('');
            }}
          />
        </div>

        {/* Worktree panel */}
        <WorktreePanel
          enabled={worktreeEnabled}
          onToggle={setWorktreeEnabled}
          branchName={branchName}
          onBranchName={(v) => {
            setBranchTouched(true);
            setBranchName(v);
          }}
          baseBranch={baseBranch}
          onBaseBranch={setBaseBranch}
          configFiles={configFiles}
          onConfigFiles={setConfigFiles}
          workspaceId={activeWorkspaceId}
          defaultBranch={workspace?.branch}
          worktreeLocation={workspace?.worktreeLocation}
          showSettings={showSettings}
          onToggleSettings={() => setShowSettings((s) => !s)}
        />

        {/* Keyboard hint */}
        <div className="text-[0.80rem] text-muted-foreground/60 flex items-center gap-3">
          <span className='border border-foreground pr-1 rounded-lg'><Kbd className="font-mono">/</Kbd> Skills</span>
          <span className='border border-foreground pr-1 rounded-lg'><Kbd className="font-mono">@</Kbd> Context</span>
          <span className='border border-foreground pr-1 rounded-lg'><Kbd className="font-mono">↵</Kbd> Send</span>
        </div>
      </div>
    </div>
  );
}

/** Worktree panel: collapsed by default; expand to show branch/base/location and toggle isolation for the upcoming session. */
function WorktreePanel({
  enabled,
  onToggle,
  branchName,
  onBranchName,
  baseBranch,
  onBaseBranch,
  configFiles,
  onConfigFiles,
  workspaceId,
  defaultBranch,
  worktreeLocation,
  showSettings,
  onToggleSettings,
}: {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  branchName: string;
  onBranchName: (v: string) => void;
  baseBranch: string;
  onBaseBranch: (v: string) => void;
  configFiles: string[];
  onConfigFiles: (v: string[]) => void;
  workspaceId: string | null;
  defaultBranch?: string;
  worktreeLocation?: string;
  showSettings: boolean;
  onToggleSettings: () => void;
}) {
  // Local-branches query — only fires when the user expands settings.
  const { data: branches } = useBranches(showSettings ? workspaceId : null);
  const branchOptions = useMemo(() => {
    const set = new Set<string>();
    if (defaultBranch) set.add(defaultBranch);
    for (const b of branches ?? []) set.add(b);
    return [...set].sort();
  }, [branches, defaultBranch]);

  return (
    <div className="w-full max-w-[40rem] rounded-md border border-border bg-card overflow-hidden">
      {/* Header row — click toggles settings expand */}
      <button
        type="button"
        onClick={onToggleSettings}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-secondary/40 transition-colors text-left"
      >
        {showSettings ? (
          <ChevronDown className="size-3.5 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground/60" />
        )}
        <GitBranch className="size-3.5 text-muted-foreground/60" />
        <span className="text-xs font-medium flex-1">Worktree</span>
        <Toggle enabled={enabled} onClick={(v) => { onToggle(v); }} />
        <span className={cn('text-[10px] font-mono', enabled ? 'text-success' : 'text-muted-foreground/60')}>
          {enabled ? 'isolated' : 'off'}
        </span>
      </button>

      {/* Expanded settings */}
      {showSettings && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-input">
          {/* Branch name */}
          <label className="flex items-center gap-3 text-[11px]">
            <span className="w-16 text-muted-foreground/60 uppercase tracking-wider text-[10px] font-semibold">branch</span>
            <input
              type="text"
              value={branchName}
              onChange={(e) => onBranchName(e.target.value)}
              placeholder="session"
              className="flex-1 h-7 px-2 text-xs font-mono rounded bg-secondary border border-border focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={!enabled}
            />
          </label>

          {/* Base branch select */}
          <label className="flex items-center gap-3 text-[11px]">
            <span className="w-16 text-muted-foreground/60 uppercase tracking-wider text-[10px] font-semibold">base</span>
            <select
              value={baseBranch}
              onChange={(e) => onBaseBranch(e.target.value)}
              disabled={!enabled}
              className="flex-1 h-7 px-2 text-xs font-mono rounded bg-secondary border border-border focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {branchOptions.length === 0 && (
                <option value="">{defaultBranch ?? 'main'}</option>
              )}
              {branchOptions.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>

          {/* Config files — copied into the worktree after creation.
              Pre-seeded with detected .env files; user can add custom
              paths (relative to workspace root). Chips are removable. */}
          <div className="flex flex-col gap-1.5 text-[11px]">
            <div className="flex items-center gap-2">
              <span className="w-16 text-muted-foreground/60 uppercase tracking-wider text-[10px] font-semibold">copy</span>
              <div className="flex-1 flex flex-wrap items-center gap-1">
                {configFiles.map((f) => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 rounded bg-secondary border border-border pl-1.5 pr-0.5 py-0.5 text-[10px] font-mono"
                  >
                    {f}
                    <button
                      type="button"
                      onClick={() => onConfigFiles(configFiles.filter((x) => x !== f))}
                      disabled={!enabled}
                      className="text-muted-foreground/60 hover:text-destructive disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label={`Stop copying ${f}`}
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}
                {configFiles.length === 0 && (
                  <span className="text-[10px] text-muted-foreground/60 italic">none — add .env or other config paths</span>
                )}
              </div>
            </div>
            {/* Add custom path */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = (e.currentTarget.elements.namedItem('path') as HTMLInputElement);
                const v = input.value.trim();
                if (v && !configFiles.includes(v)) {
                  onConfigFiles([...configFiles, v]);
                }
                input.value = '';
              }}
              className="flex items-center gap-2 pl-[4.4rem]"
            >
              <input
                type="text"
                name="path"
                placeholder=".env.local, config/secrets.json…"
                disabled={!enabled}
                className="flex-1 h-6 px-2 text-[10px] font-mono rounded bg-secondary border border-border focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!enabled}
                className="text-[10px] text-muted-foreground/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
              >
                + add
              </button>
            </form>
          </div>

          {/* Location — read-only, derived from workspace config */}
          <div className="flex items-center gap-3 text-[11px]">
            <span className="w-16 text-muted-foreground/60 uppercase tracking-wider text-[10px] font-semibold">location</span>
            <code className="flex-1 text-[10px] font-mono text-muted-foreground/60 truncate">
              {joinPath(worktreeLocation || '.agent/worktrees/', branchName || 'session')}
            </code>
            <Settings2
              className="size-3 text-muted-foreground/40 cursor-pointer hover:text-muted-foreground/80"
              onClick={() => useUi.getState().setScreen('settings')}
            />
          </div>

          {/* Hint */}
          <div className="text-[10px] text-muted-foreground/60 pt-1 border-t border-input/60">
            Tool calls run inside the worktree — your main checkout stays clean.
            Branch + worktree are removed when the session is deleted.
          </div>
        </div>
      )}
    </div>
  );
}

/** Tiny pill toggle for the worktree on/off state. */
function Toggle({ enabled, onClick }: { enabled: boolean; onClick: (v: boolean) => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onClick(!enabled);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onClick(!enabled);
        }
      }}
      className={cn(
        'inline-flex items-center h-4 w-7 rounded-full p-0.5 transition-colors cursor-pointer',
        enabled ? 'bg-primary' : 'bg-muted',
      )}
      aria-pressed={enabled}
      aria-label={enabled ? 'Disable worktree' : 'Enable worktree'}
    >
      <span
        className={cn(
          'block size-3 rounded-full bg-background transition-transform',
          enabled ? 'translate-x-3' : 'translate-x-0',
        )}
      />
    </span>
  );
}

/** Fetch local branches — only runs when the user opens the settings. */
function useBranches(workspaceId: string | null) {
  const [branches, setBranches] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    if (!workspaceId) return;
    api.listBranches(workspaceId).then(setBranches).catch(() => setBranches([]));
  }, [workspaceId]);
  return { data: branches };
}

/** Convert free text into a valid git branch name. Lowercase, ASCII-only,
 *  non-alphanumerics → dashes, trimmed + collapsed. "Fix the auth leak!"
 *  → "fix-the-auth-leak". */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
}

/** Join a base path with a name, collapsing double slashes. Handles both
 *  `.agent/worktrees/` (trailing slash) and `.agent/worktrees` (no slash)
 *  without producing `.agent/worktrees//session`. */
function joinPath(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name}`;
}
