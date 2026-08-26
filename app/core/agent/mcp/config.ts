/** MCP config read/write/merge. Global servers + OAuth now live in config.json
 *  (migrated from mcp.json). Project server definitions still read from
 *  <workspace>/.mcp.json on disk; project OAuth credentials live in config.json's
 *  workspace object. readMcpConfig handles both shapes and returns the server map. */
import * as fs from 'fs';
import * as path from 'path';
import type { McpConfigFile, McpServerConfig } from './types';
import { appDataDir } from '../../../platform/paths.js';
import * as store from '../../store.js';

/** Read MCP server config. For the user config path (~/.tide/mcp.json), reads
 *  from config.json (where servers were migrated). For project paths (.mcp.json),
 *  reads from disk. Handles both flat and wrapped formats. */
export function readMcpConfig(filePath: string): McpConfigFile {
  // User scope: read from config.json via the store.
  if (filePath === path.join(appDataDir(), 'mcp.json')) {
    return store.getMcpServers() as McpConfigFile;
  }
  // Project scope: read from disk.
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    if ('mcpServers' in obj && obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
      return obj.mcpServers as McpConfigFile;
    }
    return obj as McpConfigFile;
  } catch {
    return {};
  }
}

/** Read the full user MCP config from config.json — returns the shape
 *  oauth.ts expects: { mcpServers, oauth }. This replaces the old mcp.json read. */
export function readFullUserMcpConfig(): Record<string, unknown> {
  return {
    mcpServers: store.getMcpServers(),
    oauth: store.getMcpOAuth() ?? {},
  };
}

/** Write the full user MCP config into config.json (mcpServers + oauth). */
export function writeFullUserMcpConfig(data: Record<string, unknown>): void {
  store.setMcpServers((data.mcpServers as Record<string, unknown>) ?? {});
  store.setMcpOAuth((data.oauth as Record<string, string>) as { tokens?: Record<string, string>; clients?: Record<string, string>; verifiers?: Record<string, string> } | undefined);
}

/** Write an MCP config file. For user scope, writes to config.json's mcpServers.
 *  For project scope, writes flat to <workspace>/.mcp.json (server definitions only). */
export function writeMcpConfig(filePath: string, config: McpConfigFile): void {
  const isUserConfig = filePath === path.join(appDataDir(), 'mcp.json');
  if (isUserConfig) {
    store.setMcpServers(config);
  } else {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }
}

/**
 * Migrate old separate OAuth files into the unified mcp.json.
 * Called once at boot. No-op if already migrated or no old files exist.
 */
export function migrateOAuthFiles(): void {
  const userData = appDataDir();
  const oldFiles = {
    tokens: path.join(userData, 'mcp-oauth-tokens.json'),
    clients: path.join(userData, 'mcp-oauth-clients.json'),
    verifiers: path.join(userData, 'mcp-oauth-verifiers.json'),
  };

  // Check if any old files exist.
  const hasOldFiles = Object.values(oldFiles).some((f) => fs.existsSync(f));
  if (!hasOldFiles) return;

  // Read current mcp.json (could be flat or wrapped).
  const full = readFullUserMcpConfig();
  // Ensure mcpServers + oauth sections exist.
  if (!full.mcpServers || typeof full.mcpServers !== 'object') {
    // mcp.json is flat (old format) — wrap it.
    const flat = { ...full };
    full.mcpServers = flat;
    // Remove keys that are now under mcpServers (everything except mcpServers/oauth).
    for (const k of Object.keys(full)) {
      if (k !== 'mcpServers' && k !== 'oauth') delete full[k];
    }
  }
  if (!full.oauth || typeof full.oauth !== 'object') {
    full.oauth = {};
  }
  const oauth = full.oauth as Record<string, unknown>;

  // Merge old files into oauth section.
  for (const [section, oldPath] of Object.entries(oldFiles)) {
    try {
      if (fs.existsSync(oldPath)) {
        const data = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
        if (typeof data === 'object' && data !== null) {
          oauth[section] = { ...(oauth[section] as Record<string, unknown> ?? {}), ...data };
        }
        fs.unlinkSync(oldPath); // Delete after successful merge.
      }
    } catch { /* best-effort — leave the old file if migration fails */ }
  }

  writeFullUserMcpConfig(full);
}

/**
 * Merge user + project configs. Project wins on name collision.
 * Returns a new object — inputs are not mutated.
 */
export function mergeConfigs(
  user: McpConfigFile,
  project: McpConfigFile,
): McpConfigFile {
  return { ...user, ...project };
}

/** Validate a single server config; returns error strings (empty = valid). Accepts configs without explicit "type" — infers stdio from "command" or http from "url". */
export function validateServerConfig(config: McpServerConfig): string[] {
  const errors: string[] = [];
  const type = config.type
    ?? (config.command ? 'stdio'
    : config.url ? 'http'
    : undefined);
  if (type === 'stdio') {
    if (!config.command) errors.push('stdio servers require "command"');
  } else if (type === 'sse' || type === 'http') {
    if (!config.url) errors.push('remote servers require "url"');
  } else {
    errors.push('missing "type" — must be stdio, sse, or http (or include "command"/"url" for inference)');
  }
  return errors;
}

/** Add or replace a server in a config file. */
export function addServer(filePath: string, name: string, config: McpServerConfig): void {
  const full = readMcpConfig(filePath);
  full[name] = config;
  writeMcpConfig(filePath, full);
}

/** Remove a server from a config file. */
export function removeServer(filePath: string, name: string): void {
  const full = readMcpConfig(filePath);
  delete full[name];
  writeMcpConfig(filePath, full);
}
