import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../../electron/appPaths.js', () => ({
  appDataDir: () => '/tmp/tide-mock-appdata',
}));

import { readMcpConfig, writeMcpConfig, mergeConfigs, validateServerConfig } from '../../../electron/agent/mcp/config';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-mcp-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readMcpConfig', () => {
  it('returns empty object when file does not exist', () => {
    expect(readMcpConfig(path.join(tmpDir, 'missing.json'))).toEqual({});
  });

  it('reads a valid config file', () => {
    const filePath = path.join(tmpDir, '.mcp.json');
    fs.writeFileSync(filePath, JSON.stringify({
      github: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'] },
    }));
    const config = readMcpConfig(filePath);
    expect(config.github).toBeDefined();
    expect(config.github.type).toBe('stdio');
    expect(config.github.command).toBe('npx');
  });

  it('returns empty on corrupt JSON', () => {
    const filePath = path.join(tmpDir, '.mcp.json');
    fs.writeFileSync(filePath, '{ not valid');
    expect(readMcpConfig(filePath)).toEqual({});
  });

  it('unwraps Claude Code mcpServers format', () => {
    const filePath = path.join(tmpDir, '.mcp.json');
    fs.writeFileSync(filePath, JSON.stringify({
      mcpServers: {
        supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
      },
    }));
    const config = readMcpConfig(filePath);
    expect(config.supabase).toBeDefined();
    expect(config.supabase.type).toBe('http');
    expect(config.mcpServers).toBeUndefined();
  });
});

describe('writeMcpConfig', () => {
  it('writes a config file that round-trips', () => {
    const filePath = path.join(tmpDir, '.mcp.json');
    const config = {
      supabase: { type: 'http' as const, url: 'https://mcp.supabase.com/mcp' },
    };
    writeMcpConfig(filePath, config);
    expect(readMcpConfig(filePath)).toEqual(config);
  });
});

describe('mergeConfigs', () => {
  it('merges user + project with project winning on collision', () => {
    const user = { github: { type: 'stdio' as const, command: 'npx' } };
    const project = { github: { type: 'http' as const, url: 'https://custom' }, postgres: { type: 'stdio' as const, command: 'npx' } };
    const merged = mergeConfigs(user, project);
    expect(merged.github.type).toBe('http');
    expect(merged.postgres).toBeDefined();
    expect(Object.keys(merged)).toHaveLength(2);
  });
});

describe('validateServerConfig', () => {
  it('accepts valid stdio config', () => {
    const errors = validateServerConfig({ type: 'stdio', command: 'npx', args: ['-y', 'server'] });
    expect(errors).toHaveLength(0);
  });

  it('accepts valid http config', () => {
    const errors = validateServerConfig({ type: 'http', url: 'https://example.com/mcp' });
    expect(errors).toHaveLength(0);
  });

  it('rejects stdio without command', () => {
    const errors = validateServerConfig({ type: 'stdio' });
    expect(errors).toContain('stdio servers require "command"');
  });

  it('rejects http without url', () => {
    const errors = validateServerConfig({ type: 'http' });
    expect(errors).toContain('remote servers require "url"');
  });
});
