import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

const ROOT = path.resolve(__dirname, '..', '..');
const bundlePath = () => path.join(ROOT, 'src', 'lib', 'prompts', '_skills-bundle.ts');

describe('buildSkillsBundle output (_skills-bundle.ts)', () => {
  it('generates the module with all 13 skills + bootstrap', async () => {
    execSync('node build/promptMarkdownUtils.mjs', { cwd: ROOT });
    expect(fs.existsSync(bundlePath())).toBe(true);
    const mod: any = await import(pathToFileURL(bundlePath()).href);
    const names = mod.BUNDLED_SKILLS.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual([
      'brainstorming', 'dispatching-parallel-agents', 'executing-plans',
      'finishing-a-development-branch', 'receiving-code-review',
      'requesting-code-review', 'subagent-driven-development',
      'systematic-debugging', 'test-driven-development', 'using-git-worktrees',
      'verification-before-completion', 'writing-plans', 'writing-skills',
    ]);
    expect(mod.SKILLS_BOOTSTRAP).toContain('# Using Builtin Skills');
  });

  it('strips frontmatter and attribution comment from bodies, keeps description', async () => {
    const mod: any = await import(pathToFileURL(bundlePath()).href);
    const bs = mod.BUNDLED_SKILLS.find((s: { name: string }) => s.name === 'brainstorming');
    expect(bs.description).toMatch(/before any creative work/i);
    expect(bs.body).not.toMatch(/^---/m);
    expect(bs.body).not.toContain('<!-- Adapted from obra/superpowers');
    expect(bs.body).toContain('# Brainstorming');
  });

  it('inlines nested reference files under a Reference heading', async () => {
    const mod: any = await import(pathToFileURL(bundlePath()).href);
    const sd = mod.BUNDLED_SKILLS.find((s: { name: string }) => s.name === 'systematic-debugging');
    const nestedDir = path.join(ROOT, 'src', 'lib', 'prompts', 'skills', 'systematic-debugging');
    const nested = fs.existsSync(nestedDir)
      ? fs.readdirSync(nestedDir).filter((f) => f.endsWith('.md') && f !== 'SKILL.md')
      : [];
    for (const n of nested) {
      expect(sd.body).toContain('# Reference: ' + n.replace(/\.md$/, ''));
    }
  });
});
