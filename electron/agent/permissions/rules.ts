/**
 * Rule-based permission rules — `.agents/settings.json`.
 *
 * Rule format: `"ToolName(argPattern)"` — e.g. `"bash(pnpm i)"`,
 * `"bash(npx:*)"`, `"edit_file(src/)"`. Tool name matches case-insensitively
 * via `'*'` / exact / `'prefix:*'`.
 *
 * argPattern matching:
 *   - Bare `"ToolName"` (no parens) = match any args
 *   - `"ToolName(prefix)"` = prefix match on the tool's primary arg
 *   - `"ToolName(prefix:*)"` = glob match — prefix up to `:*` matches anything after
 *   - `"ToolName(*suffix)"` = suffix glob match
 *   - `"ToolName(*middle*)"` = contains glob match
 *
 * Precedence: deny always rejects; allow upgrades an 'ask' decision to auto;
 * allow does NOT bypass plan-mode blocking.
 *
 * Rules persist in `{workspaceRoot}/.agents/settings.json`:
 * {
 *   "permissions": {
 *     "allow": ["bash(npm:*)", "edit_file(src/*)"],
 *     "deny": []
 *   }
 * }
 *
 * There is no separate "session" vs "project" scope — all rules are project-level
 * and persist across sessions. This matches Claude Code's behavior.
 */
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

export interface Rule {
  /** Tool-name pattern: '*' | 'bash' | 'edit:*' (case-insensitive). */
  tool: string;
  /** Pattern on the tool's primary arg; null = match any args. */
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
    return EMPTY;
  }
}

/** Load project rules from `<root>/.agents/settings.json`. */
export function loadPermissionRules(workspaceRoot: string): RuleSet {
  return loadFile(path.join(workspaceRoot, '.agents', 'settings.json'));
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
  if (p.endsWith(':*')) return t.startsWith(p.slice(0, -2));
  return false;
}

/**
 * Does an arg pattern match a value? Supports:
 *   - Plain prefix: "npm install" matches "npm install --force"
 *   - Glob suffix: "npx:*" matches "npx create-react-app" (anything after npx )
 *   - Glob path: "src/*" matches "src/components/Foo.ts"
 *   - Glob wildcard: "*" matches anything
 */
function argPatternMatches(pattern: string, value: string): boolean {
  // If the pattern contains glob chars (* or ? or [), use minimatch.
  if (/[*?\[]/.test(pattern)) {
    return minimatch(value, pattern, { dot: true });
  }
  // Plain prefix match.
  return value.startsWith(pattern);
}

/** Does a rule match a specific tool call? */
export function ruleMatches(rule: Rule, toolName: string, args: Record<string, unknown>): boolean {
  if (!toolNameMatches(rule.tool, toolName)) return false;
  if (rule.argPattern === null) return true;
  const arg = primaryArg(toolName, args);
  if (arg === null) return false;
  return argPatternMatches(rule.argPattern, arg);
}

/** Evaluate rules. 'deny' wins; else 'allow'; else null. */
export function evaluateRules(
  rules: RuleSet,
  toolName: string,
  args: Record<string, unknown>,
): 'deny' | 'allow' | null {
  for (const r of rules.deny) if (ruleMatches(r, toolName, args)) return 'deny';
  for (const r of rules.allow) if (ruleMatches(r, toolName, args)) return 'allow';
  return null;
}

/**
 * Derive a rule spec for "Always Allow" from the approved call.
 * Generates smart glob patterns:
 *   - bash: "bash(npx:*)" for npx commands, "bash(npm install)" for npm
 *   - file tools: "edit_file(src/*)" for path-based tools
 *   - bare tool name if no recognizable arg
 */
export function deriveRuleSpec(toolName: string, args: Record<string, unknown>): string {
  const arg = primaryArg(toolName, args);
  if (arg === null) return toolName;

  if (toolName === 'bash') {
    // For npx commands, use a glob: "npx package-name" → "bash(npx package-name:*)"
    if (arg.startsWith('npx ')) {
      const pkg = arg.split(/\s+/).slice(0, 2).join(' '); // "npx package-name"
      return `${toolName}(${pkg}:*)`;
    }
    // For npm/yarn/pnpm commands, keep first 2 tokens as prefix.
    if (/^(npm|yarn|pnpm|bun|deno)\s/.test(arg)) {
      const head = arg.split(/\s+/).slice(0, 2).join(' ');
      return `${toolName}(${head})`;
    }
    // Other commands: first token only.
    const head = arg.split(/\s+/)[0];
    return `${toolName}(${head})`;
  }

  // File tools: use the directory as a prefix glob.
  if (arg.includes('/')) {
    const dir = arg.substring(0, arg.lastIndexOf('/'));
    return `${toolName}(${dir}/*)`;
  }

  return `${toolName}(${arg})`;
}

// ─── In-memory cache (refreshed each turn via loadPermissionRules) ─────
// Session-scoped rules are still in-memory for the current turn (so a rule
// written mid-turn is immediately visible without re-reading the file).
// They're also persisted to .agents/settings.json by addPermissionRule.
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

// ─── Unified rule writer (replaces addSessionRule + addProjectRule) ────

/**
 * Add an "always allow" rule to `.agents/settings.json`. Also adds it to the
 * in-memory session rules so it takes effect immediately without a file re-read.
 *
 * The rule is derived from the approved tool call via deriveRuleSpec, producing
 * smart glob patterns (e.g. bash(npx:*) for npx commands).
 */
export function addPermissionRule(
  sessionId: string,
  workspaceRoot: string,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const spec = deriveRuleSpec(toolName, args);
  const rule = parseRule(spec);
  if (!rule) return null;

  // Add to in-memory session rules (immediate effect this turn).
  addSessionRule(sessionId, 'allow', rule);

  // Persist to .agents/settings.json (survives across sessions).
  const file = path.join(workspaceRoot, '.agents', 'settings.json');
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
    // missing/malformed — start fresh.
  }
  if (!cfg.permissions.allow.includes(spec)) {
    cfg.permissions.allow.push(spec);
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  } catch {
    // best-effort — don't fail the turn over a rule write.
  }

  return spec;
}
