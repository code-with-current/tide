import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, AlertCircle } from 'lucide-react';

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

  // Escape closes; backdrop click closes.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  const saveLabel = isEdit ? 'Save' : 'Add';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? `Edit ${initialName}` : 'Add MCP server'}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg rounded-xl bg-card border border-border shadow-xl flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">
            {isEdit ? `Edit ${initialName}` : 'Add MCP server'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-muted transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Scope selector — full-width card buttons */}
        <div className="px-5 pt-4">
          <div className="grid grid-cols-2 gap-2">
            <ScopeCard
              active={form.scope === 'user'}
              onClick={() => setForm((f) => ({ ...f, scope: 'user' }))}
              label="Global"
              hint="~/.tide/mcp.json"
            />
            <ScopeCard
              active={form.scope === 'project'}
              onClick={() => setForm((f) => ({ ...f, scope: 'project' }))}
              label="Workspace"
              hint={workspaceRoot ? `${workspaceRoot}/.mcp.json` : '.mcp.json'}
            />
          </div>
        </div>

        {/* Mode toggle */}
        <div className="px-5 pt-3">
          <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
            <ModeButton active={mode === 'form'} onClick={() => (mode === 'json' ? toForm() : null)}>
              Form
            </ModeButton>
            <ModeButton active={mode === 'json'} onClick={() => (mode === 'form' ? toJson() : null)}>
              JSON
            </ModeButton>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto">
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
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border">
          <div className="text-[11px] text-muted-foreground/60 truncate">
            {form.scope === 'user'
              ? 'Stored in ~/.tide/mcp.json'
              : workspaceRoot
                ? `Stored in ${workspaceRoot}/.mcp.json`
                : 'No active workspace — switch to a workspace first'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!saveState}
              className="px-3 py-1.5 text-xs rounded-lg bg-accent text-accent-foreground hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saveLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScopeCard({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-accent bg-accent/10 ring-1 ring-accent/30'
          : 'border-border hover:border-accent/40 hover:bg-muted/50'
      }`}
    >
      <span className={`text-xs font-medium ${active ? 'text-accent' : 'text-foreground'}`}>
        {label}
      </span>
      <span className="text-[10px] text-muted-foreground/60 font-mono truncate max-w-full">
        {hint}
      </span>
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
      className={`px-3 py-1 rounded-md transition-colors ${
        active ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
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
    <div className="space-y-4">
      <Field label="Name">
        <input
          type="text"
          value={form.name}
          disabled={isEdit}
          placeholder="e.g. filesystem"
          onChange={(e) => patch({ name: e.target.value })}
          className={inputClass + (isEdit ? ' opacity-60 cursor-not-allowed' : '')}
        />
      </Field>

      <Field label="Transport">
        <RadioRow>
          <Radio
            name="transport"
            checked={form.transport === 'stdio'}
            onChange={() => patch({ transport: 'stdio' })}
            label="stdio"
          />
          <Radio
            name="transport"
            checked={form.transport === 'sse'}
            onChange={() => patch({ transport: 'sse' })}
            label="SSE"
          />
          <Radio
            name="transport"
            checked={form.transport === 'http'}
            onChange={() => patch({ transport: 'http' })}
            label="HTTP"
          />
        </RadioRow>
      </Field>

      {form.transport === 'stdio' ? (
        <>
          <Field label="Command">
            <input
              type="text"
              value={form.command}
              placeholder="e.g. npx"
              onChange={(e) => patch({ command: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label="Args" hint="One per line">
            <textarea
              value={form.argsText}
              rows={3}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/Users/me'}
              onChange={(e) => patch({ argsText: e.target.value })}
              className={inputClass + ' font-mono resize-y'}
            />
          </Field>
          <Field label="Environment" hint="KEY=value per line">
            <textarea
              value={form.envText}
              rows={3}
              placeholder={'API_KEY=...'}
              onChange={(e) => patch({ envText: e.target.value })}
              className={inputClass + ' font-mono resize-y'}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <input
              type="text"
              value={form.url}
              placeholder={
                form.transport === 'sse'
                  ? 'https://example.com/sse'
                  : 'https://example.com/mcp'
              }
              onChange={(e) => patch({ url: e.target.value })}
              className={inputClass + ' font-mono'}
            />
          </Field>
          <Field label="Auth">
            <RadioRow>
              <Radio
                name="auth"
                checked={form.auth === 'none'}
                onChange={() => patch({ auth: 'none' })}
                label="None"
              />
              <Radio
                name="auth"
                checked={form.auth === 'oauth'}
                onChange={() => patch({ auth: 'oauth' })}
                label="OAuth"
              />
            </RadioRow>
          </Field>
        </>
      )}
    </div>
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
    <div className="space-y-2">
      {/* Editor with line numbers */}
      <div className="relative flex rounded-md border border-input overflow-hidden focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40 transition-colors">
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
// Field / Radio primitives
// ──────────────────────────────────────────────────────────────────────────

const inputClass =
  'w-full rounded-md bg-background border border-input px-2.5 py-1.5 text-xs outline-none focus:border-accent focus:ring-1 focus:ring-accent/40 transition-colors';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
        {hint && <span className="text-[10px] text-muted-foreground/50">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function RadioRow({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-4">{children}</div>;
}

function Radio({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="size-3 accent-accent"
      />
      <span>{label}</span>
      {hint && <span className="text-[10px] text-muted-foreground/50 font-mono">{hint}</span>}
    </label>
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
