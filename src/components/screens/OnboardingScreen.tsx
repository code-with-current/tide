import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import tideLogoPng from '@/assets/logo.png';
import tideLogoSvg from '@/assets/logo.svg';
import {
  ArrowLeft, ArrowRight, ShieldCheck, Loader2,
  Folder, CheckCircle2, HardDrive, Globe,
  Check, X, AlertCircle, Plus, Trash2, Plug, Brain,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useUi } from '@/lib/stores/ui';
import { qk, useAddProvider } from '@/lib/queries';
import { supportsThinking } from '@/lib/model-capabilities';
import { cn } from '@/lib/utils';
import * as api from '@/lib/api/client';
import type { GitRepoInfo } from '@/lib/api/client';
import type { ApiStyle, Model } from '@/types';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  PROTOCOL, ApiStylePicker, EndpointPreview, FetchModelsButton,
  SectionLabel, FormField, appendFetchedModels,
  type Row,
} from './settings/ProvidersSection';
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

  return (
    <div className="flex-1 flex overflow-hidden flex-col"
      style={{ background: 'linear-gradient(165deg, #0d0f13 0%, #08090c 100%)' }}

    >
      <div
        className="absolute inset-0 opacity-[0.02] pointer-events-none z-0"
        style={{
          backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
        }}
      />
      {/* Drag region — top strip only, so the rest of the onboarding screen
          (inputs, buttons) is interactive. Matches the window top bar height
          (h-10 = 40px). */}
      <div className="drag-region h-10 flex-shrink-0 bg-transparent" />
      {/* Content row — panels sit side-by-side below the drag strip */}
      <div className="flex-1 flex overflow-hidden relative">
      {/* Grain texture */}

      {/* ─── LEFT: Brutal brand panel ─── */}
      <div
        className="hidden md:flex w-[38%] min-w-[380px] flex-col relative overflow-hidden"
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
            onSkip={() => setScreen('main')}
            onComplete={(wsId) => { setActive(wsId); setScreen('main'); }}
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
        <img src={tideLogoSvg} alt="" className="size-7" />
        <span className="text-[14px] font-semibold">Tide</span>
      </div>

      <div className="flex-1 flex flex-col justify-center px-6 md:px-8 py-6 mx-auto w-full overflow-y-auto scroll">
        <div className="flex justify-start items-end gap-2.5 mb-5">
          <img src={tideLogoSvg} alt="" className="size-8" />
          <span className="text-[15px] font-semibold tracking-tight">Tide</span>
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

          {/* Connection fields */}
          <div className="grid grid-cols-2 gap-4">
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
          </div>

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
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, i) => (
                      <TableRow key={i} className="border-border/60">
                        <TableCell className="py-1 pr-1">
                          <div className="flex items-center gap-1">
                            {supportsThinking(row.modelId) && <Brain className="size-3 text-reasoning shrink-0" />}
                            <input className="w-full bg-transparent border-0 outline-none text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                              value={row.alias} onChange={(e) => updateRow(i, { alias: e.target.value })} placeholder="Alias" />
                          </div>
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          <input className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                            value={row.modelId} onChange={(e) => updateRow(i, { modelId: e.target.value })} placeholder="model-id" />
                        </TableCell>
                        <TableCell className="py-1 pr-1">
                          <input className="w-full bg-transparent border-0 outline-none font-mono text-[11.5px] focus:bg-secondary/40 rounded px-1 py-0.5"
                            value={row.context} onChange={(e) => updateRow(i, { context: e.target.value })} placeholder="200000" />
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

  const [gitInfo, setGitInfo] = useState<GitRepoInfo | null>(null);
  const [gitChecking, setGitChecking] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

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

    let ws;
    try {
      ws = await api.addWorkspace(source === 'remote' ? { path, repository: remoteUrl } : { path });
      qc.invalidateQueries({ queryKey: qk.workspaces });
    } catch (e: unknown) {
      setPhase('error');
      setError(e instanceof Error ? e.message : 'Failed');
      return;
    }
    if (!ws?.id) return;

    if (enableRag) {
      setPhase('indexing');
      try {
        await api.enableRagWorkspace(ws.id);
        qc.invalidateQueries({ queryKey: qk.ragStatus(ws.id) });
        await api.initRagWorkspace(ws.id);
        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1000));
          const s = await api.ragStatus(ws.id);
          if ('error' in s) break;
          if ((s as { initState?: string }).initState === 'done' || (s as { initState?: string }).initState === 'failed') break;
        }
        qc.invalidateQueries({ queryKey: qk.ragStatus(ws.id) });
      } catch { /* non-blocking */ }
    }

    setPhase('done');
    setTimeout(() => onComplete(ws.id), 600);
  };

  const canOpen = source === 'local' ? !!localPath : !!cloneDir && !!remoteUrl;

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
            {phase === 'indexing' && 'Indexing codebase…'}
            {phase === 'done' && 'All set! Opening…'}
            {phase === 'error' && 'Something went wrong'}
          </div>
          {phase === 'indexing' && (
            <div className="text-[12px] text-muted-foreground/50 mt-1.5 max-w-[300px] leading-relaxed">
              Walking files, chunking at symbol boundaries, embedding with the local ONNX model.
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
          <img src={tideLogoSvg} alt="" className="size-8" />
          <span className="text-[15px] font-semibold tracking-tight">Tide</span>
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
                <Hint warn icon={<X className="size-3.5" />}>{gitError} — Tide works best with git.</Hint>
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

          {/* RAG */}
          <div className="rounded-xl p-4 border flex items-start gap-3"
            style={{ background: 'rgba(52,211,153,0.03)', borderColor: 'rgba(52,211,153,0.12)' }}>
            <div className="size-8 rounded-lg flex items-center justify-center shrink-0 text-[15px]"
              style={{ background: 'rgba(52,211,153,0.08)', color: '#34d399' }}>◈</div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold">Enable RAG</div>
              <div className="text-[11px] text-muted-foreground/50 mt-0.5 leading-relaxed">Indexes your codebase locally for semantic search.</div>
              <div className="text-[10px] text-muted-foreground/30 mt-1 font-mono">all-MiniLM-L6-v2 · 384-dim · bundled</div>
            </div>
            <Switch checked={enableRag} onCheckedChange={setEnableRag} className="mt-1" />
          </div>
        </div>

          </CardContent>
        </Card>
        <OnboardingFooter
          onBack={onBack} onSkip={onSkip}
          onNext={handleOpen} nextLabel="Open workspace" saving={false}
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
