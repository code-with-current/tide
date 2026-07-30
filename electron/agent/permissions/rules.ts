/**
 * Rule-based permission rules — `.agent/settings.json` + session-scoped.
 *
 * Modeled on `loadHookConfig` (../hooks/hook-config.ts): read project + user
 * JSON files, return empty on missing/malformed, re-read each turn.
 *
 * Rule format: `"ToolName(argPattern)"` — e.g. `"Bash(pnpm i)"`,
 * `"EditFile(src/)"`. Tool name matches case-insensitively via `'*'` / exact /
 * `'prefix:*'` (so Claude-Code-style `"Bash"` matches Tide's `bash`).
 * argPattern is a **prefix match** (v1) on the tool's primary arg (command for
 * bash, path for file tools). A bare `"ToolName"` (no parens) matches any args.
 *
 * Precedence (in withPermission): deny (any scope) always rejects; allow
 * upgrades an `'ask'` decision to auto; allow does NOT bypass plan-mode
 * blocking (`'blocked'`) — plan mode is a hard no-mutation contract.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Rule {
  /** Tool-name pattern: '*' | 'bash' | 'edit:*' (case-insensitive). */
  tool: string;
  /** Prefix on the tool's primary arg; null = match any args. */
  argPattern: string | null;
}

export interface RuleSet {
  allow: Rule[];
  deny: Rule[];
}

const EMPTY: RuleSet = { allow: [], deny: [] };

/** Parse `"ToolName(argPattern)"` or `"ToolName"`. null if unparseable. */
export function parseRule(spec: string): Rule | null {
  const s = spec.trim();
  if (!s) return null;
  const m = s.match(/^([^()]+)\(([\s\S]*)\)$/);
  if (m) {
    const tool = m[1].trim();
    if (!tool) return null;
    const arg = m[2].trim();
    return { tool, argPattern: arg || null };
  }
  return { tool: s, argPattern: null };
}

function parseList(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === 'string' ? parseRule(x) : null))
    .filter((r): r is Rule => r !== null);
}

function loadFile(filePath: string): RuleSet {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || !parsed) return EMPTY;
    const perms = (parsed as { permissions?: { allow?: unknown; deny?: unknown } }).permissions ?? {};
    return { allow: parseList(perms.allow), deny: parseList(perms.deny) };
  } catch {
    return EMPTY; // missing or malformed — rules are opt-in, absence is not an error
  }
}

/** Load project (`<root>/.agent/settings.json`) + user (`~/.agent/settings.json`) rules. */
export function loadPermissionRules(workspaceRoot: string): RuleSet {
  const project = loadFile(path.join(workspaceRoot, '.agent', 'settings.json'));
  const user = loadFile(path.join(os.homedir(), '.agent', 'settings.json'));
  // Project first within the merged list (precedence on equal specificity).
  return { allow: [...project.allow, ...user.allow], deny: [...project.deny, ...user.deny] };
}

/** The primary arg used for argPattern matching, per tool. */
export function primaryArg(toolName: string, args: Record<string, unknown>): string | null {
  const a = args as { command?: string; args?: string[]; url?: string; query?: string; path?: string; pattern?: string };
  switch (toolName) {
    case 'bash':
      return typeof a.command === 'string' ? a.command : null;
    case 'git':
      return Array.isArray(a.args) ? a.args.join(' ') : null;
    case 'web_fetch':
      return typeof a.url === 'string' ? a.url : null;
    case 'web_search':
      return typeof a.query === 'string' ? a.query : null;
    case 'edit_file':
    case 'multi_edit':
    case 'write_file':
    case 'notebook_edit':
    case 'read_file':
    case 'list_dir':
    case 'glob':
    case 'grep':
      return typeof a.path === 'string' ? a.path : typeof a.pattern === 'string' ? a.pattern : null;
    default:
      return null;
  }
}

function toolNameMatches(pattern: string, toolName: string): boolean {
  const p = pattern.toLowerCase();
  const t = toolName.toLowerCase();
  if (p === '*') return true;
  if (p === t) return true;
  if (p.endsWith(':*')) return t.startsWith(p.slice(0, -2)); // 'edit:*' → 'edit_file' etc.
  return false;
}

/** Does a rule match a specific tool call? */
export function ruleMatches(rule: Rule, toolName: string, args: Record<string, unknown>): boolean {
  if (!toolNameMatches(rule.tool, toolName)) return false;
  if (rule.argPattern === null) return true; // bare tool name = any args
  const arg = primaryArg(toolName, args);
  if (arg === null) return false;
  return arg.startsWith(rule.argPattern); // v1: prefix match (glob is a follow-up)
}

/** Evaluate combined session + project rules. 'deny' wins; else 'allow'; else null. */
export function evaluateRules(
  session: RuleSet,
  project: RuleSet,
  toolName: string,
  args: Record<string, unknown>,
): 'deny' | 'allow' | null {
  for (const r of session.deny) if (ruleMatches(r, toolName, args)) return 'deny';
  for (const r of project.deny) if (ruleMatches(r, toolName, args)) return 'deny';
  for (const r of session.allow) if (ruleMatches(r, toolName, args)) return 'allow';
  for (const r of project.allow) if (ruleMatches(r, toolName, args)) return 'allow';
  return null;
}

/** Heuristic rule spec for "Always allow" — derivable from the approved call. */
export function deriveRuleSpec(toolName: string, args: Record<string, unknown>): string {
  const arg = primaryArg(toolName, args);
  if (arg === null) return toolName; // bare tool name
  // For bash, the first 1-2 tokens are a stable command prefix
  // ("pnpm i --filter x" → "pnpm i"). For file tools, the path prefix-matches.
  if (toolName === 'bash') {
    const head = arg.split(/\s+/).slice(0, 2).join(' ');
    return `${toolName}(${head})`;
  }
  return `${toolName}(${arg})`;
}

// ─── Session-scoped rule store (in-memory; cleared on session end) ─────
const sessionRules = new Map<string, RuleSet>();

export function addSessionRule(sessionId: string, scope: 'allow' | 'deny', rule: Rule): void {
  const cur = sessionRules.get(sessionId) ?? { allow: [], deny: [] };
  cur[scope].push(rule);
  sessionRules.set(sessionId, cur);
}

export function getSessionRules(sessionId: string): RuleSet {
  return sessionRules.get(sessionId) ?? EMPTY;
}

export function clearSessionRules(sessionId: string): void {
  sessionRules.delete(sessionId);
}

// ─── Project file writer (for "Always allow — this project") ───────────
/** Append a rule spec to `<root>/.agent/settings.json`, preserving existing
 *  content. Best-effort: missing/malformed file is (re)created; non-writable
 *  roots silently fail (the in-memory turn still proceeds). */
export function addProjectRule(workspaceRoot: string, scope: 'allow' | 'deny', spec: string): void {
  const file = path.join(workspaceRoot, '.agent', 'settings.json');
  let cfg: { permissions: { allow: string[]; deny: string[] } } = {
    permissions: { allow: [], deny: [] },
  };
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      cfg = parsed as typeof cfg;
      if (!cfg.permissions) cfg.permissions = { allow: [], deny: [] };
      if (!Array.isArray(cfg.permissions.allow)) cfg.permissions.allow = [];
      if (!Array.isArray(cfg.permissions.deny)) cfg.permissions.deny = [];
    }
  } catch {
    // missing/malformed — start fresh below.
  }
  const list = cfg.permissions[scope];
  if (!list.includes(spec)) list.push(spec);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  } catch {
    // best-effort — don't fail the turn over a rule write.
  }
}
