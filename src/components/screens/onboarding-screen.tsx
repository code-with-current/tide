import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import tideLogoPng from '@/assets/logo.png';
import { LogoText } from '@/components/primitives';
import {
  ArrowLeft, ArrowRight, ShieldCheck, Loader2,
  Folder, CheckCircle2, HardDrive, Globe,
  Check, AlertCircle, Plus, Trash2, Plug, Brain,
  Terminal, TriangleAlert, Server, Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useUi } from '@/lib/stores/ui';
import { qk, useAddProvider, useRagDownloadProgress, useRagInitProgress } from '@/lib/queries';
import { phaseLabel as phaseLabelLocal } from '@/components/rag/rag-index-progress';
import { cn } from '@/lib/utils';
import * as api from '@/lib/api/client';
import { toast } from '@/lib/toast';
import type { GitRepoInfo } from '@/lib/api/client';
import type { ApiStyle, Model, Workspace, WorkspaceScript } from '@/types';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  PROTOCOL, ApiStylePicker, EndpointPreview, FetchModelsButton,
  SectionLabel, FormField, appendFetchedModels,
  type Row,
} from './settings/providers/providers';
import { Card, CardContent } from '../ui/card';

type Step = 'provider' | 'workspace';
type Phase = 'form' | 'creating' | 'indexing' | 'done' | 'error';

export function OnboardingScreen() {
  const setScreen = useUi((s) => s.setScreen);
  const setSelectedModel = useUi((s) => s.setSelectedModel);
  const setActive = useUi((s) => s.setActiveWorkspace);
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('provider');
  const [version, setVersion] = useState('—');
  useEffect(() => {
    window.tideIpc?.getDiagnostics().then((d) => setVersion(d.appVersion)).catch(() => {});
  }, []);

  // Route to main, unless macOS permissions need consent first (cheap native
  // check; instant-false on non-mac). Mirrors the SplashScreen gate so the
  // consent screen appears once after onboarding too.
  const goToMainOrConsent = () => {
    api.shouldShowConsent().then((show) => setScreen(show ? 'consent' : 'main'));
  };

  return (
    <div className="flex-1 flex overflow-hidden flex-col bg-background"
    >
      <div
        className="absolute inset-0 opacity-[0.01] pointer-events-none z-0"
        style={{
          backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
        }}
      />
      {/* Drag region — top strip only, so the rest of the onboarding screen
          (inputs, buttons) is interactive. Matches the window top bar height
          (h-10 = 40px). */}
      <div className="absolute w-full top-0 drag-region h-10 flex-shrink-0 bg-transparent z-10" />
      {/* Content row — panels sit side-by-side below the drag strip */}
      <div className="flex-1 flex overflow-hidden relative">
      {/* Grain texture */}

      {/* ─── LEFT: Brutal brand panel ─── */}
      <div
        className="hidden md:flex w-[38%] min-w-[380px] flex-col relative overflow-hidden bg-card/40"
      >
        {/* Giant logo watermark — bleeds left, ultra-subtle */}
        <div
          className="absolute pointer-events-none"
          style={{ top: '10%', left: '-40%', opacity: 0.05 }}
        >
          <img src={tideLogoPng} alt="" style={{ height: '500%', objectFit: 'contain' }} />
        </div>


        {/* Content */}
        <div className="relative z-10 flex flex-col h-full p-12">
          {/* Brand */}


          {/* Hero — center */}
          <div
            key={step}
            className="flex-1 flex flex-col justify-center"
            style={{ animation: 'fadeInUp 0.4s ease-out' }}
          >
            <div
              className="text-[96px] font-extrabold leading-[0.9] font-mono select-none"
              style={{
                color: 'transparent',
                WebkitTextStroke: '1px rgba(238,241,246,0.15)',
                letterSpacing: '-0.04em',
              }}
            >
              {step === 'provider' ? '01' : '02'}
            </div>
            <div className="text-[26px] font-bold tracking-tight mt-3">
              {step === 'provider' ? 'Connect your model' : 'Open a workspace'}
            </div>
            <div className="w-10 h-[3px] rounded-sm mt-4" style={{ background: '#d97757' }} />
            <div className="text-[13px] text-muted-foreground/40 leading-relaxed mt-3 max-w-[280px]">
              {step === 'provider'
                ? 'Works with any Anthropic or OpenAI-compatible endpoint. Your key stays encrypted in the OS keychain.'
                : 'Point Tide at a git repository. Each session gets its own worktree — your main branch stays untouched.'}
            </div>
          </div>

          {/* Progress bars */}
          <div className="flex items-center gap-1.5">
            <div className={cn('h-[3px] rounded-sm transition-all duration-300', step === 'provider' ? 'w-7' : 'w-3 bg-muted-foreground/20')} style={step === 'provider' ? { background: '#d97757' } : {}} />
            <div className={cn('h-[3px] rounded-sm transition-all duration-300', step === 'workspace' ? 'w-7' : 'w-3 bg-muted-foreground/20')} style={step === 'workspace' ? { background: '#d97757' } : {}} />
            <span className="text-[10px] text-muted-foreground/30 ml-2 uppercase tracking-[0.1em]">
              Step {step === 'provider' ? '1' : '2'} of 2
            </span>
          </div>
        </div>

        {/* Version tag */}
        <div
          className="absolute bottom-12 right-12 text-[9px] text-muted-foreground/15 font-mono uppercase tracking-[0.15em]"
          style={{ writingMode: 'vertical-rl' }}
        >
          v{version}
        </div>
      </div>

      {/* ─── RIGHT: Form ─── */}
      <div className="flex-1 flex flex-col overflow-x-auto scroll bg z-10">

        {step === 'provider' ? (
          <ProviderStep
            onNext={() => setStep('workspace')}
            setSelectedModel={setSelectedModel}
            qc={qc}
          />
        ) : (
          <WorkspaceStep
            onBack={() => setStep('provider')}
            onSkip={() => goToMainOrConsent()}
            onComplete={(wsId) => { setActive(wsId); goToMainOrConsent(); }}
            qc={qc}
          />
        )}
      </div>
      </div>{/* /content row */}
    </div>
  );
}

// =============================================================
// STEP 1: Provider
// =============================================================

function ProviderStep({
  onNext, setSelectedModel, qc,
}: {
  onNext: () => void;
  setSelectedModel: (providerId: string, modelId: string) => void;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const addProvider = useAddProvider();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [name, setName] = useState('');
  const [apiStyle, setApiStyle] = useState<ApiStyle>('openai');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [rows, setRows] = useState<Row[]>([{ alias: '', modelId: '', context: '' }]);

  // Follow the protocol with its canonical endpoint when toggling style
  const prevStyle = useRef<ApiStyle>(apiStyle);
  useEffect(() => {
    if (prevStyle.current === apiStyle) return;
    prevStyle.current = apiStyle;
    const AD = 'https://api.anthropic.com';
    const OD = 'https://api.openai.com/v1';
    const target = apiStyle === 'anthropic' ? AD : OD;
    setBaseUrl((cur) => {
      const t = cur.trim();
      return t === '' || t === AD || t === OD ? target : cur;
    });
  }, [apiStyle]);

  const rowsToModels = (): Model[] =>
    rows
      .filter((r) => r.modelId.trim() || r.alias.trim())
      .map((r) => ({
        id: `m_${Math.random().toString(36).slice(2, 8)}`,
        alias: r.alias.trim() || r.modelId.trim(),
        modelId: r.modelId.trim(),
        contextWindow: parseInt(r.context, 10) || 200_000,
        providerId: '',
        // Preserve metadata populated by FetchModelsButton — these drive the
        // brain icon, context lock, thinking gate, and cost meter. Matches
        // Settings' rowsToModels so a model added in onboarding has the same
        // metadata as one added in Settings.
        catalogId: r.catalogId,
        reasoning: r.reasoning,
        reasoningMandatory: r.reasoningMandatory,
        supportedEfforts: r.supportedEfforts,
        priceLabel: r.priceLabel,
        inputCostPerToken: r.inputCostPerToken,
        outputCostPerToken: r.outputCostPerToken,
        cacheReadCostPerToken: r.cacheReadCostPerToken,
        cacheWriteCostPerToken: r.cacheWriteCostPerToken,
      }));

  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => {
      const next = rs.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });

  // Validation: form is complete when name, baseUrl, apiKey are filled AND
  // at least one model has a modelId (alias-only rows don't count — the agent
  // can't call a model without knowing its ID).
  const validModels = rowsToModels();
  const hasModelWithId = rows.some((r) => r.modelId.trim().length > 0);
  const formValid = !!name.trim() && !!baseUrl.trim() && !!apiKey.trim() && hasModelWithId;

  // Clear test result whenever the form changes after a test — stale green
  // checkmarks are misleading if the user edited a field.
  useEffect(() => { setTestResult(null); }, [name, baseUrl, apiKey, apiStyle, rows]);

  const handleSave = async () => {
    if (!formValid) return;

    // Step 1: test the connection with the first model before saving.
    setTesting(true);
    setTestResult(null);
    const test = await window.tideIpc!.testProviderConnection({
      apiStyle,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      modelId: rows.find((r) => r.modelId.trim())!.modelId.trim(),
    });
    setTesting(false);

    if (!test.ok) {
      setTestResult({ ok: false, error: test.error });
      return; // Don't save — let the user fix the config and retry.
    }
    setTestResult({ ok: true });

    // Step 2: save the provider now that we know it works.
    setSaving(true);
    try {
      const created = await addProvider.mutateAsync({
        name: name.trim() || 'Untitled',
        apiStyle,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        models: validModels,
      });
      qc.invalidateQueries({ queryKey: ['providers'] });
      if (created.models[0]) setSelectedModel(created.id, created.models[0].modelId);
      onNext();
    } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col h-full" style={{ animation: 'fadeIn 0.3s ease-out' }}>
      {/* Mobile brand */}
      <div className="md:hidden flex items-center gap-2 px-6 pt-4">
        <LogoText size={35} />
      </div>

      <div className="flex-1 flex flex-col justify-center px-6 md:px-8 py-6 mx-auto w-full overflow-y-auto scroll">
        <div className="flex justify-start items-end gap-2.5 mb-5">
          <LogoText size={35} />
        </div>
        <Card className="relative">
          <CardContent>
        <div className="space-y-5">
          {/* API Protocol */}
          <div className="space-y-2">
            <SectionLabel icon={<Plug className="size-3" />}>API Protocol</SectionLabel>
            <ApiStylePicker value={apiStyle} onChange={setApiStyle} />
          </div>

          {/* Endpoint preview */}
          <EndpointPreview apiStyle={apiStyle} baseUrl={baseUrl} />

          {/* Connection — stacked FormFields under a SectionLabel, matching
              the Settings → Provider detail layout (not a 2-col grid). */}
          <section className="space-y-3.5">
            <SectionLabel icon={<Server className="size-3" />}>Connection</SectionLabel>
            <FormField id="ob-name" label="Provider name">
              <Input className="h-8 text-[12.5px]" value={name}
                onChange={(e) => setName(e.target.value)} placeholder="OpenRouter, z.ai, LM Studio…" />
            </FormField>
            <FormField id="ob-baseUrl" label="Base URL">
              <Input className="font-mono text-[12px] h-8" value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)} placeholder={PROTOCOL[apiStyle].baseUrlPlaceholder} />
            </FormField>
            <FormField id="ob-key" label="API key">
              <Input type="password" className="font-mono text-[12px] h-8" value={apiKey}
                onChange={(e) => setApiKey(e.target.value)} placeholder={PROTOCOL[apiStyle].keyPlaceholder} />
              <p className="text-[10px] text-muted-foreground/50 mt-1 flex items-center gap-1">
                <ShieldCheck className="size-2.5 text-success" />
                Sent as <span className="font-mono">{PROTOCOL[apiStyle].authHeader}</span>. Stored in OS keychain.
              </p>
            </FormField>
          </section>

          {/* Models table */}
          <div className="space-y-2">
            <SectionLabel icon={<Brain className="size-3" />} count={rowsToModels().length}>Models</SectionLabel>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5">Alias</TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5">Model ID</TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5 w-20">Context</TableHead>
                      <TableHead className="h-7 text-[10px] uppercase tracking-wider text-muted-foreground/50 py-1.5 w-24">Price</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, i) => (
                      <TableRow key={i} className="border-border/60">
                        <TableCell className="py-1 pr-1">
                          <div className="flex items-center gap-1">
                            {row.reasoning && <Brain className="size-3 text-reasoning shrink-0" />}
                            <input className="w-full bg-transparent border-0 outline-none text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                              value={row.alias} onChange={(e) => updateRow(i, { alias: e.target.value })} placeholder="Alias" />
                          </div>
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          <input className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                            value={row.modelId} onChange={(e) => updateRow(i, { modelId: e.target.value })} placeholder="model-id" />
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          {row.catalogId ? (
                            <div className="flex items-center gap-1 px-1 py-0.5" title={`Catalog: ${row.catalogId}`}>
                              <span className="font-mono text-[11.5px] text-muted-foreground">{row.context || '—'}</span>
                              <span className="text-[8px] px-1 py-0 uppercase tracking-wide text-success/80 bg-success/10 rounded">cat</span>
                            </div>
                          ) : (
                            <input className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                              value={row.context} onChange={(e) => updateRow(i, { context: e.target.value })} placeholder="200000" />
                          )}
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          <span className="font-mono text-[10.5px] text-muted-foreground/60">
                            {row.priceLabel || '—'}
                          </span>
                        </TableCell>
                        <TableCell className="py-1">
                          <Button variant="ghost" size="icon" className="size-6 text-muted-foreground/45 hover:text-destructive"
                            onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}>
                            <Trash2 className="size-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="px-3 py-2 border-t border-border bg-secondary/20 flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm"
                  onClick={() => setRows((rs) => [...rs, { alias: '', modelId: '', context: '' }])}
                  className="text-[11px] h-7 text-muted-foreground hover:text-foreground">
                  <Plus className="size-3" /> Add row
                </Button>
                <FetchModelsButton
                  apiStyle={apiStyle} baseUrl={baseUrl} apiKey={apiKey}
                  onFetched={(models) => setRows((prev) => appendFetchedModels(prev, models))}
                  existingModelIds={rows.map((r) => r.modelId)}
                />
              </div>
            </div>
          </div>
            </div>
          </CardContent>

          {/* Loading overlay — covers the entire form card during testing
              and saving. Semi-transparent backdrop + centered spinner so the
              user sees the form is locked and something is happening. */}
          {(testing || saving) && (
            <div className="absolute inset-0 z-10 rounded-[inherit] bg-background/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
              <Loader2 className="size-7 animate-spin text-primary" />
              <div className="text-[13px] font-medium text-foreground">
                {testing ? 'Testing connection…' : 'Saving provider…'}
              </div>
              {testing && (
                <div className="text-[11px] text-muted-foreground max-w-[240px] text-center">
                  Sending a test message to verify your API key and model.
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Test result — shown below the card (not inside) so the form
            stays clean. Error in red, success briefly in green. */}
        {testResult?.ok && !saving && (
          <div className="flex items-center gap-2 text-[12px] text-emerald-400 py-1 px-1">
            <CheckCircle2 className="size-3.5" /> Connection verified.
          </div>
        )}
        {testResult && !testResult.ok && (
          <div className="flex items-start gap-2 text-[12px] text-destructive py-1 px-1">
            <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
            <span className="flex-1">{testResult.error}</span>
          </div>
        )}

        <OnboardingFooter
          onNext={handleSave}
          nextLabel={testing ? 'Testing…' : 'Continue'}
          saving={saving}
          disabled={!formValid || testing}
        />
      </div>

    </div>
  );
}

// =============================================================
// STEP 2: Workspace
// =============================================================

function WorkspaceStep({
  onBack, onSkip, onComplete, qc,
}: {
  onBack: () => void;
  onSkip: () => void;
  onComplete: (wsId: string) => void;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [source, setSource] = useState<'local' | 'remote'>('local');
  const [localPath, setLocalPath] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [cloneDir, setCloneDir] = useState('');
  const [enableRag, setEnableRag] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  // Mirrors AddWorkspaceDialog: optional install (setup) + running (run)
  // scripts, saved onto the new workspace; init-git offer when the local
  // folder isn't a repo yet. Both gated behind canOpen in the form.
  const [addScript, setAddScript] = useState(false);
  const [installCmd, setInstallCmd] = useState('');
  const [runCmd, setRunCmd] = useState('');
  const [initGit, setInitGit] = useState(true);

  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [gitChecking, setGitChecking] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  // Model download state — when RAG is enabled, the user downloads the
  // 22 MB model inline before they can open the workspace.
  type DlState = 'idle' | 'downloading' | 'done' | 'error';
  const [dlState, setDlState] = useState<DlState>('idle');
  const [dlError, setDlError] = useState<string | null>(null);
  const downloadProgress = useRagDownloadProgress();

  // Workspace ID once created — used to subscribe to indexing progress.
  const [createdWsId, setCreatedWsId] = useState<string | null>(null);
  const initProgress = useRagInitProgress(createdWsId);

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

  // Probe whether the model is already on disk (e.g. from a prior workspace).
  // Uses the lightweight ragModelExists check, NOT downloadRagModel (which
  // would trigger an actual 22 MB download if the model is missing).
  useEffect(() => {
    api.ragModelExists().then((exists) => {
      if (exists) setDlState('done');
    }).catch(() => { /* will probe again when user clicks */ });
  }, []);

  const handleDownloadModel = async () => {
    setDlState('downloading');
    setDlError(null);
    try {
      const r = await api.downloadRagModel();
      if (r.ok) {
        // Verify the model actually landed on disk — don't trust just the
        // IPC result, match Settings' filesystem-backed check.
        const exists = await api.ragModelExists();
        if (exists) {
          setDlState('done');
        } else {
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
    if (source !== 'local' || !localPath) { setGitInfo(null); setGitError(null); return; }
    setGitChecking(true); setGitError(null);
    const timer = setTimeout(async () => {
      try {
        const info = await api.detectGitRepo(localPath);
        setGitInfo(info);
        if (!info) setGitError('Not a git repository');
      } catch { setGitInfo(null); setGitError('Cannot read directory'); }
      finally { setGitChecking(false); }
    }, 400);
    return () => clearTimeout(timer);
  }, [localPath, source]);

  const handleBrowse = (target: 'local' | 'clone') => {
    api.pickDirectory().then(p => { if (!p) return; if (target === 'local') setLocalPath(p); else setCloneDir(p); });
  };

  const handleOpen = async () => {
    setPhase('creating'); setError(null);
    let path = '';
    if (source === 'local') path = localPath;
    else {
      if (!remoteUrl || !cloneDir) { setPhase('form'); return; }
      const name = remoteUrl.replace(/\.git$/, '').replace(/^.*\//, '');
      if (!name) { setPhase('error'); setError('Bad URL'); return; }
      path = `${cloneDir}/${name}`;
    }
    if (!path) { setPhase('form'); return; }

    // Assemble scripts (install → setup, running → run) — only non-empty.
    const scripts: WorkspaceScript[] = [];
    if (installCmd.trim()) scripts.push({ kind: 'setup', command: installCmd.trim() });
    if (runCmd.trim()) scripts.push({ kind: 'run', command: runCmd.trim() });
    // init-git applies only to the local-open flow.
    const shouldInitGit = source === 'local' && initGit;

    const input: Parameters<typeof api.addWorkspace>[0] = source === 'remote'
      ? { path, repository: remoteUrl, ...(scripts.length ? { scripts } : {}) }
      : { path, ...(scripts.length ? { scripts } : {}), ...(shouldInitGit ? { initGit: true } : {}) };

    let ws: Workspace | undefined;
    try {
      ws = await api.addWorkspace(input);
      // Instantly place the returned workspace into the list cache so it
      // appears in the sidebar the moment creation resolves.
      const created = ws;
      qc.setQueryData<Workspace[]>(qk.workspaces, (old) =>
        old ? [...old, created] : [created],
      );
      qc.invalidateQueries({ queryKey: qk.workspaces });
    } catch (e: unknown) {
      setPhase('error');
      setError(e instanceof Error ? e.message : 'Failed');
      toast.error('Workspace creation failed', {
        description: e instanceof Error ? e.message : undefined,
      });
      return;
    }
    if (!ws?.id) return;
    setCreatedWsId(ws.id);

    if (enableRag) {
      // The model is already downloaded from the inline Download button on
      // the form (dlState === 'done'). enableRagWorkspace is a no-op for the
      // download step — it just adds the workspace to the enabled list.
      try {
        await api.enableRagWorkspace(ws.id);
        qc.invalidateQueries({ queryKey: qk.ragStatus(ws.id) });
        setPhase('indexing');
        await api.initRagWorkspace(ws.id);
        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1000));
          const s = await api.ragStatus(ws.id);
          if ('error' in s) break;
          if ((s as { initState?: string }).initState === 'done' || (s as { initState?: string }).initState === 'failed') break;
        }
        qc.invalidateQueries({ queryKey: qk.ragStatus(ws.id) });
      } catch (e) {
        // Non-blocking: workspace is created, RAG just didn't finish.
        toast.error('RAG setup incomplete', {
          description: e instanceof Error ? e.message : 'You can enable RAG later in Settings.',
        });
      }
    }

    setPhase('done');
    toast.success('Workspace added');
    setTimeout(() => onComplete(ws.id), 600);
  };

  const canOpen = (source === 'local' ? !!localPath : !!cloneDir && !!remoteUrl)
    && (!enableRag || dlState === 'done');

  // Loading states
  if (phase !== 'form') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-8" style={{ animation: 'fadeIn 0.3s ease-out' }}>
        {phase === 'done' ? (
          <div className="size-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <Check className="size-7 text-emerald-400" />
          </div>
        ) : phase === 'error' ? (
          <div className="size-14 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center">
            <AlertCircle className="size-7 text-destructive" />
          </div>
        ) : (
          <div className="size-14 rounded-full border border-border flex items-center justify-center"
            style={{ background: 'rgba(217,119,87,0.05)' }}>
            <Loader2 className="size-7 animate-spin" style={{ color: '#d97757' }} />
          </div>
        )}
        <div className="text-center mt-5">
          <div className="text-[14px] font-medium">
            {phase === 'creating' && 'Creating workspace…'}
            {phase === 'indexing' && (initProgress ? phaseLabelLocal(initProgress.phase) : 'Indexing codebase…')}
            {phase === 'done' && 'All set! Opening…'}
            {phase === 'error' && 'Something went wrong'}
          </div>

          {/* Detailed indexing progress */}
          {phase === 'indexing' && (
            <div className="mt-4 w-[340px] space-y-2.5">
              {(() => {
                const ip = initProgress;
                const failed = ip?.phase === 'failed';
                const determinate = ip?.phase === 'embedding' && ip.chunksTotal > 0;
                const pct = determinate && ip
                  ? Math.min(100, Math.round((ip.chunksEmbedded / ip.chunksTotal) * 100))
                  : 0;

                return (
                  <>
                    {/* Progress bar */}
                    {ip && !failed ? (
                      determinate ? (
                        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300 bg-emerald-400"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : (
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div className="rag-index-bar-indeterminate h-full rounded-full bg-emerald-400/80" />
                        </div>
                      )
                    ) : !ip ? (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                        <div className="rag-index-bar-indeterminate h-full rounded-full bg-emerald-400/80" />
                      </div>
                    ) : null}

                    {/* Stats line */}
                    {ip && !failed && (
                      <div className="text-[11px] text-muted-foreground/60 font-mono flex items-center justify-center gap-3 tabular-nums">
                        {ip.phase === 'walking' && <span>{ip.filesSeen} files</span>}
                        {ip.phase === 'chunking' && (<><span>{ip.chunksTotal} chunks</span><span>{ip.filesSeen} files</span></>)}
                        {ip.phase === 'embedding' && ip.chunksTotal > 0 && (
                          <>
                            <span>{ip.chunksEmbedded} / {ip.chunksTotal} chunks</span>
                            <span className="text-emerald-400/60">{pct}%</span>
                          </>
                        )}
                        {ip.phase === 'embedding' && ip.chunksTotal === 0 && <span>Starting…</span>}
                      </div>
                    )}
                    {!ip && (
                      <div className="text-[11px] text-muted-foreground/40">
                        Starting indexer…
                      </div>
                    )}

                    {/* Current file */}
                    {ip && !failed && ip.currentFile && (
                      <div className="text-[10px] text-muted-foreground/40 font-mono truncate text-center max-w-[320px] mx-auto" title={ip.currentFile}>
                        {ip.currentFile}
                      </div>
                    )}

                    {/* Error */}
                    {failed && ip?.error && (
                      <div className="text-[11px] text-destructive/70 font-mono text-left bg-destructive/5 rounded-md p-2 break-words">
                        {ip.error}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {phase === 'error' && error && (
            <div className="text-[11px] text-destructive/60 mt-1.5 max-w-[300px] font-mono">{error}</div>
          )}
        </div>
        {phase === 'error' && (
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => { setPhase('form'); setError(null); }}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" style={{ animation: 'fadeIn 0.3s ease-out' }}>
      <div className="flex-1 flex flex-col justify-center px-8 md:px-12 py-8 w-full overflow-y-auto scroll">
        <div className="flex justify-start items-end gap-2.5 mb-5">
          <LogoText size={20} />
        </div>
      <Card>
        <CardContent>
        <div className="space-y-5">
          {/* Source */}
          <Field label="Source">
            <div className="flex gap-1 bg-secondary/60 rounded-lg p-[3px]">
              <SourceTab active={source === 'local'} onClick={() => setSource('local')}
                icon={<HardDrive className="size-3.5" />} label="Local folder" />
              <SourceTab active={source === 'remote'} onClick={() => setSource('remote')}
                icon={<Globe className="size-3.5" />} label="Clone from URL" />
            </div>
          </Field>

          {/* Local */}
          {source === 'local' && (
            <Field label="Repository path">
              <div className="flex gap-2 mb-2">
                <Input className="font-mono text-[12px] flex-1 h-[36px] bg-secondary/60 border-border/60" value={localPath}
                  onChange={e => setLocalPath(e.target.value)} placeholder="/path/to/repo" />
                <Button variant="secondary" size="sm" className="h-[36px] gap-1.5" onClick={() => handleBrowse('local')}>
                  <Folder className="size-3.5" /> Browse
                </Button>
              </div>
              {!localPath && <Hint icon={<Folder className="size-3.5" />}>Browse for a folder with a .git directory.</Hint>}
              {localPath && gitChecking && <Hint loading><Loader2 className="size-3.5 animate-spin" /> Checking git…</Hint>}
              {localPath && !gitChecking && gitInfo && (
                <div className="rounded-lg px-3 py-2 flex items-center gap-2 text-[11px] border flex-wrap"
                  style={{ background: 'rgba(52,211,153,0.05)', borderColor: 'rgba(52,211,153,0.15)', color: 'var(--success)' }}>
                  <CheckCircle2 className="size-3.5" /> Git detected
                  <span className="opacity-40">·</span>
                  <code className="font-mono text-[10px] opacity-70">{gitInfo.branch} @ {gitInfo.headCommit}</code>
                </div>
              )}
              {localPath && !gitChecking && gitError && (
                <div className="rounded-[10px] p-3.5 border border-warning bg-warning/10 flex items-start gap-3">
                  <div className="size-8 rounded-lg bg-warning/20 flex items-center justify-center shrink-0 text-warning">
                    <TriangleAlert className="size-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-semibold">{gitError}</div>
                    <div className="text-[11px] text-muted-foreground/60 mt-0.5 leading-relaxed">
                      Initialize git repo on this folder.
                    </div>
                  </div>
                  <Switch checked={initGit} onCheckedChange={setInitGit} className="mt-1.5" />
                </div>
              )}
            </Field>
          )}

          {/* Remote */}
          {source === 'remote' && (
            <>
              <Field label="Git URL">
                <Input className="font-mono text-[12px] h-[36px] bg-secondary/60 border-border/60" value={remoteUrl}
                  onChange={e => setRemoteUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" />
              </Field>
              <Field label="Clone destination">
                <div className="flex gap-2">
                  <Input className="font-mono text-[12px] flex-1 h-[36px] bg-secondary/60 border-border/60" value={cloneDir}
                    onChange={e => setCloneDir(e.target.value)} placeholder="/parent/directory" />
                  <Button variant="secondary" size="sm" className="h-[36px] gap-1.5" onClick={() => handleBrowse('clone')}>
                    <Folder className="size-3.5" /> Browse
                  </Button>
                </div>
              </Field>
            </>
          )}

          {/* Script + RAG cards appear only once a project folder is in place. */}
          {canOpen && (
            <>
              {/* Add script toggle */}
              <div className="rounded-xl p-4 border border-border bg-card flex items-start gap-3">
                <div className="size-8 rounded-lg bg-secondary flex items-center justify-center shrink-0 text-muted-foreground">
                  <Terminal className="size-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-semibold">Add script</div>
                  <div className="text-[11px] text-muted-foreground/50 mt-0.5 leading-relaxed">
                    Bind install & run commands to this workspace.
                  </div>
                  {addScript && (
                    <div className="grid grid-cols-2 gap-2 mt-3">
                      <div>
                        <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-1.5">Install</label>
                        <Input
                          className="font-mono text-[12px] h-[34px]"
                          value={installCmd}
                          onChange={(e) => setInstallCmd(e.target.value)}
                          placeholder="npm install"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50 block mb-1.5">Running</label>
                        <Input
                          className="font-mono text-[12px] h-[34px]"
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

              {/* RAG */}
              <div className="rounded-xl p-4 border"
                style={{
                  background: enableRag ? 'rgba(52,211,153,0.06)' : 'rgba(52,211,153,0.03)',
                  borderColor: enableRag ? 'rgba(52,211,153,0.25)' : 'rgba(52,211,153,0.12)',
                }}>
                <div className="flex items-start gap-3">
                  <div className="size-8 rounded-lg flex items-center justify-center shrink-0 text-[15px]"
                    style={{ background: 'rgba(52,211,153,0.08)', color: '#34d399' }}>◈</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-semibold">Enable RAG</div>
                    <div className="text-[11px] text-muted-foreground/50 mt-0.5 leading-relaxed">
                      Indexes your codebase locally for semantic search.
                    </div>
                  </div>
                  <Switch checked={enableRag} onCheckedChange={setEnableRag} className="mt-1" />
                </div>
                {enableRag && (
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(52,211,153,0.12)' }}>
                    <div className="flex items-start gap-2">
                      <Download className="size-3.5 text-emerald-400/70 mt-0.5 shrink-0" />
                      <div className="text-[11px] text-muted-foreground/60 leading-relaxed">
                        A <span className="font-medium text-muted-foreground/80">22 MB</span> embedding model
                        (all-MiniLM-L6-v2) downloads from{' '}
                        <span className="font-mono text-muted-foreground/70">huggingface.co</span>{' '}
                        and runs entirely offline after download.
                      </div>
                    </div>

                    {/* Download button / progress / done */}
                    <div className="mt-2.5 ml-[22px]">
                      {dlState === 'idle' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-[28px] text-[11px] gap-1.5"
                          onClick={handleDownloadModel}
                        >
                          <Download className="size-3" />
                          Download model (22 MB)
                        </Button>
                      )}
                      {dlState === 'downloading' && (
                        <div className="space-y-1.5 w-full max-w-[260px]">
                          <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{
                                width: downloadProgress && downloadProgress.total > 0
                                  ? `${Math.min(100, (downloadProgress.received / downloadProgress.total) * 100)}%`
                                  : '8%',
                                background: '#34d399',
                              }}
                            />
                          </div>
                          <div className="text-[10px] text-muted-foreground/50 font-mono flex items-center gap-1.5">
                            <Loader2 className="size-2.5 animate-spin" />
                            {downloadProgress && downloadProgress.total > 0
                              ? `${(downloadProgress.received / 1048576).toFixed(1)} / ${(downloadProgress.total / 1048576).toFixed(1)} MB`
                              : 'Connecting to huggingface.co…'}
                          </div>
                        </div>
                      )}
                      {dlState === 'done' && (
                        <div className="flex items-center gap-1.5 text-[11px] text-emerald-400/80">
                          <CheckCircle2 className="size-3.5" />
                          Model ready
                          <span className="text-muted-foreground/30 font-mono ml-1">
                            all-MiniLM-L6-v2 · 384-dim
                          </span>
                        </div>
                      )}
                      {dlState === 'error' && (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5 text-[11px] text-destructive/70">
                            <AlertCircle className="size-3.5" />
                            {dlError ?? 'Download failed'}
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-[24px] text-[10px] gap-1.5"
                            onClick={handleDownloadModel}
                          >
                            <Download className="size-2.5" />
                            Retry
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

          </CardContent>
        </Card>
        <OnboardingFooter
          onBack={onBack} onSkip={onSkip}
          onNext={handleOpen} nextLabel="Open Workspace" saving={false}
          disabled={!canOpen}
        />
      </div>



    </div>
  );
}

// =============================================================
// Shared components
// =============================================================

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/40 block mb-2">{label}</label>
      {children}
    </div>
  );
}

function Hint({ children, icon, loading, warn }: { children: React.ReactNode; icon?: React.ReactNode; loading?: boolean; warn?: boolean }) {
  return (
    <div className={cn(
      'rounded-lg px-3 py-2 flex items-center gap-2 text-[11px] border',
      warn
        ? 'text-warning border-warning/15 bg-warning/[0.04]'
        : loading
          ? 'text-muted-foreground/60 border-border bg-secondary/40'
          : 'text-muted-foreground/50 border-border bg-secondary/40',
    )}>
      {icon}
      {children}
    </div>
  );
}

function OnboardingFooter({
  onBack, onSkip, onNext, nextLabel, saving, disabled,
}: {
  onBack?: () => void; onSkip?: () => void; onNext: () => void;
  nextLabel: string; saving: boolean; disabled?: boolean;
}) {
  return (
    <div className="py-4 flex items-center justify-between">
      <div>
        {onBack && (
          <Button variant="ghost" size="sm" className="text-muted-foreground/60 hover:text-foreground" onClick={onBack}>
            <ArrowLeft className="size-3.5" /> Back
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {onSkip && (
          <Button variant="ghost" size="sm" className="text-muted-foreground/60 hover:text-foreground" onClick={onSkip}>Skip</Button>
        )}
        <Button variant="default" size="sm" disabled={saving || disabled} onClick={onNext} className="gap-1.5">
          {saving ? <><Loader2 className="size-3.5 animate-spin" /> Saving…</> : <>{nextLabel} <ArrowRight className="size-3.5" /></>}
        </Button>
      </div>
    </div>
  );
}

function SourceTab({
  active, onClick, icon, label,
}: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button onClick={onClick}
      className={cn(
        'flex-1 py-1.5 px-3 rounded-[6px] text-[12px] font-medium text-center transition-all flex items-center justify-center gap-1.5',
        active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground/60 hover:text-foreground/80',
      )}>
      {icon}
      {label}
    </button>
  );
}
