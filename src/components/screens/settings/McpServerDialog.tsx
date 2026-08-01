import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, AlertCircle, Plug, Server, Globe, FolderCode, Terminal, Link2, KeyRound, Code2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { SectionLabel, FormField } from './ProvidersSection';

/**
 * Add / edit dialog for an MCP server. Two modes:
 *
 *  - Form: structured fields (name, scope, transport, command/args/env or url,
 *    auth). Friendly for first-time setup.
 *  - JSON: raw textarea editing the server config object (the value that would
 *    sit under the server's name in mcp.json). Live-validated, debounced.
 *
 * The two modes are bidirectionally synced through a single source of truth
 * (the form fields). Switching to JSON serializes the form; switching back
 * parses the JSON (and refuses to leave JSON mode while invalid).
 *
 * In edit mode the dialog opens straight to JSON with the existing config
 * pre-filled — that's the safest view for editing an existing entry without
 * losing fields the form doesn't surface.
 */

/** A server config (matches the value side of the mcp.json map). */
export interface McpConfig {
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  auth?: 'oauth';
}

/** Where the server is stored: 'user' (global ~/.tide/mcp.json) or 'project'. */
export type McpScope = 'user' | 'project';

export interface McpServerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the final scope/name/config when the user saves. */
  onSave: (scope: McpScope, name: string, config: McpConfig) => void;
  /** Present in edit mode. */
  initialName?: string;
  initialConfig?: McpConfig;
  initialScope?: McpScope;
  /** Active workspace root — shown in the footer when scope is Workspace. */
  workspaceRoot?: string;
}

type Mode = 'form' | 'json';
type Transport = 'stdio' | 'sse' | 'http';
type Auth = 'none' | 'oauth';

const EMPTY_FORM: FormState = {
  name: '',
  scope: 'project',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  auth: 'none',
};

interface FormState {
  name: string;
  scope: McpScope;
  transport: Transport;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  auth: Auth;
}

export function McpServerDialog({
  open,
  onClose,
  onSave,
  initialName,
  initialConfig,
  initialScope,
  workspaceRoot,
}: McpServerDialogProps) {
  const isEdit = Boolean(initialName && initialConfig);

  const [mode, setMode] = useState<Mode>(isEdit ? 'json' : 'form');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [jsonText, setJsonText] = useState<string>('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonTouched, setJsonTouched] = useState(false);

  // Debounce timer handle for JSON validation.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // (Re)initialize whenever the dialog opens or the target server changes.
  useEffect(() => {
    if (!open) return;
    if (isEdit && initialConfig && initialName) {
      const f = configToForm(initialConfig, initialScope ?? 'project', initialName);
      setForm(f);
      setJsonText(configToJson(f));
      setMode('json');
    } else {
      setForm({ ...EMPTY_FORM, scope: initialScope ?? 'project' });
      setJsonText(configToJson({ ...EMPTY_FORM, scope: initialScope ?? 'project' }));
      setMode('form');
    }
    setJsonError(null);
    setJsonTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialName, initialConfig, initialScope]);

  // Cancel pending debounce on unmount / close.
  useEffect(() => {
    if (!open && debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, [open]);

  /** Switch form → json: serialize the current form. */
  const toJson = useCallback(() => {
    setJsonText(configToJson(form));
    setJsonError(null);
    setJsonTouched(false);
    setMode('json');
  }, [form]);

  /**
   * Switch json → form: parse JSON into form fields. If the JSON is invalid
   * (or doesn't look like a server config), we refuse to leave JSON mode so
   * the user doesn't silently lose data.
   */
  const toForm = useCallback(() => {
    const parsed = tryParseConfig(jsonText);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      setJsonTouched(true);
      return; // stay in JSON mode
    }
    // Auto-fill the Name field if the JSON had a server-name wrapper and the
    // name field is empty or still at default.
    const nameToUse = parsed.extractedName && !form.name.trim()
      ? parsed.extractedName
      : form.name;
    setForm(configToForm(parsed.config, form.scope, nameToUse));
    setJsonError(null);
    setMode('form');
  }, [jsonText, form.scope, form.name]);

  /** Debounced live validation while typing in JSON mode. */
  const onJsonChange = useCallback((value: string) => {
    setJsonText(value);
    setJsonTouched(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const parsed = tryParseConfig(value);
      if (parsed.ok && parsed.extractedName && !form.name.trim()) {
        // Auto-fill the name field when a wrapped format is detected
        setForm((f) => ({ ...f, name: parsed.extractedName! }));
      }
      setJsonError(parsed.ok ? null : parsed.error);
    }, 250);
  }, []);

  // Compute the effective config + name at save time, from whichever mode
  // the user is currently in.
  const saveState = useMemo<{ name: string; config: McpConfig } | null>(() => {
    const trimmedName = form.name.trim();
    if (!trimmedName) return null;
    if (mode === 'json') {
      const parsed = tryParseConfig(jsonText);
      if (!parsed.ok) return null;
      // Use extracted name from wrapper if the name field matches it
      const name = parsed.extractedName && trimmedName === form.name.trim()
        ? (form.name.trim() || parsed.extractedName)
        : trimmedName;
      return { name, config: parsed.config };
    }
    const cfg = formToConfig(form);
    if (!cfg) return null;
    return { name: trimmedName, config: cfg };
  }, [form, mode, jsonText]);

  const handleSave = () => {
    if (!saveState) return;
    onSave(form.scope, saveState.name, saveState.config);
  };

  if (!open) return null;

  const saveLabel = isEdit ? 'Save' : 'Add';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-5 py-4 flex-row items-center gap-3.5 border-b border-border space-y-0">
          <div
            className="size-9 rounded-[10px] flex items-center justify-center shrink-0 border"
            style={{ background: 'rgba(217,119,87,0.1)', borderColor: 'rgba(217,119,87,0.2)' }}
          >
            <Plug className="size-4 text-primary" />
          </div>
          <div className="flex-1">
            <DialogTitle className="text-[15px] font-semibold text-left tracking-tight">
              {isEdit ? `Edit ${initialName}` : 'Add MCP server'}
            </DialogTitle>
            <DialogDescription className="text-[11px] text-muted-foreground/60 mt-0.5 text-left">
              {isEdit ? 'Update the server configuration.' : 'Connect a stdio command or remote endpoint.'}
            </DialogDescription>
          </div>
        </DialogHeader>

        {/* Scope selector — matches the provider ApiStylePicker rhythm:
            two side-by-side cards. */}
        <div className="px-5 pt-4">
          <div className="mb-2">
            <SectionLabel icon={<Globe className="size-3" />}>Scope</SectionLabel>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ScopeCard
              active={form.scope === 'user'}
              onClick={() => setForm((f) => ({ ...f, scope: 'user' }))}
              icon={<Globe className="size-3.5" />}
              label="Global"
              hint="~/.tide/mcp.json"
            />
            <ScopeCard
              active={form.scope === 'project'}
              onClick={() => setForm((f) => ({ ...f, scope: 'project' }))}
              icon={<FolderCode className="size-3.5" />}
              label="Workspace"
              hint={workspaceRoot ? `${workspaceRoot}/.mcp.json` : '.mcp.json'}
            />
          </div>
        </div>

        {/* Mode toggle — segmented control like the provider form's tabs. */}
        <div className="px-5 pt-3 pb-1">
          <div className="inline-flex rounded-md bg-secondary p-[3px] text-xs">
            <ModeButton active={mode === 'form'} onClick={() => (mode === 'json' ? toForm() : null)}>
              Form
            </ModeButton>
            <ModeButton active={mode === 'json'} onClick={() => (mode === 'form' ? toJson() : null)}>
              JSON
            </ModeButton>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-3 overflow-y-auto scroll max-h-[55vh]">
          {mode === 'form' ? (
            <FormBody form={form} setForm={setForm} isEdit={isEdit} />
          ) : (
            <JsonBody
              text={jsonText}
              onChange={onJsonChange}
              error={jsonTouched ? jsonError : null}
            />
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="px-5 py-3.5 flex-row items-center justify-end gap-2 border-t border-border bg-secondary/30">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="default" size="sm" onClick={handleSave} disabled={!saveState} className="gap-1.5">
            <Check className="size-3.5" />
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ScopeCard({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative flex items-center gap-2.5 p-3 rounded-xl text-left transition-all duration-150 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
        active
          ? 'bg-secondary shadow-sm'
          : 'border-border bg-card hover:border-primary/30 hover:bg-secondary/60'
      }`}
      style={active ? { borderColor: 'rgba(217,119,87,0.35)', boxShadow: 'inset 0 0 0 1px rgba(217,119,87,0.3)' } : undefined}
    >
      <span className={`size-7 rounded-lg flex items-center justify-center shrink-0 ${active ? 'text-primary' : 'text-muted-foreground bg-secondary'}`}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className={`text-[12.5px] font-semibold tracking-tight ${active ? 'text-foreground' : 'text-foreground/80'}`}>
          {label}
        </div>
        <div className="text-[10px] text-muted-foreground/55 font-mono mt-0.5 truncate">
          {hint}
        </div>
      </div>
      {active && (
        <span
          className="size-4 rounded-full flex items-center justify-center shrink-0"
          style={{ background: '#d97757' }}
        >
          <Check className="size-3 text-white" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 py-1.5 px-3 rounded-[5px] text-[12px] font-medium text-center transition-all ${
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'bg-transparent text-muted-foreground hover:text-foreground/80'
      }`}
    >
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Form body
// ──────────────────────────────────────────────────────────────────────────

function FormBody({
  form,
  setForm,
  isEdit,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  isEdit: boolean;
}) {
  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  return (
    <div className="space-y-5">
      {/* Identity */}
      <section className="space-y-3">
        <SectionLabel icon={<Server className="size-3" />}>Identity</SectionLabel>
        <FormField id="mcp-name" label="Name">
          <Input
            className="h-8 text-[12.5px]"
            value={form.name}
            disabled={isEdit}
            placeholder="e.g. filesystem"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </FormField>
      </section>

      {/* Transport — segmented control matching the provider ApiStylePicker
          rhythm (icon + label tabs in a bg-secondary pill). */}
      <section className="space-y-3">
        <SectionLabel icon={<Plug className="size-3" />}>Transport</SectionLabel>
        <div className="flex gap-1 bg-secondary rounded-md p-[3px]">
          <TransportTab active={form.transport === 'stdio'} onClick={() => patch({ transport: 'stdio' })} icon={<Terminal className="size-3.5" />} label="stdio" />
          <TransportTab active={form.transport === 'sse'} onClick={() => patch({ transport: 'sse' })} icon={<Link2 className="size-3.5" />} label="SSE" />
          <TransportTab active={form.transport === 'http'} onClick={() => patch({ transport: 'http' })} icon={<Globe className="size-3.5" />} label="HTTP" />
        </div>
      </section>

      {form.transport === 'stdio' ? (
        <section className="space-y-3">
          <SectionLabel icon={<Terminal className="size-3" />}>Command</SectionLabel>
          <FormField id="mcp-command" label="Command">
            <Input
              className="font-mono text-[12px] h-8"
              value={form.command}
              placeholder="e.g. npx"
              onChange={(e) => patch({ command: e.target.value })}
            />
          </FormField>
          <FormField id="mcp-args" label="Args">
            <Textarea
              className="font-mono text-[12px] min-h-[72px] resize-y"
              value={form.argsText}
              rows={3}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/Users/me'}
              onChange={(e) => patch({ argsText: e.target.value })}
            />
            <p className="text-[10px] text-muted-foreground/50 mt-1">One argument per line.</p>
          </FormField>
          <FormField id="mcp-env" label="Environment">
            <Textarea
              className="font-mono text-[12px] min-h-[72px] resize-y"
              value={form.envText}
              rows={3}
              placeholder={'API_KEY=...'}
              onChange={(e) => patch({ envText: e.target.value })}
            />
            <p className="text-[10px] text-muted-foreground/50 mt-1">KEY=value per line.</p>
          </FormField>
        </section>
      ) : (
        <section className="space-y-3">
          <SectionLabel icon={<Link2 className="size-3" />}>Endpoint</SectionLabel>
          <FormField id="mcp-url" label="URL">
            <Input
              className="font-mono text-[12px] h-8"
              value={form.url}
              placeholder={
                form.transport === 'sse'
                  ? 'https://example.com/sse'
                  : 'https://example.com/mcp'
              }
              onChange={(e) => patch({ url: e.target.value })}
            />
          </FormField>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground/60">Auth</Label>
            <div className="flex gap-1 bg-secondary rounded-md p-[3px]">
              <TransportTab active={form.auth === 'none'} onClick={() => patch({ auth: 'none' })} label="None" />
              <TransportTab active={form.auth === 'oauth'} onClick={() => patch({ auth: 'oauth' })} icon={<KeyRound className="size-3.5" />} label="OAuth" />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** Segmented-control tab used for Transport + Auth selectors — mirrors the
 *  Add Workspace dialog's SourceTab and the provider form's tab styling. */
function TransportTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 py-1.5 px-3 rounded-[5px] text-[12px] font-medium text-center transition-all flex items-center justify-center gap-1.5 ${
        active
          ? 'bg-card text-foreground shadow-sm'
          : 'bg-transparent text-muted-foreground hover:text-foreground/80'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// JSON body
// ──────────────────────────────────────────────────────────────────────────

function JsonBody({
  text,
  onChange,
  error,
}: {
  text: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  const lineCount = text.split('\n').length;
  const lineNumbers = Array.from({ length: Math.max(lineCount, 14) }, (_, i) => i + 1);

  function handleScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    const gutter = e.currentTarget.previousElementSibling as HTMLElement | null;
    if (gutter) gutter.scrollTop = e.currentTarget.scrollTop;
  }

  return (
    <div className="space-y-3">
      <SectionLabel icon={<Code2 className="size-3" />}>
        Server config
      </SectionLabel>
      {/* Editor with line numbers */}
      <div className="relative flex rounded-md border border-input overflow-hidden focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/40 transition-colors">
        {/* Line number gutter */}
        <div
          aria-hidden
          className="select-none overflow-hidden bg-muted/40 text-right shrink-0"
          style={{ width: '2.5rem' }}
        >
          <div className="font-mono text-xs leading-[1.25rem] py-2 pr-1.5 text-muted-foreground/40">
            {lineNumbers.map((n) => (
              <div key={n}>{n}</div>
            ))}
          </div>
        </div>
        {/* Textarea */}
        <textarea
          value={text}
          rows={14}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onScroll={handleScroll}
          className="flex-1 bg-transparent border-0 outline-none font-mono text-xs leading-[1.25rem] py-2 px-2.5 resize-y"
          placeholder={'{\n  "supabase": {\n    "type": "http",\n    "url": "https://mcp.supabase.com/mcp"\n  }\n}'}
        />
      </div>

      {/* Validation status */}
      {error ? (
        <div className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertCircle className="size-3 mt-0.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" /> Valid
        </div>
      )}

      {/* Examples */}
      <div className="text-[10px] text-muted-foreground/50 space-y-1">
        <p>Paste a server config — the name is auto-detected from the key.</p>
        <details className="cursor-pointer">
          <summary className="hover:text-muted-foreground/80 transition-colors">Examples</summary>
          <div className="mt-1.5 space-y-2">
            <div>
              <p className="text-muted-foreground/60 mb-0.5">stdio server:</p>
              <pre className="font-mono text-[9px] bg-muted/40 rounded p-1.5 overflow-x-auto">{`{
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    "env": {
      "API_KEY": "{{secret:my_api_key}}"
    }
  }
}`}</pre>
            </div>
            <div>
              <p className="text-muted-foreground/60 mb-0.5">HTTP server:</p>
              <pre className="font-mono text-[9px] bg-muted/40 rounded p-1.5 overflow-x-auto">{`{
  "supabase": {
    "type": "http",
    "url": "https://mcp.supabase.com/mcp?project_ref=xxx"
  }
}`}</pre>
            </div>
            <div>
              <p className="text-muted-foreground/60 mb-0.5">OAuth server:</p>
              <pre className="font-mono text-[9px] bg-muted/40 rounded p-1.5 overflow-x-auto">{`{
  "linear": {
    "type": "http",
    "url": "https://mcp.linear.app/sse",
    "auth": "oauth"
  }
}`}</pre>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Form ↔ config ↔ JSON conversions
// ──────────────────────────────────────────────────────────────────────────

/** Parse "KEY=value" lines into a Record, ignoring blanks / comments. */
function parseEnvLines(text: string): Record<string, string> | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return Object.keys(env).length ? env : undefined;
}

function parseArgLines(text: string): string[] | undefined {
  const args = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return args.length ? args : undefined;
}

function envToText(env?: Record<string, string>): string {
  if (!env) return '';
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
}

function argsToText(args?: string[]): string {
  return args?.join('\n') ?? '';
}

/** Build a FormState from an existing config (used in edit mode). */
function configToForm(config: McpConfig, scope: McpScope, name: string): FormState {
  return {
    name,
    scope,
    transport: config.type,
    command: config.command ?? '',
    argsText: argsToText(config.args),
    envText: envToText(config.env),
    url: config.url ?? '',
    auth: config.auth === 'oauth' ? 'oauth' : 'none',
  };
}

/** Build a config from a FormState. Returns null if required fields are missing. */
function formToConfig(form: FormState): McpConfig | null {
  if (form.transport === 'stdio') {
    if (!form.command.trim()) return null;
    const cfg: McpConfig = {
      type: 'stdio',
      command: form.command.trim(),
    };
    const args = parseArgLines(form.argsText);
    if (args) cfg.args = args;
    const env = parseEnvLines(form.envText);
    if (env) cfg.env = env;
    return cfg;
  }
  // remote (sse / http)
  if (!form.url.trim()) return null;
  const cfg: McpConfig = {
    type: form.transport,
    url: form.url.trim(),
  };
  if (form.auth === 'oauth') cfg.auth = 'oauth';
  return cfg;
}

/** Serialize the current form to pretty JSON (the server-config object body). */
function configToJson(form: FormState): string {
  const cfg = formToConfig(form) ?? ({ type: form.transport } as McpConfig);
  return JSON.stringify(cfg, null, 2);
}

/** Try to parse a JSON string as a server config.
 *  Handles two shapes:
 *    1. Bare config:  { "type": "http", "url": "..." }
 *    2. Wrapped:      { "server-name": { "type": "http", "url": "..." } }
 *  When wrapped, extracts the inner config AND returns the server name so
 *  the caller can auto-fill the Name field.
 */
function tryParseConfig(text: string):
  | { ok: true; config: McpConfig; extractedName?: string }
  | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Empty config.' };
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: 'Config must be a JSON object.' };
  }
  let o = obj as Record<string, unknown>;
  let extractedName: string | undefined;

  // Detect the wrapped format: { "server-name": { ...config } }
  // If the top-level object has no "type" but has exactly one key whose
  // value is an object with a "type", unwrap it.
  const keys = Object.keys(o);
  if (!('type' in o) && keys.length >= 1) {
    for (const k of keys) {
      const v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'type' in v) {
        o = v as Record<string, unknown>;
        extractedName = k;
        break;
      }
    }
  }

  const type = o.type;
  if (type !== 'stdio' && type !== 'sse' && type !== 'http') {
    return {
      ok: false,
      error: '"type" must be one of "stdio", "sse", or "http". Paste just the config object (not the server-name wrapper), e.g.:\n{ "type": "http", "url": "..." }',
    };
  }
  const config: McpConfig = { type };
  if (typeof o.command === 'string') config.command = o.command;
  if (Array.isArray(o.args) && o.args.every((a) => typeof a === 'string')) {
    config.args = o.args as string[];
  }
  if (o.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (Object.keys(env).length) config.env = env;
  }
  if (typeof o.url === 'string') config.url = o.url;
  if (o.auth === 'oauth') config.auth = 'oauth';
  return { ok: true, config, extractedName };
}
