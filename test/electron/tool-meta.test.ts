import { describe, it, expect } from 'vitest';
import { toolMeta, getToolMeta } from '../../electron/agent/tools/tool-meta.js';

describe('toolMeta sidecar', () => {
  it('has an entry for every currently-registered tool plus the new memory tool', () => {
    // Same set as registry.ts plus memory. Update both together when adding tools.
    const expected = [
      'bash', 'read_file', 'write_file', 'edit_file', 'multi_edit',
      'list_dir', 'glob', 'grep', 'git', 'todo_write', 'ask_followup_question',
      'exit_plan_mode', 'compact', 'slash_command', 'dispatch_agent', 'web_fetch',
      'web_search', 'notebook_edit', 'bash_output', 'kill_shell', 'mcp', 'memory',
    ] as const;
    for (const name of expected) {
      expect(toolMeta[name]).toBeDefined();
    }
  });

  it('destructive tools (bash, git) only auto-approve in full mode', () => {
    expect(getToolMeta('bash').riskTier).toBe('destructive');
    expect(getToolMeta('bash').autoApproveIn).toEqual(['full']);
    expect(getToolMeta('git').riskTier).toBe('destructive');
    expect(getToolMeta('git').autoApproveIn).toEqual(['full']);
  });

  it('write-tier tools (edit_file, write_file, etc.) auto-approve in edit + full', () => {
    for (const name of ['edit_file', 'write_file', 'multi_edit', 'notebook_edit', 'kill_shell'] as const) {
      expect(getToolMeta(name).riskTier).toBe('write');
      expect(getToolMeta(name).autoApproveIn).toEqual(['edit', 'full']);
    }
  });

  it('read-only tools auto-approve in all modes', () => {
    for (const name of ['read_file', 'list_dir', 'glob', 'grep', 'web_fetch', 'web_search', 'todo_write'] as const) {
      expect(getToolMeta(name).riskTier).toBe('read_only');
      expect(getToolMeta(name).autoApproveIn).toEqual(['plan', 'ask', 'edit', 'full']);
    }
  });

  it('categories match the existing blockState grouping', () => {
    expect(getToolMeta('bash').category).toBe('commands');
    expect(getToolMeta('git').category).toBe('commands');
    expect(getToolMeta('edit_file').category).toBe('edits');
    expect(getToolMeta('write_file').category).toBe('edits');
    expect(getToolMeta('read_file').category).toBe('exploration');
    expect(getToolMeta('grep').category).toBe('exploration');
    expect(getToolMeta('todo_write').category).toBe('other');
    expect(getToolMeta('dispatch_agent').category).toBe('other');
  });

  it('memory tool is auto-approved in all modes (special case — confined writes)', () => {
    expect(getToolMeta('memory').autoApproveIn).toEqual(['plan', 'ask', 'edit', 'full']);
    expect(getToolMeta('memory').riskTier).toBe('read_only');
    expect(getToolMeta('memory').category).toBe('other');
  });

  it('getToolMeta throws on unknown tool', () => {
    expect(() => getToolMeta('nonexistent' as any)).toThrow(/Unknown tool/);
  });

  it('every entry has a positive timeoutMs', () => {
    for (const [name, meta] of Object.entries(toolMeta)) {
      expect(meta.timeoutMs, `${name} should have positive timeoutMs`).toBeGreaterThan(0);
    }
  });
});
