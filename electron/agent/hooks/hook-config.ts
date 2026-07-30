/**
 * Hook configuration — loads tool/stop hooks from user config files.
 *
 * Hooks are user-defined shell commands that run before/after tool calls
 * (PreToolUse/PostToolUse) or when the model naturally terminates (Stop).
 * They can deny tools, modify input/output, inject context, or block
 * continuation.
 *
 * Config sources (in priority order):
 *   1. Project: `.agent/hooks.json` in the workspace root
 *   2. User: `~/.agent/hooks.json`
 *
 * Both are merged; project hooks take precedence for the same event+tool
 * pattern.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** A single hook entry. */
export interface HookEntry {
  /** When the hook fires. */
  event: 'PreToolUse' | 'PostToolUse' | 'Stop';
  /** Tool name pattern: '*' = all, 'bash' = exact, 'edit:*' = prefix. */
  tools?: string;
  /** Shell command to execute. Receives hook input via stdin (JSON). */
  command: string;
  /** Timeout in ms (default 10_000). */
  timeoutMs?: number;
}

/** Loaded hook configuration. */
export interface HookConfig {
  preToolUse: HookEntry[];
  postToolUse: HookEntry[];
  stop: HookEntry[];
}

const EMPTY_CONFIG: HookConfig = { preToolUse: [], postToolUse: [], stop: [] };
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Load hooks from project + user config files. Returns an empty config if
 * neither file exists or both are malformed (hooks are opt-in; absence is
 * not an error).
 */
export function loadHookConfig(workspaceRoot: string): HookConfig {
  const projectPath = path.join(workspaceRoot, '.agent', 'hooks.json');
  const userPath = path.join(os.homedir(), '.agent', 'hooks.json');

  const project = loadHookFile(projectPath);
  const user = loadHookFile(userPath);

  // Merge: project hooks first (precedence), user hooks fill in.
  return {
    preToolUse: [...project.preToolUse, ...user.preToolUse],
    postToolUse: [...project.postToolUse, ...user.postToolUse],
    stop: [...project.stop, ...user.stop],
  };
}

function loadHookFile(filePath: string): HookConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch {
    return EMPTY_CONFIG;
  }
}

/** Normalize a parsed JSON object into a HookConfig with validation. */
function normalizeConfig(raw: unknown): HookConfig {
  if (typeof raw !== 'object' || raw === null) return EMPTY_CONFIG;
  const obj = raw as Record<string, unknown>;

  return {
    preToolUse: normalizeEntries(obj.PreToolUse ?? obj.preToolUse),
    postToolUse: normalizeEntries(obj.PostToolUse ?? obj.postToolUse),
    stop: normalizeEntries(obj.Stop ?? obj.stop),
  };
}

function normalizeEntries(raw: unknown): HookEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeEntry(entry))
    .filter((e): e is HookEntry => e !== null);
}

function normalizeEntry(raw: unknown): HookEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const command = String(obj.command ?? '').trim();
  if (!command) return null;
  const event = String(obj.event ?? '').trim();
  if (event !== 'PreToolUse' && event !== 'PostToolUse' && event !== 'Stop') return null;

  return {
    event,
    tools: typeof obj.tools === 'string' ? obj.tools : '*',
    command,
    timeoutMs: typeof obj.timeoutMs === 'number' ? obj.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/** Does a hook's tool pattern match a specific tool name? */
export function toolPatternMatches(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern === toolName) return true;
  // Prefix match: 'edit:*' matches 'edit_file'
  if (pattern.endsWith(':*')) {
    return toolName.startsWith(pattern.slice(0, -2));
  }
  return false;
}
