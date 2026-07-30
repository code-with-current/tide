/**
 * MCP server approval tracking — which servers the user has approved
 * for first-connect. Stored in extensions.json alongside the disabled list.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const EXTENSIONS_FILE = 'extensions.json';

function extensionsFilePath(): string {
  return path.join(app.getPath('userData'), EXTENSIONS_FILE);
}

interface ExtensionsFileShape {
  disabled?: Record<string, string[]>;
  approvedMcpServers?: string[];
}

function readAll(): ExtensionsFileShape {
  try {
    const raw = fs.readFileSync(extensionsFilePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeAll(data: ExtensionsFileShape): void {
  const filePath = extensionsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function getApprovedServers(): string[] {
  return readAll().approvedMcpServers ?? [];
}

export function approveServer(name: string): void {
  const data = readAll();
  if (!data.approvedMcpServers) data.approvedMcpServers = [];
  if (!data.approvedMcpServers.includes(name)) {
    data.approvedMcpServers.push(name);
    writeAll(data);
  }
}

export function revokeServer(name: string): void {
  const data = readAll();
  if (data.approvedMcpServers) {
    data.approvedMcpServers = data.approvedMcpServers.filter((n) => n !== name);
    writeAll(data);
  }
}
