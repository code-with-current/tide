import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SKILLS, getBuiltinSkillBody, builtinSkillSummaries, mergeBuiltinSkills, SKILLS_BOOTSTRAP,
} from '../../../../electron/agent/skills/builtin';
import type { SkillSummary } from '../../../../electron/agent/tools/tool-context';

describe('builtin skills registry', () => {
  it('exposes all 13 skills with virtual builtin: paths', () => {
    expect(BUILTIN_SKILLS).toHaveLength(13);
    for (const s of builtinSkillSummaries()) {
      expect(s.absPath).toMatch(/^builtin:[a-z-]+$/);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('resolves a builtin body by name', () => {
    const body = getBuiltinSkillBody('brainstorming');
    expect(body).toContain('# Brainstorming');
  });

  it('returns undefined for unknown names', () => {
    expect(getBuiltinSkillBody('nope')).toBeUndefined();
  });
});

describe('mergeBuiltinSkills', () => {
  const scanned: SkillSummary[] = [
    { name: 'brainstorming', description: 'user override', absPath: '/home/u/.claude/skills/brainstorming/SKILL.md' },
    { name: 'mine', description: '', absPath: '/w/.claude/skills/mine/SKILL.md' },
  ];

  it('appends builtins after scanned, scanned wins collisions', () => {
    const merged = mergeBuiltinSkills(scanned, []);
    expect(merged[0].name).toBe('brainstorming');
    expect(merged[0].absPath).toContain('.claude');
    expect(merged.find((s) => s.name === 'writing-plans')?.absPath).toBe('builtin:writing-plans');
    expect(merged).toHaveLength(1 + 1 + 12);
  });

  it('filters disabled builtins by name', () => {
    const merged = mergeBuiltinSkills(scanned, ['writing-plans']);
    expect(merged.find((s) => s.name === 'writing-plans')).toBeUndefined();
    expect(merged.find((s) => s.name === 'brainstorming')).toBeDefined();
  });
});

describe('SKILLS_BOOTSTRAP', () => {
  it('is non-empty and teaches the check-first rule', () => {
    expect(SKILLS_BOOTSTRAP.length).toBeGreaterThan(500);
    expect(SKILLS_BOOTSTRAP).toContain('BEFORE any response or action');
    expect(SKILLS_BOOTSTRAP).toContain('load_skill');
  });
});
