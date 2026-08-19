import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { primaryArg, parseRule, evaluateRules } from '../agent/permissions/rules.js';
import { createGitRepoTool } from '../agent/tools/git-repo.js';
import type { ToolContext } from '../agent/tools/tool-context.js';

describe('git_repo permission rules', () => {
  it('primaryArg uses the repo url/path', () => {
    expect(primaryArg('git_repo', { op: 'read', repo: 'https://github.com/o/r' })).toBe('https://github.com/o/r');
  });

  it('a deny rule with a repo glob blocks matching repos only', () => {
    const rules = { allow: [], deny: [parseRule('git_repo(/private/*)')!] };
    expect(evaluateRules(rules, 'git_repo', { op: 'read', repo: '/private/other' })).toBe('deny');
    expect(evaluateRules(rules, 'git_repo', { op: 'read', repo: 'https://github.com/o/r' })).toBe(null);
  });
});

describe('git_repo local-path containment', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function ctxFor(root: string): ToolContext {
    return {
      sessionId: 'test-session',
      workspaceRoot: root,
      workspaceId: 'ws_test',
      autonomyMode: 'full',
    } as unknown as ToolContext;
  }

  it('rejects a local repo outside the workspace root', async () => {
    const outside = path.join(os.tmpdir(), `tide-outside-${Date.now()}`);
    const t = createGitRepoTool(ctxFor(dir));
    const r = (await t.execute({ op: 'info', repo: outside }, {} as never)) as unknown as { status: string; output: string };
    expect(r.status).toBe('failed');
    expect(r.output).toContain('outside the workspace root');
  });

  it('fails cleanly for an in-workspace path that is not a git repository', async () => {
    const t = createGitRepoTool(ctxFor(dir));
    const r = (await t.execute({ op: 'info', repo: dir }, {} as never)) as unknown as { status: string; output: string };
    expect(r.status).toBe('failed');
  });
});
