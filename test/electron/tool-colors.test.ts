import { describe, expect, it } from 'vitest';
import { toolTextColor } from '../../src/lib/tool-colors.js';

describe('toolTextColor', () => {
  it('maps known tools', () => {
    expect(toolTextColor('edit_file')).toBe('text-amber-400');
    expect(toolTextColor('bash')).toBe('text-green-400');
    expect(toolTextColor('read_file')).toBe('text-sky-400');
    expect(toolTextColor('git')).toBe('text-orange-400');
  });

  it('resolves dispatch_agent and its task alias to purple', () => {
    expect(toolTextColor('dispatch_agent')).toBe('text-purple-400');
    expect(toolTextColor('task')).toBe('text-purple-400');
  });

  it('normalizes case, whitespace, and renderer-style keys', () => {
    expect(toolTextColor(' Edit_File ')).toBe('text-amber-400');
    expect(toolTextColor('mcp.server.edit_file')).toBe('text-amber-400');
    expect(toolTextColor('todowrite')).toBe('text-blue-400');
    expect(toolTextColor('webfetch')).toBe('text-cyan-400');
    expect(toolTextColor('websearch')).toBe('text-cyan-400');
  });

  it('unknown tools get undefined (inherit)', () => {
    expect(toolTextColor('mystery_tool')).toBeUndefined();
    expect(toolTextColor(undefined as unknown as string)).toBeUndefined();
  });
});
