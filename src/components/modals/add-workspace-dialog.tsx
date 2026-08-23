import {
  FolderCode,
  Folder,
  Sparkles,
  FilePlus2,
  ArrowLeft,
  Check,
  ChevronRight,
  CheckCircle2,
  HardDrive,
  Globe,
  Loader2,
  AlertCircle,
  Terminal,
  TriangleAlert,
  Download,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
// Actual stack logos — imported as URL strings (Vite handles .svg). Used in
// the From Template grid instead of generic lucide icons.
import nextLogo from '@/assets/stack/next.svg';
import nuxtLogo from '@/assets/stack/nuxt.svg';
import reactLogo from '@/assets/stack/react.svg';
import t3Logo from '@/assets/stack/t3.svg';
import tanstackLogo from '@/assets/stack/tanstack.svg';
import { useUi } from '@/lib/stores/ui';
import { qk, useWorkspaceSteps, useRagInitProgress, useRagDownloadProgress } from '@/lib/queries';
import * as api from '@/lib/api/client';
import { toast } from '@/lib/toast';
import type { GitRepoInfo } from '@/lib/api/client';
import type { Workspace, WorkspaceScript, WorkspaceProgressStep } from '@/types';
import { TEMPLATES, type TemplateId } from '@/lib/templates';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { phaseLabel } from '@/components/rag/rag-index-progress';

const log = createLogger('add-workspace');

/** Per-template logo. Keyed by TemplateId (not by the registry's `icon`
 *  glyph) so each stack shows its real brand mark. Empty has no logo — it
 *  falls back to the lucide Folder icon (an empty project has no brand). */
const TEMPLATE_LOGOS: Partial<Record<TemplateId, string>> = {
  nextjs: nextLogo,
  'vite-react': reactLogo,
  'tanstack-start': tanstackLogo,
  t3: t3Logo,
  nuxt: nuxtLogo,
};

/** Dialog phases: choice → form/newProject/template → creating → indexing → done/error. */
type Phase = 'choice' | 'form' | 'newProject' | 'template' | 'creating' | 'indexing' | 'done' | 'error';

/** Checklist step ids. Creation steps mirror the backend's
 *  tide:workspace:progress milestones; 'rag' is driven by the RAG init
 *  progress stream. Which steps appear depends on the chosen flow. */
type StepId = WorkspaceProgressStep | 'rag';
type StepStatus = 'pending' | 'active' | 'done' | 'skipped';
const STEP_LABELS: Record<StepId, string> = {
  clone: 'Clone repository',
  folder: 'Create folder',
  scaffold: 'Scaffold template',
  install: 'Install dependencies',
  git: 'Initialize git',
  detect: 'Detect repository',
  rag: 'Index codebase',
};

type Source = 'local' | 'remote';

export function AddWorkspaceDialog() {
  const open = useUi((s) => s.dialogs.addWorkspace);
  const close = useUi((s) => s.closeDialog);
  const setActive = useUi((s) => s.setActiveWorkspace);
  const qc = useQueryClient();

  const [source, setSource] = useState<Source>('local');
  const [localPath, setLocalPath] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [cloneDir, setCloneDir] = useState('');
  const [enableRag, setEnableRag] = useState(true);
  // Existing Project flow: optional install (setup) + running (run) scripts,
  // saved onto the new workspace. Off by default so the simple open-repo case
  // isn't cluttered. install fires on first open (existing setup-kind
  // behavior); running becomes the Run button's command.
  const [addScript, setAddScript] = useState(false);
  const [installCmd, setInstallCmd] = useState('');
  const [runCmd, setRunCmd] = useState('');
  // Local-open flow: when the chosen folder isn't a git repo, offer to init
  // one. Defaults on — git tracking is the expected baseline, and the warning
  // makes the missing state explicit. Ignored for the clone flow.
  const [initGit, setInitGit] = useState(true);
  const [phase, setPhase] = useState<Phase>('choice');
  const [phaseError, setPhaseError] = useState<string | null>(null);

  // Real-progress model. `requestId` correlates the backend's per-step
  // milestone stream (tide:workspace:progress) to this creation run;
  // `createdWsId` keys the RAG init progress stream once the workspace
  // exists. `activeSteps` is the flow-specific checklist (what the user
  // chose); each row's status is derived from the live streams below — not
  // from timers.
  const [requestId, setRequestId] = useState<string | null>(null);
  const [activeSteps, setActiveSteps] = useState<StepId[]>([]);
  const [createdWsId, setCreatedWsId] = useState<string | null>(null);
  // After addWorkspace resolves, force any creation step still pending/active
  // to 'done' — the milestone events are sent right before the IPC reply, so
  // this only guards a rare last-event race (it never lies: they are done).
  const [creationDone, setCreationDone] = useState(false);
  // RAG step outcome once indexing settles.
  const [ragOutcome, setRagOutcome] = useState<'pending' | 'done' | 'skipped'>('pending');

  // Model download state — mirrors OnboardingScreen's WorkspaceStep: when RAG
  // is enabled and the model isn't on disk, the user must download it inline
  // (with progress) before Open/Scaffold becomes enabled.
  type DlState = 'idle' | 'downloading' | 'done' | 'error';
  const [dlState, setDlState] = useState<DlState>('idle');
  const [dlError, setDlError] = useState<string | null>(null);
  const downloadProgress = useRagDownloadProgress();

  const wsSteps = useWorkspaceSteps(requestId);
  const ragProgress = useRagInitProgress(createdWsId);

  // New Project flow state — name + parent folder; the project dir is
  // synthesized as <parent>/<name> and created (mkdir + git init) by the
  // backend's addWorkspace handler.
  const [newName, setNewName] = useState('');
  const [newParent, setNewParent] = useState('');
  // Template flow: which template the user picked (defaults to Empty so the
  // grid always has a selection; Empty == New Project behavior).
  const [templateId, setTemplateId] = useState<TemplateId>('empty');

  // Git detection
  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [gitChecking, setGitChecking] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  // Reset to the picker every time the dialog opens, so reopening always
  // starts at the Existing/New choice rather than wherever the user left off.
  useEffect(() => {
    if (open) setPhase('choice');
  }, [open]);

  // Probe whether the model is already on disk each time the dialog opens —
  // if so the download section shows "Model ready" and the gate opens.
  useEffect(() => {
    if (open) {
      setDlState('idle');
      setDlError(null);
      api.ragModelExists().then((exists) => {
        if (exists) setDlState('done');
      }).catch(() => {});
    }
  }, [open]);

  // Sync download-progress events → local state.
  useEffect(() => {
    if (!downloadProgress) return;
    if (downloadProgress.phase === 'downloading') setDlState('downloading');
    else if (downloadProgress.phase === 'done') setDlState('done');
    else if (downloadProgress.phase === 'failed') {
      setDlState('error');
      setDlError(downloadProgress.error ?? 'Download failed');
    }
  }, [downloadProgress]);

  const handleDownloadModel = async () => {
    setDlState('downloading');
    setDlError(null);
    try {
      const r = await api.downloadRagModel();
      if (r.ok) {
        const exists = await api.ragModelExists();
        if (exists) setDlState('done');
        else {
          setDlState('error');
          setDlError('Download reported success but model not found on disk.');
        }
      } else {
        setDlState('error');
        setDlError(r.error ?? 'Download failed');
      }
    } catch (e) {
      setDlState('error');
      setDlError(e instanceof Error ? e.message : 'Download failed');
    }
  };

  useEffect(() => {
    if (source !== 'local' || !localPath) {
      setGitInfo(null);
      setGitError(null);
      return;
    }
    setGitChecking(true);
    setGitError(null);
    const timer = setTimeout(async () => {
      try {
        const info = await api.detectGitRepo(localPath);
        setGitInfo(info);
        if (!info) setGitError('Not a git repository');
      } catch {
        setGitInfo(null);
        setGitError('Cannot read directory');
      } finally {
        setGitChecking(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [localPath, source]);

  /** Open the OS folder picker and write the chosen path into the named target field. `target` is explicit so a Browse button never silently updates the wrong input (prior bug: New Project/Template phases browsed into `cloneDir` while their inputs read `newParent`, making the pick look like a no-op). */
  const handleBrowse = (target: 'localPath' | 'cloneDir' | 'newParent') => {
    api.pickDirectory().then((picked) => {
      if (!picked) return;
      if (target === 'localPath') setLocalPath(picked);
      else if (target === 'cloneDir') setCloneDir(picked);
      else setNewParent(picked);
    });
  };

  const handleOpen = async () => {
    let path = '';
    let steps: StepId[] = [];
    if (source === 'local') {
      path = localPath;
      // Existing local folder: the only creation-side work is an optional
      // `git init` when the folder isn't a repo and the user opted in.
      if (initGit && !gitInfo) steps.push('git');
    } else {
      // Remote: extract repo name from URL, clone into cloneDir/<name>.
      // e.g. https://github.com/foo/bar.git → cloneDir/bar
      if (!remoteUrl || !cloneDir) {
        setPhase('form');
        return;
      }
      const repoName = remoteUrl
        .replace(/\.git$/, '')
        .replace(/^.*\//, '');
      if (!repoName) {
        setPhase('error');
        setPhaseError('Could not determine repo name from URL.');
        return;
      }
      path = `${cloneDir}/${repoName}`;
      steps.push('clone');
    }
    if (!path) {
      setPhase('form');
      return;
    }
    steps.push('detect');
    if (enableRag) steps.push('rag');
    // Assemble scripts from the Existing Project fields (install → setup,
    // running → run). Only non-empty commands are kept.
    const scripts: WorkspaceScript[] = [];
    if (installCmd.trim()) scripts.push({ kind: 'setup', command: installCmd.trim() });
    if (runCmd.trim()) scripts.push({ kind: 'run', command: runCmd.trim() });
    // init-git only applies to the local-open flow (clone always yields a
    // repo) — and only matters when the folder isn't already a repo.
    const shouldInitGit = source === 'local' && initGit;
    await createWorkspace(path, steps, source === 'remote' ? remoteUrl : undefined, undefined, scripts, shouldInitGit);
  };

  /** New Project flow: synthesize <parent>/<name> and let the backend mkdir +
   *  git init it. Reuses the same createWorkspace path so RAG/indexing/done
   *  states are shared. */
  const handleOpenNewProject = async () => {
    if (!newName.trim() || !newParent.trim()) return;
    const steps: StepId[] = ['folder', 'git', 'detect'];
    if (enableRag) steps.push('rag');
    // path.join-equivalent — avoid trailing slashes that confuse basename.
    const synthesized = `${newParent.replace(/\/+$/, '')}/${newName.trim()}`;
    await createWorkspace(synthesized, steps, undefined);
  };

  /** From Template flow: same path synthesis as New Project, but passes the
   *  selected template id so the backend runs its scaffold command (and
   *  optional deps install) after mkdir + git init. */
  const handleOpenFromTemplate = async () => {
    if (!newName.trim() || !newParent.trim()) return;
    const hasScaffold = templateId !== 'empty';
    const steps: StepId[] = hasScaffold
      ? ['folder', 'scaffold', 'install', 'git', 'detect']
      : ['folder', 'git', 'detect'];
    if (enableRag) steps.push('rag');
    const synthesized = `${newParent.replace(/\/+$/, '')}/${newName.trim()}`;
    await createWorkspace(synthesized, steps, undefined, templateId);
  };

  /** Shared workspace-creation path for all three flows. Creation-side step
   *  statuses come from the live tide:workspace:progress stream (keyed by
   *  requestId); the RAG step comes from the rag init progress stream. No
   *  fake timers — the checklist reflects what the backend is actually doing. */
  const createWorkspace = async (
    path: string,
    steps: StepId[],
    repository: string | undefined,
    template?: TemplateId,
    scripts?: WorkspaceScript[],
    initGit?: boolean,
  ) => {
    // requestId correlates the backend milestone stream to this run (the
    // workspace id doesn't exist yet, so it can't key the events).
    const rid = Math.random().toString(36).slice(2);
    setRequestId(rid);
    setActiveSteps(steps);
    setCreatedWsId(null);
    setCreationDone(false);
    setRagOutcome('pending');
    setPhase('creating');
    setPhaseError(null);

    let ws: Workspace | undefined;
    try {
      // Build the input conditionally — only include `template` when set and
      // not 'empty' (Empty == no scaffold, equivalent to the New Project flow).
      // The Existing Project flow (clone OR local) carries optional scripts;
      // the local-open flow additionally carries initGit. requestId wires up
      // the per-step milestone stream.
      const input: Parameters<typeof api.addWorkspace>[0] = repository
        ? { path, repository, requestId: rid, ...(scripts?.length ? { scripts } : {}) }
        : template && template !== 'empty'
          ? { path, template, requestId: rid }
          : { path, requestId: rid, ...(scripts?.length ? { scripts } : {}), ...(initGit ? { initGit } : {}) };
      ws = await api.addWorkspace(input);
      // Force-finalize creation steps: the backend emits their 'done' events
      // right before returning, but guard against a last-event race so no row
      // is left spinning. (Honest — by now they really are done.)
      setCreationDone(true);
      // Instantly place the returned workspace into the list cache so it
      // appears in the sidebar the moment creation resolves — not a refetch
      // round-trip later. invalidateQueries then reconciles with server truth.
      const created = ws;
      qc.setQueryData<Workspace[]>(qk.workspaces, (old) =>
        old ? [...old, created] : [created],
      );
      qc.invalidateQueries({ queryKey: qk.workspaces });
    } catch (e: unknown) {
      setPhase('error');
      setPhaseError(e instanceof Error ? e.message : 'Failed to create workspace');
      // Toast reinforces the failure + survives dialog close/reopen.
      toast.error('Workspace creation failed', {
        description: e instanceof Error ? e.message : undefined,
      });
      return;
    }

    if (!ws?.id) return;
    // Now that the workspace exists, the RAG init progress stream (keyed by
    // workspace id) starts feeding the rag row's live detail.
    setCreatedWsId(ws.id);

    // Enable RAG first (adds to list + ensures model is available)
    if (enableRag) {
      setPhase('indexing');
      try {
        await api.enableRagWorkspace(ws.id);
        qc.invalidateQueries({ queryKey: qk.ragStatus(ws.id) });

        // Init runs in the background — poll ragStatus until it's done
        // or failed, then proceed to the session view.
        await api.initRagWorkspace(ws.id);

        // Poll status until ingestion finishes (the IPC returns
        // immediately; the real work happens in a background promise).
        // Timeout after 5 minutes. The per-chunk detail shown in the
        // checklist comes from ragProgress (the init stream), not this poll.
        const deadline = Date.now() + 300_000;
        let outcome: 'done' | 'skipped' = 'skipped';
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          const status = await api.ragStatus(ws.id);
          if ('error' in status) { outcome = 'skipped'; break; }
          const s = status as { initState?: string };
          if (s.initState === 'done') { outcome = 'done'; break; }
          if (s.initState === 'failed') { outcome = 'skipped'; break; }
        }
        qc.invalidateQueries({ queryKey: qk.ragStatus(ws.id) });
        setRagOutcome(outcome);
      } catch (e: unknown) {
        log.error('RAG init failed', e);
        // Don't block workspace entry on RAG failure — mark the step skipped
        // (not done) so the checklist is honest, and the user can retry from
        // Settings → Workspaces → Re-index.
        setRagOutcome('skipped');
      }
    } else {
      // RAG was opted off — mark skipped so the checklist completes.
      setRagOutcome('skipped');
    }

    // Enter the workspace + flip to the 'done' phase. The dialog stays open
    // showing the completed checklist until the user clicks "Open Workspace"
    // — no auto-dismiss, so the user controls when to leave and can verify
    // every step turned green (or skipped) first.
    setActive(ws.id);
    // A brand-new workspace has no sessions yet: hide the sessions panel (nothing to list) and the right panel (no active session). Both reopen automatically once the first message is sent (MainScreen's has-sessions effect).
    useUi.getState().setSessionsPanel(false);
    useUi.getState().setRightPanel(false);
    setPhase('done');
    // Outcome confirmation — the checklist already shows progress, this
    // confirms completion (and survives if the user dismisses the dialog).
    toast.success('Workspace added');
    if (initGit) toast.success('Git repository initialized');
  };

  /** Clear all form state so the next open starts clean. */
  const resetAll = () => {
    setLocalPath('');
    setRemoteUrl('');
    setCloneDir('');
    setAddScript(false);
    setInstallCmd('');
    setRunCmd('');
    setInitGit(true);
    setNewName('');
    setNewParent('');
    setTemplateId('empty');
    setGitInfo(null);
    setSource('local');
    setPhase('choice');
    setPhaseError(null);
    setRequestId(null);
    setActiveSteps([]);
    setCreatedWsId(null);
    setCreationDone(false);
    setRagOutcome('pending');
  };

  /** Close handler for the "Open Workspace" button on the done screen.
   *  Resets + closes; the workspace is already active (setActive ran during
   *  the flow), so the main UI is showing it underneath. */
  const finishAndClose = () => {
    resetAll();
    close('addWorkspace');
  };

  // Folder-in-place gate for the Script/RAG cards — deliberately NOT canOpen:
  // canOpen additionally requires the model when RAG is on, which would hide
  // the RAG card (and its download button) exactly when it's needed.
  const hasProject = source === 'local' ? !!localPath : !!cloneDir;
  const canOpen = hasProject && (!enableRag || dlState === 'done');
  // Template flow: the RAG card (and thus the model requirement) only shows
  // for real scaffolds; Empty projects no-op RAG without a model.
  const templateNeedsModel = templateId !== 'empty' && enableRag;
  const canOpenNew = !!newName.trim() && !!newParent.trim()
    && (!templateNeedsModel || dlState === 'done');

  /** Resolve a checklist row's status from the live streams (not timers).
   *  Creation steps come from the tide:workspace:progress milestones; the
   *  rag row from the indexing phase + its settled outcome. */
  const resolveStatus = (id: StepId): StepStatus => {
    if (id === 'rag') {
      if (phase === 'done') return ragOutcome === 'done' ? 'done' : 'skipped';
      if (phase === 'indexing') return 'active';
      return 'pending';
    }
    const ev = wsSteps[id];
    if (ev) return ev.status === 'failed' ? 'skipped' : ev.status;
    // No milestone yet — if creation already resolved, force done (safety net
    // against a last-event race). Otherwise pending.
    return creationDone ? 'done' : 'pending';
  };

  // Live headline + RAG detail, driven by the real streams.
  const activeCreationLabel = activeSteps.find(
    (id) => id !== 'rag' && resolveStatus(id) === 'active',
  );
  const ragActive = phase === 'indexing' && !!ragProgress && ragProgress.phase !== 'done' && ragProgress.phase !== 'failed';
  const ragDeterminate = ragActive && ragProgress!.phase === 'embedding' && ragProgress!.chunksTotal > 0;
  const ragPct = ragDeterminate
    ? Math.min(100, Math.round((ragProgress!.chunksEmbedded / ragProgress!.chunksTotal) * 100))
    : 0;
  const ragCounts = !ragActive || !ragProgress
    ? ''
    : ragProgress.phase === 'walking'
      ? `${ragProgress.filesSeen} files`
      : ragProgress.phase === 'chunking'
        ? `${ragProgress.chunksTotal} chunks · ${ragProgress.filesSeen} files`
        : ragProgress.phase === 'embedding'
          ? `${ragProgress.chunksEmbedded} / ${ragProgress.chunksTotal} chunks`
          : '';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Allow closing from any non-async phase (choice/form/newProject/
        // template/done). While creating/indexing the user shouldn't be able
        // to dismiss mid-operation. 'done' is included so X/Esc works after
        // the checklist completes — same effect as the Open Workspace button.
        if (!o && phase !== 'creating' && phase !== 'indexing' && phase !== 'error') {
          resetAll();
          close('addWorkspace');
        }
      }}
    >
      <DialogContent className="max-w-[640px] p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-5 py-4 flex-row items-center gap-3.5 border-b border-border space-y-0">
          <div
            className={cn(
              'size-9 rounded-[10px] flex items-center justify-center shrink-0',
              phase === 'done'
                ? 'bg-success/10 border border-success/20'
                : 'border',
            )}
            style={
              phase !== 'done'
                ? { background: 'rgba(--primary)', borderColor: 'rgba(--primary)' }
                : undefined
            }
          >
            {phase === 'done' ? (
              <Check className="size-4 text-emerald-400" />
            ) : phase === 'error' ? (
              <AlertCircle className="size-4 text-destructive" />
            ) : (
              <FolderCode className="size-4 text-primary" />
            )}
          </div>
          <div className="flex-1">
            <DialogTitle className="text-[1.0714rem] font-semibold text-left tracking-tight">
              {phase === 'creating' ? 'Creating workspace…'
                : phase === 'indexing' ? 'Indexing codebase…'
                : phase === 'done' ? 'Workspace ready'
                : phase === 'error' ? 'Failed'
                : phase === 'newProject' ? 'New Project'
                : phase === 'template' ? 'From Template'
                : 'New Workspace'}
            </DialogTitle>
            <p className="text-[0.7857rem] text-muted-foreground/60 mt-0.5">
              {phase === 'creating' ? 'Setting up the workspace.'
                : phase === 'indexing' ? 'Embedding code chunks — this may take a minute.'
                : phase === 'done' ? 'Opening session view…'
                : phase === 'error' ? phaseError ?? 'Something went wrong.'
                : phase === 'newProject' ? 'Create an empty project folder initialized with git.'
                : phase === 'template' ? 'Scaffold a new project with a starter stack.'
                : phase === 'form' ? 'Open an existing repository or clone one.'
                : 'Add a workspace to start working in.'}
            </p>
          </div>
        </DialogHeader>

        {/* Progress checklist — shown during creating/indexing/done. Each
            row's status is driven by the live backend streams
            (tide:workspace:progress + rag init progress), so it reflects what
            is actually happening, not a cosmetic timer. The set of rows
            depends on the flow the user chose. */}
        {(phase === 'creating' || phase === 'indexing' || phase === 'done') && (
          <div className="px-5 py-5">
            {/* Summary line — names the currently-active step, or the RAG
                indexing phase when embedding. */}
            <div className="flex items-center gap-2.5 mb-4">
              {phase === 'done' ? (
                <div className="size-7 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                  <Check className="size-4 text-emerald-400" />
                </div>
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground/60" />
              )}
              <div className="text-[0.9286rem] font-medium min-w-0 truncate">
                {phase === 'creating' && (activeCreationLabel ? STEP_LABELS[activeCreationLabel] + '…' : 'Setting up workspace…')}
                {phase === 'indexing' && (ragProgress && ragProgress.phase !== 'done' && ragProgress.phase !== 'failed'
                  ? phaseLabel(ragProgress.phase) + '…'
                  : 'Indexing codebase…')}
                {phase === 'done' && 'Workspace ready'}
              </div>
              {ragDeterminate && (
                <span className="ml-auto text-[0.7857rem] font-mono text-muted-foreground tabular-nums">{ragPct}%</span>
              )}
            </div>

            {/* RAG determinate progress bar — only while embedding with a
                known chunk total. Mirrors the Inspector/Settings RAG card. */}
            {ragDeterminate && (
              <div className="h-1.5 rounded-full bg-secondary overflow-hidden mb-3">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all duration-300"
                  style={{ width: `${ragPct}%` }}
                />
              </div>
            )}

            {/* Step list */}
            <div className="flex flex-col gap-1.5 mb-4">
              {activeSteps.map((id) => (
                <StepRow key={id} label={STEP_LABELS[id]} status={resolveStatus(id)} detail={id === 'rag' ? ragCounts : wsSteps[id]?.detail} />
              ))}
            </div>

            {/* Done → manual close button. No auto-dismiss: the user clicks
                to leave, after verifying every step is green/skipped. */}
            {phase === 'done' && (
              <Button variant="default" size="sm" className="w-full gap-1.5" onClick={finishAndClose}>
                <Check className="size-3.5" /> Open Workspace
              </Button>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className="px-5 py-8">
            <div className="rounded-md px-4 py-3 border border-destructive/20 bg-destructive/5 flex items-start gap-2.5">
              <AlertCircle className="size-4 text-destructive mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="text-[0.8571rem] font-medium text-destructive">Failed to create workspace</div>
                <div className="text-[0.7857rem] text-muted-foreground/60 mt-1">{phaseError}</div>
              </div>
            </div>
            <Button
              variant="secondary" size="sm" className="w-full mt-3"
              onClick={() => { setPhase('form'); setPhaseError(null); }}
            >
              Try again
            </Button>
          </div>
        )}

        {/* Choice picker — the initial screen. Three options route to the
            Existing Project form, the blank New Project form, or the
            From Template picker. */}
        {phase === 'choice' && (
          <div className="p-5 flex flex-col gap-3">
            <ChoiceCard
              icon={<Folder />}
              title="Existing Project"
              description="A local repo, or clone one from a URL."
              onClick={() => setPhase('form')}
            />
            {/*<ChoiceCard
              icon={<FolderPlus />}
              title="New Project"
              description="Create an empty project folder (with git init) and start fresh."
              onClick={() => setPhase('newProject')}
            />*/}
            <ChoiceCard
              icon={<Sparkles />}
              title="New Project or Template"
              description="Create an empty or scaffold a new project."
              onClick={() => setPhase('template')}
            />
          </div>
        )}

        {/* New Project form — minimal: just a name + parent folder. The
            backend mkdirs <parent>/<name> and runs `git init`. */}
        {phase === 'newProject' && (
          <>
            <div className="px-5 py-4">
              <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Project name</label>
              <Input
                className="font-mono text-[0.8571rem] h-[34px] mb-4"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-new-project"
                autoFocus
              />

              <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Parent folder</label>
              <div className="flex gap-2 mb-2.5">
                <Input
                  className="font-mono text-[0.8571rem] flex-1 h-[34px]"
                  value={newParent}
                  onChange={(e) => setNewParent(e.target.value)}
                  placeholder="/path/to/parent"
                />
                <Button variant="secondary" size="sm" className="h-[34px] gap-1.5" onClick={() => handleBrowse('newParent')}>
                  <Folder className="size-3.5" /> Browse
                </Button>
              </div>

              {/* Live preview of the synthesized path */}
              {newParent && newName.trim() && (
                <div className="rounded-md px-3 py-2 flex items-center gap-2 text-[0.7857rem] text-muted-foreground/60 border border-border bg-secondary mb-4">
                  <FilePlus2 className="size-3.5" />
                  <span>Will create</span>
                  <code className="font-mono text-[0.7143rem] text-foreground/80">
                    {newParent.replace(/\/+$/, '')}/{newName.trim()}
                  </code>
                </div>
              )}

              {/* RAG enable card intentionally hidden in the New Project flow:
                  an empty project has no files to index, so the toggle is
                  noise. enableRag stays true by default; RAG on an empty
                  workspace no-ops gracefully and re-indexes once files exist. */}
            </div>
            <div className="px-5 py-3.5 flex items-center justify-between gap-2 bg-secondary border-t border-border">
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setPhase('choice')}>
                <ArrowLeft className="size-3.5" /> Back
              </Button>
              <Button variant="default" size="sm" disabled={!canOpenNew} onClick={handleOpenNewProject} className="gap-1.5">
                <Check className="size-3.5" /> Create Project
              </Button>
            </div>
          </>
        )}

        {/* From Template flow — name + parent + a grid of stack templates.
            Selecting a template + Create runs the backend's scaffold step. */}
        {phase === 'template' && (
          <>
            <div className="px-5 py-4">
              <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Project name</label>
              <Input
                className="font-mono text-[0.8571rem] h-[34px] mb-4"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-new-project"
                autoFocus
              />

              <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Parent folder</label>
              <div className="flex gap-2 mb-4">
                <Input
                  className="font-mono text-[0.8571rem] flex-1 h-[34px]"
                  value={newParent}
                  onChange={(e) => setNewParent(e.target.value)}
                  placeholder="/path/to/parent"
                />
                <Button variant="secondary" size="sm" className="h-[34px] gap-1.5" onClick={() => handleBrowse('newParent')}>
                  <Folder className="size-3.5" /> Browse
                </Button>
              </div>

              <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Template</label>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {TEMPLATES.map((t) => {
                  const logo = TEMPLATE_LOGOS[t.id];
                  const selected = templateId === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTemplateId(t.id)}
                      className={cn(
                        'text-left rounded-[8px] p-3 border transition-all flex flex-col gap-1.5',
                        selected
                          ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/30'
                          : 'border-border bg-card hover:border-primary/30 hover:bg-secondary',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {logo ? (
                          <img src={logo} alt="" className="size-4 object-contain" />
                        ) : (
                          <Folder className={cn('size-4', selected ? 'text-primary' : 'text-muted-foreground')} />
                        )}
                        <span className="text-[0.8571rem] font-semibold tracking-tight">{t.label}</span>
                        {selected && <Check className="size-3 text-primary ml-auto" />}
                      </div>
                      <p className="text-[0.75rem] text-muted-foreground/70 leading-snug">{t.description}</p>
                    </button>
                  );
                })}
              </div>

              {/* Live path preview */}
              {newParent && newName.trim() && (
                <div className="rounded-md px-3 py-2 flex items-center gap-2 text-[0.7857rem] text-muted-foreground/60 border border-border bg-secondary mb-4">
                  <FilePlus2 className="size-3.5" />
                  <span>Will create</span>
                  <code className="font-mono text-[0.7143rem] text-foreground/80">
                    {newParent.replace(/\/+$/, '')}/{newName.trim()}
                  </code>
                </div>
              )}

              {/* RAG enable card — only shown for real scaffolds (they produce
                  files worth indexing). The Empty template has no files, so
                  the card is hidden just like the New Project flow. */}
              {templateId !== 'empty' && (
                <div className="rounded-[10px] p-3.5 border border-emerald-500/15 bg-emerald-500/[0.04] flex items-start gap-3">
                  <div className="size-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0 text-emerald-400 text-[1.0714rem]">
                    ◈
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.8571rem] font-semibold">Enable RAG for this workspace</div>
                    <div className="text-[0.7857rem] text-muted-foreground/60 mt-0.5 leading-relaxed">
                      Indexes your codebase locally so the agent can search it semantically.
                    </div>
                    <ModelDownloadSection
                      dlState={dlState}
                      dlError={dlError}
                      progress={downloadProgress}
                      onDownload={handleDownloadModel}
                    />
                  </div>
                  <Switch checked={enableRag} onCheckedChange={setEnableRag} className="mt-1.5" />
                </div>
              )}
            </div>
            <div className="px-5 py-3.5 flex items-center justify-between gap-2 bg-secondary border-t border-border">
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setPhase('choice')}>
                <ArrowLeft className="size-3.5" /> Back
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={!canOpenNew}
                onClick={handleOpenFromTemplate}
                className="gap-1.5"
              >
                <ChevronRight className="size-3.5" />
                {templateId === 'empty' ? 'Create Project' : `Scaffold ${TEMPLATES.find((t) => t.id === templateId)?.label}`}
              </Button>
            </div>
          </>
        )}

        {/* Form — only visible in 'form' phase */}
        {phase === 'form' && (
        <div className="px-5 py-4">
          {/* Source tabs */}
          <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Source</label>
          <div className="flex gap-1 mb-4 bg-secondary rounded-md p-[3px]">
            <SourceTab
              active={source === 'local'}
              onClick={() => setSource('local')}
              icon={<HardDrive className="size-3.5" />}
              label="Local folder"
            />
            <SourceTab
              active={source === 'remote'}
              onClick={() => setSource('remote')}
              icon={<Globe className="size-3.5" />}
              label="Clone from URL"
            />
          </div>

          {/* LOCAL flow */}
          {source === 'local' && (
            <>
              <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Repository path</label>
              <div className="flex gap-2 mb-3">
                <Input
                  className="font-mono text-[0.8571rem] flex-1 h-[34px]"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="/path/to/your/repo"
                />
                <Button variant="secondary" size="sm" className="h-[34px] gap-1.5" onClick={() => handleBrowse('localPath')}>
                  <Folder className="size-3.5" /> Browse
                </Button>
              </div>

              {/* Git detection */}
              {!localPath && (
                <div className="rounded-md px-3 py-2 flex items-center gap-2 text-[0.7857rem] text-muted-foreground/50 border border-border bg-secondary">
                  <Folder className="size-3.5" /> Browse for a folder containing a .git directory.
                </div>
              )}
              {localPath && gitChecking && (
                <div className="rounded-md px-3 py-2 flex items-center gap-2 text-[0.7857rem] text-muted-foreground/60 border border-border bg-secondary">
                  <Loader2 className="size-3.5 animate-spin" /> Checking for git repository…
                </div>
              )}
              {localPath && !gitChecking && gitInfo && (
                <div
                  className="rounded-md px-3 py-2 flex items-center gap-2 text-[0.7857rem] border flex-wrap"
                  style={{ background: 'rgba(52,211,153,0.06)', borderColor: 'rgba(52,211,153,0.2)', color: 'var(--success)' }}
                >
                  <CheckCircle2 className="size-3.5" />
                  <span>Git repository detected</span>
                  <span className="text-muted-foreground/50">·</span>
                  <code className="font-mono text-[0.7143rem] opacity-80">{gitInfo.branch} @ {gitInfo.headCommit}</code>
                  <span className="text-muted-foreground/50">·</span>
                  <code className="font-mono text-[0.7143rem] opacity-80">{gitInfo.fileCount.toLocaleString()} files</code>
                </div>
              )}
                {localPath && !gitChecking && gitError && (
                  <div className="rounded-[10px] p-3.5 border border-warning bg-warning/10 flex items-start gap-3">
                    <div className="size-8 rounded-lg bg-warning/20 flex items-center justify-center shrink-0 text-warning">
                      <TriangleAlert className="size-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[0.8571rem] font-semibold">{gitError}</div>
                      <div className="text-[0.7857rem] text-muted-foreground/60 mt-0.5 leading-relaxed">
                        Initialize git repo on this folder.
                      </div>

                    </div>
                    <Switch checked={initGit} onCheckedChange={setInitGit} className="mt-1.5" />
                  </div>
              )}
            </>
          )}

          {/* REMOTE flow */}
          {source === 'remote' && (
            <>
              <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Git URL</label>
              <div className="flex gap-2 mb-3">
                <Input
                  className="font-mono text-[0.8571rem] flex-1 h-[34px]"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                />
              </div>

              <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-2">Clone destination</label>
              <div className="flex gap-2 mb-2">
                <Input
                  className="font-mono text-[0.8571rem] flex-1 h-[34px]"
                  value={cloneDir}
                  onChange={(e) => setCloneDir(e.target.value)}
                  placeholder="/parent/directory"
                />
                <Button variant="secondary" size="sm" className="h-[34px] gap-1.5" onClick={() => handleBrowse('cloneDir')}>
                  <Folder className="size-3.5" /> Browse
                </Button>
              </div>
              {cloneDir && (
                <div className="text-[0.7143rem] text-muted-foreground/50 font-mono mt-1.5">
                  Repo will be cloned to{' '}
                  <code className="bg-secondary px-1.5 py-0.5 rounded border border-border">
                    {cloneDir}/&lt;repo-name&gt;
                  </code>
                </div>
              )}
            </>
          )}

          {/* Script + RAG sections appear only once a project folder is in
              place — empty-prompts for repo path / clone destination stay the
              focus until the user has actually pointed at a project. */}
          {hasProject && (
            <>
          <div className="h-3" />

          <div className="rounded-[10px] p-3.5 border border-border bg-card flex items-start gap-3">
            <div className="size-8 rounded-lg bg-secondary flex items-center justify-center shrink-0 text-muted-foreground">
              <Terminal className="size-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[0.8571rem] font-semibold">Add Script</div>
              <div className="text-[0.7857rem] text-muted-foreground/60 mt-0.5 leading-relaxed">
                Bind Install & Run commands to this workspace.
              </div>
              {addScript && (
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div>
                    <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-1.5">Install</label>
                    <Input
                      className="font-mono text-[0.8571rem] h-[34px]"
                      value={installCmd}
                      onChange={(e) => setInstallCmd(e.target.value)}
                      placeholder="npm install"
                    />
                  </div>
                  <div>
                    <label className="text-[0.7143rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-1.5">Running</label>
                    <Input
                      className="font-mono text-[0.8571rem] h-[34px]"
                      value={runCmd}
                      onChange={(e) => setRunCmd(e.target.value)}
                      placeholder="npm run dev"
                    />
                  </div>
                </div>
              )}
            </div>
            <Switch checked={addScript} onCheckedChange={setAddScript} className="mt-1.5" />
                </div>


          <div className="h-3" />

          {/* RAG enable card */}
          <div className="rounded-[10px] p-3.5 border border-emerald-500/15 bg-emerald-500/[0.04] flex items-start gap-3 mb-3">
            <div className="size-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0 text-emerald-400 text-[1.0714rem]">
              ◈
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[0.8571rem] font-semibold">Enable RAG for this workspace</div>
              <div className="text-[0.7857rem] text-muted-foreground/60 mt-0.5 leading-relaxed">
                Indexes your codebase locally so the agent can search it semantically.
              </div>
              <div className="text-[0.7143rem] text-muted-foreground/40 mt-1 font-mono">
                all-MiniLM-L6-v2-code-search-512 · 384-dim · bundled
              </div>
              <ModelDownloadSection
                dlState={dlState}
                dlError={dlError}
                progress={downloadProgress}
                onDownload={handleDownloadModel}
              />
            </div>
            <Switch checked={enableRag} onCheckedChange={setEnableRag} className="mt-1.5" />
          </div>
            </>
          )}
        </div>
        )}

        {/* Footer — only in form phase */}
        {phase === 'form' && (
        <div className="px-5 py-3.5 flex items-center justify-between gap-2 bg-secondary border-t border-border">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setPhase('choice')}>
            <ArrowLeft className="size-3.5" /> Back
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { resetAll(); close('addWorkspace'); }}>
              Cancel
            </Button>
            <Button variant="default" size="sm" disabled={!canOpen} onClick={handleOpen} className="gap-1.5">
              <Check className="size-3.5" /> Open Workspace
            </Button>
          </div>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One row of the progress checklist. Renders a status glyph (✓ / spinner /
 *  hollow / –) + the step label, color-coded so done reads green at a glance.
 *  `detail` is an optional live sub-label (e.g. "42 / 120 chunks", or the
 *  template label) shown muted beside the label while the step is active.
 *  Purely presentational — the parent owns status + detail. */
function StepRow({ label, status, detail }: { label: string; status: StepStatus; detail?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className="size-4 flex items-center justify-center shrink-0">
        {status === 'done' && <Check className="size-3.5 text-emerald-400" />}
        {status === 'active' && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {status === 'pending' && <span className="size-2 rounded-full border border-muted-foreground/30" />}
        {status === 'skipped' && <span className="text-[0.7857rem] text-muted-foreground/40">–</span>}
      </span>
      <span
        className={cn(
          'text-[0.8571rem]',
          status === 'done' && 'text-foreground',
          status === 'active' && 'text-foreground',
          status === 'pending' && 'text-muted-foreground',
          status === 'skipped' && 'text-muted-foreground/50 line-through',
        )}
      >
        {label}
      </span>
      {detail && status === 'active' && (
        <span className="text-[0.75rem] text-muted-foreground/60 font-mono tabular-nums truncate">{detail}</span>
      )}
    </div>
  );
}

/** Inline model-download section shown inside the RAG card when RAG is
 *  enabled: Download button (model missing) → progress bar (downloading) →
 *  "Model ready" (on disk). Mirrors the onboarding WorkspaceStep flow; the
 *  parent gates its continue button on dlState === 'done'. */
function ModelDownloadSection({
  dlState, dlError, progress, onDownload,
}: {
  dlState: 'idle' | 'downloading' | 'done' | 'error';
  dlError: string | null;
  progress: { received: number; total: number } | null | undefined;
  onDownload: () => void;
}) {
  return (
    <div className="mt-2.5">
      {dlState === 'idle' && (
        <Button variant="secondary" size="sm" className="h-[28px] text-[0.7857rem] gap-1.5" onClick={onDownload}>
          <Download className="size-3" /> Download model (22 MB)
        </Button>
      )}
      {dlState === 'downloading' && (
        <div className="space-y-1.5 w-full max-w-[260px]">
          <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300 bg-emerald-400"
              style={{
                width: progress && progress.total > 0
                  ? `${Math.min(100, (progress.received / progress.total) * 100)}%`
                  : '8%',
              }}
            />
          </div>
          <div className="text-[0.7143rem] text-muted-foreground/50 font-mono flex items-center gap-1.5">
            <Loader2 className="size-2.5 animate-spin" />
            {progress && progress.total > 0
              ? `${(progress.received / 1048576).toFixed(1)} / ${(progress.total / 1048576).toFixed(1)} MB`
              : 'Connecting to huggingface.co…'}
          </div>
        </div>
      )}
      {dlState === 'done' && (
        <div className="flex items-center gap-1.5 text-[0.7857rem] text-emerald-400/80">
          <CheckCircle2 className="size-3.5" />
          Model ready
          <span className="text-muted-foreground/30 font-mono ml-1">all-MiniLM-L6-v2 · 384-dim</span>
        </div>
      )}
      {dlState === 'error' && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[0.7857rem] text-destructive/70">
            <AlertCircle className="size-3.5" />
            {dlError ?? 'Download failed'}
          </div>
          <Button variant="secondary" size="sm" className="h-[24px] text-[0.7143rem] gap-1.5" onClick={onDownload}>
            <Download className="size-2.5" /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}

function SourceTab({
  active, onClick, icon, label,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 py-1.5 px-3 rounded-[5px] text-[0.8571rem] font-medium text-center transition-all flex items-center justify-center gap-1.5 border-none',
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'bg-transparent text-muted-foreground hover:text-foreground/80',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Big selectable card on the choice screen. Whole card is clickable; hover
 *  lifts the border + icon accent so it reads as a primary affordance. */
function ChoiceCard({
  icon, title, description, onClick,
}: {
  icon: React.ReactNode; title: string; description: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group w-full text-left rounded-[10px] p-4 border transition-all flex items-start gap-3.5',
        'border-border bg-card hover:border-primary/40 hover:bg-secondary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      <div
        className={cn(
          'size-10 rounded-[8px] flex items-center justify-center shrink-0 transition-colors',
          'bg-secondary border border-border text-muted-foreground',
          'group-hover:text-primary group-hover:border-primary/30',
        )}
        style={undefined}
      >
        {/* icon size matches the container; currentColor inherits the hover tint */}
        <span className="[&>svg]:size-5">{icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[0.9286rem] font-semibold tracking-tight">{title}</div>
        <div className="text-[0.7857rem] text-muted-foreground/70 mt-0.5 leading-relaxed">{description}</div>
      </div>
    </button>
  );
}
