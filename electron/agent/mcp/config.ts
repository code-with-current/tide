/**
 * MCP config file read/write/merge.
 *
 * Two config sources, merged at connection time:
 *   - User:   ~/.tide/mcp.json (global servers, app-lifetime, + OAuth data)
 *   - Project: <workspace>/.mcp.json (workspace servers, workspace-lifetime)
 *
 * User config shape (unified):
 *   {
 *     "mcpServers": { "server-name": { ...config } },
 *     "oauth": {
 *       "tokens": { "server-name": "encrypted-blob" },
 *       "clients": { "server-name": "encrypted-blob" },
 *       "verifiers": { "server-name": "verifier-string" }
 *     }
 *   }
 *
 * Project config shape (flat, same as before):
 *   { "server-name": { ...config } }
 *
 * readMcpConfig handles all shapes and returns just the server map.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { McpConfigFile, McpServerConfig } from './types';
import { appDataDir } from '../../appPaths.js';

/** Read and parse an MCP config file. Returns {} on missing/corrupt.
 *
 *  Handles BOTH config shapes:
 *    1. Tide flat format:   { "server-name": { "type": "http", ... } }
 *    2. Wrapped format:     { "mcpServers": { "server-name": { ... } } }
 *
 *  The wrapper is detected when the top-level object has a
 *  "mcpServers" key whose value is an object — we unwrap it.
 */
export function readMcpConfig(filePath: string): McpConfigFile {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    // Wrapped format: { "mcpServers": { ... } }
    if (
      'mcpServers' in obj &&
      obj.mcpServers &&
      typeof obj.mcpServers === 'object' &&
      !Array.isArray(obj.mcpServers)
    ) {
      return obj.mcpServers as McpConfigFile;
    }
    return obj as McpConfigFile;
  } catch {
    return {};
  }
}

/**
 * Read the full user MCP config file (mcp.json) as a raw object, including
 * both mcpServers and oauth sections. Used by oauth.ts to access the oauth
 * section without clobbering the servers section.
 */
export function readFullUserMcpConfig(): Record<string, unknown> {
  const filePath = path.join(appDataDir(), 'mcp.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write the full user MCP config file atomically. Preserves the oauth section.
 */
export function writeFullUserMcpConfig(data: Record<string, unknown>): void {
  const filePath = path.join(appDataDir(), 'mcp.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
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
 * Write an MCP config file atomically (temp + rename).
 * For the user config (mcp.json), preserves the oauth section by reading
 * the existing file first and merging. For project configs, writes flat.
 */
export function writeMcpConfig(filePath: string, config: McpConfigFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const userData = appDataDir();
  const isUserConfig = filePath === path.join(userData, 'mcp.json');

  if (isUserConfig) {
    // Preserve the oauth section — read full, replace mcpServers, write.
    const full = readFullUserMcpConfig();
    full.mcpServers = config;
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(full, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } else {
    // Project config — flat, no oauth section.
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }
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

/**
 * Validate a single server config. Returns an array of error strings
 * (empty = valid). Accepts configs without an explicit "type" — infers
 * stdio from "command" or http from "url".
 */
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
