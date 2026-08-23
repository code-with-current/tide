import { describe, expect, it } from 'vitest';
import { allowRuleLabel, deriveAllowRule } from '@/lib/permission-label';

const call = (over: Record<string, unknown>) => over as any;

describe('deriveAllowRule (prefers the event-carried spec, falls back to args)', () => {
  it('uses allowRule verbatim when present', () => {
    expect(deriveAllowRule(call({ toolName: 'bash', allowRule: 'bash(cat)' }))).toBe('bash(cat)');
  });

  it('derives bash from the command arg — first token', () => {
    expect(deriveAllowRule(call({ toolName: 'bash', arguments: { command: 'cat src/a.ts' }, argPreview: 'cat src/a.ts' }))).toBe('bash(cat)');
  });

  it('derives bash from argPreview when args lack command', () => {
    expect(deriveAllowRule(call({ toolName: 'bash', arguments: {}, argPreview: 'git push origin main' }))).toBe('bash(git)');
  });

  it('derives git subcommand from args array, then preview', () => {
    expect(deriveAllowRule(call({ toolName: 'git', arguments: { args: ['push', 'origin'] } }))).toBe('git(push)');
    expect(deriveAllowRule(call({ toolName: 'git', arguments: {}, argPreview: 'checkout -b feat' }))).toBe('git(checkout)');
  });

  it('derives file tools to a directory glob', () => {
    expect(deriveAllowRule(call({ toolName: 'edit_file', argPreview: 'src/lib/utils.ts' }))).toBe('edit_file(src/lib/*)');
  });

  it('bare tool when nothing recognizable', () => {
    expect(deriveAllowRule(call({ toolName: 'bash', arguments: {}, argPreview: '' }))).toBe('bash');
  });
});

describe('allowRuleLabel', () => {
  it('bash single command → "cmd *"', () => {
    expect(allowRuleLabel(call({ toolName: 'bash', allowRule: 'bash(cat)' }))).toBe('cat *');
    expect(allowRuleLabel(call({ toolName: 'bash', arguments: { command: 'rm -rf node_modules' } }))).toBe('rm *');
  });

  it('bash glob rules stay verbatim', () => {
    expect(allowRuleLabel(call({ toolName: 'bash', allowRule: 'bash(npx cowsay:*)' }))).toBe('npx cowsay:*');
  });

  it('git keeps its verb: "git push *"', () => {
    expect(allowRuleLabel(call({ toolName: 'git', allowRule: 'git(push origin main)' }))).toBe('git push *');
    expect(allowRuleLabel(call({ toolName: 'git', arguments: { args: ['checkout'] } }))).toBe('git checkout *');
  });

  it('file globs verbatim, arg rules get " *"', () => {
    expect(allowRuleLabel(call({ toolName: 'edit_file', allowRule: 'edit_file(src/lib/*)' }))).toBe('src/lib/*');
    expect(allowRuleLabel(call({ toolName: 'grep', allowRule: 'grep(TODO)' }))).toBe('TODO *');
  });

  it('bare tool rule → "tool *"', () => {
    expect(allowRuleLabel(call({ toolName: 'bash', allowRule: 'bash' }))).toBe('bash *');
    expect(allowRuleLabel(call({ toolName: 'git', allowRule: 'git' }))).toBe('git *');
  });
});
