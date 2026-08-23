/** Builtin skills registry — invisible to UI; surfaced only through the
 *  load_skill catalog (virtual `builtin:<name>` paths) and resolved
 *  in-memory by runLoadSkill. Scanned project/user skills shadow builtins
 *  on name collisions (see mergeBuiltinSkills). */

import { BUNDLED_SKILLS, SKILLS_BOOTSTRAP } from './prompts';
import type { SkillSummary } from '../tools/tool-context';

export { SKILLS_BOOTSTRAP };

export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
}

export const BUILTIN_SKILLS: BuiltinSkill[] = BUNDLED_SKILLS;

const BY_NAME = new Map(BUILTIN_SKILLS.map((s) => [s.name, s]));

export function getBuiltinSkill(name: string): BuiltinSkill | undefined {
  return BY_NAME.get(name);
}

export function getBuiltinSkillBody(name: string): string | undefined {
  return BY_NAME.get(name)?.body;
}

export function builtinSkillSummaries(): SkillSummary[] {
  return BUILTIN_SKILLS.map((s) => ({ name: s.name, description: s.description, absPath: `builtin:${s.name}` }));
}

/** Append builtin skills after scanned ones — scanned keep their full
 *  catalog lines longer (budget) and win name collisions. Disabled names
 *  filter builtins only; scanned entries are pre-filtered by the caller. */
export function mergeBuiltinSkills(scanned: SkillSummary[], disabled: string[]): SkillSummary[] {
  const disabledSet = new Set(disabled);
  const scannedNames = new Set(scanned.map((s) => s.name));
  const builtins = builtinSkillSummaries().filter(
    (b) => !disabledSet.has(b.name) && !scannedNames.has(b.name),
  );
  return [...scanned, ...builtins];
}
