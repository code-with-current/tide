import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'child_process';
import { getGitStatus, gitStage, gitCommit } from '../ipc/git';

function initRepo(dir: string) {
  execSync('git init', { cwd: dir });
  execSync('git config user.email test@test.com', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
}

describe('getGitStatus', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-git-'));
    initRepo(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns empty for a clean repo', () => {
    fs.writeFileSync(path.join(dir, 'committed.txt'), 'hello');
    execSync('git add . && git commit -m init', { cwd: dir });
    expect(getGitStatus(dir)).toEqual([]);
  });

  it('detects untracked file', () => {
    fs.writeFileSync(path.join(dir, 'new.txt'), 'content');
    const status = getGitStatus(dir);
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ path: 'new.txt', status: 'untracked', staged: false });
  });

  it('detects modified file with additions and deletions', () => {
    fs.writeFileSync(path.join(dir, 'app.ts'), 'line1\nline2\nline3\n');
    execSync('git add . && git commit -m init', { cwd: dir });
    fs.writeFileSync(path.join(dir, 'app.ts'), 'line1\nCHANGED\nline3\nline4\n');
    const status = getGitStatus(dir);
    expect(status[0]).toMatchObject({ path: 'app.ts', status: 'modified', staged: false });
    expect(status[0].additions).toBeGreaterThanOrEqual(1);
    expect(status[0].deletions).toBeGreaterThanOrEqual(1);
  });

  it('detects staged file', () => {
    fs.writeFileSync(path.join(dir, 'staged.ts'), 'content');
    execSync('git add staged.ts', { cwd: dir });
    const status = getGitStatus(dir);
    expect(status[0]).toMatchObject({ path: 'staged.ts', status: 'added', staged: true });
  });

  it('stage then unstage moves file between sections', () => {
    // Need a commit first so `git restore --staged` has a HEAD to restore to.
    fs.writeFileSync(path.join(dir, 'init.txt'), 'content');
    execSync('git add . && git commit -m init', { cwd: dir });
    fs.writeFileSync(path.join(dir, 'file.ts'), 'content');
    gitStage(dir, 'file.ts', true);
    expect(getGitStatus(dir)[0].staged).toBe(true);
    gitStage(dir, 'file.ts', false);
    expect(getGitStatus(dir)[0].staged).toBe(false);
  });

  it('commit returns sha and clears staged files', () => {
    fs.writeFileSync(path.join(dir, 'file.ts'), 'content');
    gitStage(dir, 'file.ts', true);
    const sha = gitCommit(dir, 'test commit');
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(getGitStatus(dir)).toEqual([]);
  });
});
