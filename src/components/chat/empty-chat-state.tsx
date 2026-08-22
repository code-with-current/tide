import { useEffect, useRef, useState } from 'react';
import { GitBranch, GitFork, FolderGit2, FolderCode, Plus, Check, ChevronDown } from 'lucide-react';
import { ChatComposer } from './chat-composer';
import { useModelOption, useWorkspaces, useGitBranchInfo, supportsThinking } from '@/lib/queries';
import { BranchMenu } from '@/components/git/branch-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  // Live branch for the selector chip — reflects checkouts made through the
  // branch menu instead of the stale persisted workspace.branch.
  const { data: branchInfo } = useGitBranchInfo(activeWorkspaceId, undefined);
  const liveBranch = branchInfo?.branch ?? workspace?.branch;

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

  // When worktree isolation is enabled, fire a one-shot auto-detection of
  // likely config files (.env etc.) and pre-select them. Re-runs on each
  // enable (fresher than the old once-ever detection); merges so manual
  // additions survive a toggle cycle.
  useEffect(() => {
    if (!worktreeEnabled || !activeWorkspaceId) return;
    api.listConfigFiles(activeWorkspaceId).then((found) => {
      setConfigFiles((cur) => {
        const set = new Set(cur);
        for (const f of found) set.add(f);
        return [...set];
      });
    }).catch(() => { /* IPC failure — leave selection empty */ });
  }, [worktreeEnabled, activeWorkspaceId]);

  return (
    <div className="flex-1 overflow-y-auto scroll relative">
      {/* Invisible drag region — keeps the window movable on macOS
          now that the top bar is hidden on this screen. */}
      <div className="drag-region absolute inset-x-0 top-0 h-10 z-10" />
      <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 gap-6 min-h-full">
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
              className="text-[0.7857rem] text-muted-foreground/60 hover:text-foreground underline underline-offset-2 transition-colors"
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
          <div className="flex items-center gap-2 text-[0.7857rem] text-muted-foreground/60 -mt-3">
            <GitFork className="size-3" />
            <span className="truncate max-w-[24rem]">forked from “{pendingFork.sourceTitle}”</span>
            <span>·</span>
            <span className="font-mono truncate max-w-[14rem]">{pendingFork.sourceModelId}</span>
          </div>
        )}*/}

        {/* Composer + workspace/branch selector row (bottom-left aligned) */}
        <div className="w-full max-w-[40rem] flex flex-col gap-2">
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
          <div className="mx-5 flex items-center gap-1.5 pl-2 pb-2 border border-input bg-input rounded-xl pt-7 -mt-7">
            <WorkspaceMenu currentId={workspace?.id} />
            <BranchMenu
              trigger={
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-border bg-card text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors cursor-pointer select-none"
                >
                  <GitBranch className="size-3 shrink-0" />
                  <span className="font-mono text-[0.7143rem] truncate max-w-[180px]">{liveBranch ?? 'no branch'}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-50" />
                </button>
              }
              worktree={{
                enabled: worktreeEnabled,
                onToggle: setWorktreeEnabled,
                branchName,
                onBranchName: (v) => {
                  setBranchTouched(true);
                  setBranchName(v);
                },
                baseBranch,
                onBaseBranch: setBaseBranch,
                configFiles,
                onConfigFiles: setConfigFiles,
                worktreeLocation: workspace?.worktreeLocation,
                defaultBranch: workspace?.branch,
              }}
            />
          </div>
        </div>

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

/** Workspace selector popover — active workspace list (current checked) with
 *  an "Add Workspace" action pinned at the very bottom. Switching resets the
 *  screen to a fresh draft via setActiveWorkspace. */
function WorkspaceMenu({ currentId }: { currentId?: string }) {
  const [open, setOpen] = useState(false);
  const { data: workspaces } = useWorkspaces();
  const openDialog = useUi((s) => s.openDialog);
  const active = (workspaces ?? []).filter((w) => !w.archivedAt);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-border bg-card text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors cursor-pointer select-none"
        >
          <FolderGit2 className="size-3 shrink-0" />
          <span className="text-[0.7143rem] truncate max-w-[140px]">
            {active.find((w) => w.id === currentId)?.name ?? 'workspace'}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0 overflow-hidden">
        <div className="max-h-[280px] overflow-y-auto scroll py-1">
          {active.length === 0 && (
            <div className="px-2 py-3 text-center text-[0.7143rem] text-muted-foreground/50">No workspaces</div>
          )}
          {active.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => {
                setOpen(false);
                if (w.id !== currentId) useUi.getState().setActiveWorkspace(w.id);
              }}
              className={cn(
                'w-full h-7 flex items-center gap-1.5 px-2 text-left transition-colors',
                w.id === currentId ? 'bg-primary/10' : 'hover:bg-secondary/40 cursor-pointer',
              )}
            >
              {w.id === currentId ? (
                <Check className="size-3 shrink-0 text-primary" />
              ) : (
                <FolderCode className="size-3 shrink-0 text-muted-foreground/50" />
              )}
              <span className={cn('text-[0.7857rem] truncate', w.id === currentId ? 'text-foreground font-medium' : 'text-muted-foreground')}>
                {w.name}
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-border p-1">
          <button
            type="button"
            onClick={() => { setOpen(false); openDialog('addWorkspace'); }}
            className="w-full h-7 flex items-center gap-1.5 px-2 rounded text-[0.7143rem] text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors cursor-pointer"
          >
            <Plus className="size-3 shrink-0" />
            Add Workspace
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
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
