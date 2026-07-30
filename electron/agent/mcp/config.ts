/**
 * MCP config file read/write/merge.
 *
 * Two config sources, merged at connection time:
 *   - User:   ~/.tide/mcp.json (global servers, app-lifetime)
 *   - Project: <workspace>/.mcp.json (workspace servers, workspace-lifetime)
 *
 * Both files have the same shape: { [serverName]: McpServerConfig }.
 * Project wins on name collision.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { McpConfigFile, McpServerConfig } from './types';

/** Read and parse an MCP config file. Returns {} on missing/corrupt.
 *
 *  Handles BOTH config shapes:
 *    1. Tide flat format:   { "server-name": { "type": "http", ... } }
 *    2. Claude Code format: { "mcpServers": { "server-name": { ... } } }
 *
 *  The Claude Code wrapper is detected when the top-level object has a single
 *  "mcpServers" key whose value is an object — we unwrap it to the flat shape.
 */
export function readMcpConfig(filePath: string): McpConfigFile {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    // Claude Code format: { "mcpServers": { ... } }
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

/** Write an MCP config file atomically (temp + rename). */
export function writeMcpConfig(filePath: string, config: McpConfigFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
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
 * (empty = valid).
 */
export function validateServerConfig(config: McpServerConfig): string[] {
  const errors: string[] = [];
  if (config.type === 'stdio') {
    if (!config.command) errors.push('stdio servers require "command"');
  } else if (config.type === 'sse' || config.type === 'http') {
    if (!config.url) errors.push('remote servers require "url"');
  } else {
    errors.push(`unknown type "${config.type}" — must be stdio, sse, or http`);
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
