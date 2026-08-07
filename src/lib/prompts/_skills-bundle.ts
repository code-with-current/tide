/** Built-in skills bundled with the app. Generated from src/lib/prompts/skills/*.md */
import initSkill from './skills/init.md?raw';

export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
}

function parseFrontmatter(raw: string): { name: string; description: string; body: string } {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) return { name: '', description: '', body: raw };
  const frontmatter = fm[1];
  const body = fm[2];
  const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim() ?? '';
  const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim() ?? '';
  return { name, description, body };
}

const _init = parseFrontmatter(initSkill);

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { name: _init.name, description: _init.description, body: _init.body },
];
