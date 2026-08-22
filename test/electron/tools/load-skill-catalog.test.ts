import { describe, expect, it } from 'vitest';
import { buildSkillCatalogMd } from '../../../electron/agent/tools/load-skill';

const skill = (name: string, description = '', absPath = `/skills/${name}/SKILL.md`) => ({
  name,
  description,
  absPath,
});

describe('buildSkillCatalogMd', () => {
  it('renders full lines (name, path, description) for a small set', () => {
    const md = buildSkillCatalogMd([
      skill('verify', 'Runtime verification of changes.'),
      skill('debug', 'Systematic debugging loop.'),
    ]);
    expect(md).toBe(
      '- **verify** (/skills/verify/SKILL.md): Runtime verification of changes.\n' +
      '- **debug** (/skills/debug/SKILL.md): Systematic debugging loop.',
    );
  });

  it('omits the description separator when a skill has no description', () => {
    const md = buildSkillCatalogMd([skill('bare')]);
    expect(md).toBe('- **bare** (/skills/bare/SKILL.md)');
  });

  it('collapses whitespace and clamps long descriptions', () => {
    const md = buildSkillCatalogMd([skill('long', 'word '.repeat(60))]);
    expect(md).not.toContain('word  word');
    expect(md.length).toBeLessThan(300);
  });

  it('degrades to name+path lines once the char budget is exhausted', () => {
    const skills = Array.from({ length: 80 }, (_, i) =>
      skill(`skill-${String(i).padStart(2, '0')}`, 'x'.repeat(100)),
    );
    const md = buildSkillCatalogMd(skills);
    const lines = md.split('\n');
    const fullLines = lines.filter((l) => l.includes(': '));
    const bareLines = lines.filter((l) => !l.includes(': '));
    expect(fullLines.length).toBeGreaterThan(0);
    expect(fullLines.length).toBeLessThan(skills.length);
    expect(bareLines.length).toBe(skills.length - fullLines.length);
    for (const l of bareLines) expect(l).toMatch(/^- \*\*skill-\d+\*\* \(\/skills\/skill-\d+\/SKILL\.md\)$/);
  });

  it('caps entries and reports the omission count', () => {
    const skills = Array.from({ length: 130 }, (_, i) => skill(`s${i}`));
    const md = buildSkillCatalogMd(skills);
    const lines = md.split('\n');
    expect(lines).toHaveLength(121);
    expect(lines[120]).toBe('(+10 more skills not listed)');
  });

  it('returns an empty string for an empty catalog', () => {
    expect(buildSkillCatalogMd([])).toBe('');
  });
});
