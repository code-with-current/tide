/** MCP import scanner: detects servers from other tools' config files (Claude Code, Codex, OpenCode, generic) and normalizes them to Tide's McpServerConfig shape. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../../logger';
import type { McpServerConfig } from './types';

const log = createLogger('mcp/scanner');

export interface DetectedServer {
  name: string;
  config: McpServerConfig;
  source: string; // display label: "Claude Code", "Codex", etc.
  sourceFile: string; // the file path it came from
}

export interface ScanResult {
  servers: DetectedServer[];
  /** Names already present in Tide's config (so the UI can pre-uncheck them). */
  alreadyImported: string[];
}

/** Scan all known sources for MCP server configs. */
export function scanExternalMcpServers(
  tideConfigPath: string,
): ScanResult {
  const home = os.homedir();
  const detected: DetectedServer[] = [];

  // 1. Claude Code — ~/.claude.json (root-level mcpServers)
  scanJsonFile(
    path.join(home, '.claude.json'),
    'Claude Code',
    (d) => d.mcpServers,
    detected,
  );

  // 1b. Claude Code — ~/.claude/settings.json (mcpServers key)
  scanJsonFile(
    path.join(home, '.claude', 'settings.json'),
    'Claude Code',
    (d) => d.mcpServers,
    detected,
  );

  // 2. Codex CLI — ~/.codex/config.toml ([mcp_servers.*] sections)
  scanCodexToml(
    path.join(home, '.codex', 'config.toml'),
    detected,
  );

  // 3. OpenCode — ~/.config/opencode/opencode.json (mcp key)
  scanJsonFile(
    path.join(home, '.config', 'opencode', 'opencode.json'),
    'OpenCode',
    (d) => d.mcp,
    detected,
  );

  // 4. Generic — ~/.agents/mcp.json
  scanJsonFile(
    path.join(home, '.agents', 'mcp.json'),
    'Generic',
    (d) => {
      // Generic format might use mcpServers wrapper OR flat map
      if (d.mcpServers) return d.mcpServers;
      // If all values look like server configs (have type/command/url), treat as flat
      const vals = Object.values(d);
      if (vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return d;
      return {};
    },
    detected,
  );

  // Read Tide's existing config to mark already-imported servers
  let alreadyImported: string[] = [];
  try {
    const tideRaw = fs.readFileSync(tideConfigPath, 'utf-8');
    const tideParsed = JSON.parse(tideRaw);
    alreadyImported = Object.keys(tideParsed);
  } catch {
    // Tide config doesn't exist yet — nothing imported
  }

  // Deduplicate detected servers by name (first source wins per name)
  const seen = new Set<string>();
  const deduped = detected.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  log.info('scan complete', { detected: deduped.length, alreadyImported: alreadyImported.length });

  return { servers: deduped, alreadyImported };
}

// ─── JSON source scanner ──────────────────────────────────────────────

function scanJsonFile(
  filePath: string,
  sourceLabel: string,
  extract: (data: any) => Record<string, any> | undefined,
  out: DetectedServer[],
): void {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const servers = extract(parsed);
    if (!servers || typeof servers !== 'object') return;

    for (const [name, rawConfig] of Object.entries(servers)) {
      if (!rawConfig || typeof rawConfig !== 'object') continue;
      const normalized = normalizeExternalConfig(rawConfig as Record<string, unknown>);
      if (normalized) {
        out.push({ name, config: normalized, source: sourceLabel, sourceFile: filePath });
      }
    }
  } catch {
    // File doesn't exist or can't be parsed — skip silently
  }
}

// ─── Codex TOML scanner ───────────────────────────────────────────────
// Minimal TOML parser for [mcp_servers.*] sections. We only need to extract
// key=value pairs and inline tables { k = "v" } — not a full TOML parser.

function scanCodexToml(
  filePath: string,
  out: DetectedServer[],
): void {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const sections = parseTomlMcpServers(raw);
    for (const [name, config] of Object.entries(sections)) {
      const normalized = normalizeExternalConfig(config);
      if (normalized) {
        out.push({ name, config: normalized, source: 'Codex', sourceFile: filePath });
      }
    }
  } catch {
    // File doesn't exist — skip
  }
}

/** Minimal TOML parser for [mcp_servers.NAME] sections (plus env/http_headers sub-tables); not a full TOML implementation. */
function parseTomlMcpServers(toml: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentServer: string | null = null;
  let currentSubTable: string | null = null; // 'env' or 'http_headers'

  for (const line of toml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // [mcp_servers.NAME.env] or [mcp_servers.NAME.http_headers]
    const subMatch = trimmed.match(/^\[mcp_servers\.(\w+)\.(env|http_headers)\]/);
    if (subMatch) {
      currentServer = subMatch[1];
      currentSubTable = subMatch[2];
      if (!result[currentServer]) result[currentServer] = {};
      if (!result[currentServer][currentSubTable]) result[currentServer][currentSubTable] = {};
      continue;
    }

    // [mcp_servers.NAME]
    const serverMatch = trimmed.match(/^\[mcp_servers\.(\w+)\]/);
    if (serverMatch) {
      currentServer = serverMatch[1];
      currentSubTable = null;
      if (!result[currentServer]) result[currentServer] = {};
      continue;
    }

    // Any other [section] — reset context
    if (trimmed.startsWith('[')) {
      currentServer = null;
      currentSubTable = null;
      continue;
    }

    if (!currentServer) continue;

    // key = value
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const valueRaw = trimmed.slice(eqIdx + 1).trim();

    // Inline table: { K = "V", ... }
    if (valueRaw.startsWith('{')) {
      const inlineTable = parseInlineTomlTable(valueRaw);
      result[currentServer][key] = inlineTable;
      continue;
    }

    // Array: ["a", "b"]
    if (valueRaw.startsWith('[')) {
      result[currentServer][key] = parseTomlArray(valueRaw);
      continue;
    }

    // String: "value"
    const strMatch = valueRaw.match(/^"(.*)"$/);
    if (strMatch) {
      const value = strMatch[1];
      if (currentSubTable === 'env' || currentSubTable === 'http_headers') {
        (result[currentServer][currentSubTable] as Record<string, string>)[key] = value;
      } else {
        result[currentServer][key] = value;
      }
      continue;
    }

    // Bare value (number, bool)
    result[currentServer][key] = valueRaw;
  }

  return result;
}

function parseInlineTomlTable(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Strip outer braces
  const inner = raw.replace(/^\{/, '').replace(/\}$/, '').trim();
  // Split on commas (naive — doesn't handle commas inside values)
  for (const part of inner.split(',')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim().replace(/^"(.*)"$/, '$1');
    result[k] = v;
  }
  return result;
}

function parseTomlArray(raw: string): string[] {
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
}

// ─── Normalizer ───────────────────────────────────────────────────────

/** Normalize an external server config to Tide's format, inferring type from `command` (stdio) or `url` (http). */
function normalizeExternalConfig(raw: Record<string, unknown>): McpServerConfig | null {
  const config: Partial<McpServerConfig> = {};

  // Determine type
  if (typeof raw.type === 'string' && ['stdio', 'sse', 'http'].includes(raw.type)) {
    config.type = raw.type as McpServerConfig['type'];
  } else if (typeof raw.command === 'string') {
    config.type = 'stdio';
  } else if (typeof raw.url === 'string') {
    config.type = 'http';
  } else {
    // Can't determine transport — skip
    return null;
  }

  // stdio fields
  if (typeof raw.command === 'string') config.command = raw.command;
  if (Array.isArray(raw.args)) config.args = raw.args.filter((a): a is string => typeof a === 'string');

  // env — might come from `env` key (JSON) or inline TOML table
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (Object.keys(env).length > 0) config.env = env;
  }

  // remote fields
  if (typeof raw.url === 'string') config.url = raw.url;

  // Codex uses http_headers instead of headers — we can't map headers to
  // Tide's env-based secret model, so skip them (user can re-add manually)
  // unless the URL has an auth query param already.

  return config as McpServerConfig;
}
