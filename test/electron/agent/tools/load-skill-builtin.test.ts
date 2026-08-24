import { describe, expect, it } from 'vitest';
import { runLoadSkill } from '../../../../electron/agent/tools/load-skill';

describe('runLoadSkill builtin: ids', () => {
  it('resolves builtin ids in memory without touching disk', async () => {
    const res = await runLoadSkill('builtin:brainstorming', '/nonexistent/workspace');
    expect(res.status).toBe('executed');
    expect(res.display?.kind).toBe('file_loaded');
    if (res.display?.kind === 'file_loaded') {
      expect(res.display.body).toContain('# Brainstorming');
      expect(res.display.path).toBe('builtin:brainstorming');
    }
    expect(res.meta).toContain('brainstorming');
  });

  it('fails cleanly for an unknown builtin id', async () => {
    const res = await runLoadSkill('builtin:nope', '/nonexistent/workspace');
    expect(res.status).toBe('failed');
    expect(res.output).toContain('not a builtin skill');
  });

  it('still reads disk paths unchanged (regression)', async () => {
    const res = await runLoadSkill('/nonexistent/SKILL.md', '/nonexistent/workspace');
    expect(res.status).toBe('failed');
    expect(res.output).toContain('Failed to load skill');
  });
});
