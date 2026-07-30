// Regression test for Windows skill loading (USER~1 short-path bug).
//
// Bug: resolveUnderSkillRoot compared os.homedir() (long path:
// C:\Users\fahry.firmansyah) against fs.realpathSync output (8.3 short
// path: C:\Users\FAHRY~1\.claude). path.relative() between mismatched
// forms returned a ".." prefix → valid ~/.claude skills were rejected.
//
// We can't run the real resolveUnderSkillRoot on a non-Windows host and
// get win32 path semantics (the `path` module is host-OS-specific), so
// this test exercises the FIX's logic directly: resolve home through
// realpathSync (so both sides match) + compare case-insensitively.
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const win = path.win32;

/**
 * The comparison logic from resolveUnderSkillRoot, parameterized by the
 * path module so we can force win32 semantics on any host. Mirrors the
 * fixed code in path-safety.ts exactly.
 */
function skillRootAllows(
  targetReal: string,        // fs.realpathSync(target)
  homeReal: string,          // fs.realpathSync(os.homedir())
  caseInsensitive: boolean,
  sep: path.PlatformPath,
): boolean {
  for (const dir of ['.claude', '.agent', '.zcode']) {
    const root = sep.join(homeReal, dir);
    const rel = sep.relative(root, targetReal);
    const relNorm = caseInsensitive ? rel.toLowerCase() : rel;
    if (relNorm && !relNorm.startsWith('..') && !sep.isAbsolute(rel)) return true;
  }
  return false;
}

describe('skill-root allowlist — Windows short-path robustness', () => {
  it('ALLOWS ~/.claude skill when home(long) and target(short) mismatch', () => {
    // The fix: resolve BOTH through realpath. After realpath, home and
    // target share the same (short) prefix → relative is clean.
    const homeReal = 'C:\\Users\\FAHRY~1';            // realpathSync(homedir)
    const targetReal = 'C:\\Users\\FAHRY~1\\.claude\\skills\\using-superpowers\\SKILL.md';
    expect(skillRootAllows(targetReal, homeReal, true, win)).toBe(true);
  });

  it('REJECTS the bug scenario (long home vs short target, no realpath fix)', () => {
    // This is the OLD behavior that caused the bug — demonstrates why
    // the fix is needed. Mixing forms makes relative() return "..".
    const homeLong = 'C:\\Users\\fahry.firmansyah';
    const targetShort = 'C:\\Users\\FAHRY~1\\.claude\\skills\\using-superpowers\\SKILL.md';
    expect(skillRootAllows(targetShort, homeLong, true, win)).toBe(false);
  });

  it('ALSO works with case differences (Windows is case-insensitive)', () => {
    const homeReal = 'C:\\Users\\Fahry.Firmansyah';
    const targetReal = 'C:\\Users\\fahry.firmansyah\\.claude\\skills\\x\\SKILL.md';
    // After realpath both are the same case form — but even if they
    // differed, caseInsensitive compare should still match the prefix.
    expect(skillRootAllows(targetReal, homeReal, true, win)).toBe(true);
  });

  it('REJECTS arbitrary paths outside the skill roots', () => {
    const homeReal = 'C:\\Users\\FAHRY~1';
    expect(skillRootAllows('C:\\Windows\\System32\\evil.dll', homeReal, true, win)).toBe(false);
    expect(skillRootAllows('D:\\secrets\\.env', homeReal, true, win)).toBe(false);
  });

  it('works on posix too (mac/linux skill roots)', () => {
    const posix = path.posix;
    const homeReal = '/Users/yogi';
    const targetReal = '/Users/yogi/.claude/skills/brainstorming/SKILL.md';
    expect(skillRootAllows(targetReal, homeReal, true, posix)).toBe(true);
  });
});
