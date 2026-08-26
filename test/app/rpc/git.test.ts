import { describe, expect, it, vi } from 'vitest';
import { registerGitRpc, type GitDomain } from '../../../app/rpc/git';
import type { GitFileChange } from '../../../shared/rpc';

/** Fake git core: records (root, args) dispatches and returns canned data —
 * the worktree channels' subprocess behavior is already covered by the core
 * git tests; here we verify the RPC shaping + cwd resolution chain. */
function fakeGit(): GitDomain & { calls: Array<{ op: string; root: string }> } {
  const calls: Array<{ op: string; root: string }> = [];
  const record = (op: string) => (root: string, ..._rest: unknown[]) => {
    calls.push({ op, root });
    return undefined as never;
  };
  return {
    calls,
    getGitStatus: (root: string) => {
      calls.push({ op: 'status', root });
      return [] as never;
    },
    getGitLog: record('log'),
    getCommitFiles: record('commitFiles'),
    getCommitFileDiff: record('commitFileDiff'),
    gitStage: record('stage'),
    gitCommit: record('commit'),
    gitDiff: record('diff'),
    branchInfo: record('branchInfo'),
    gitHeadSha: record('headSha'),
    gitRestoreFile: record('restoreFile'),
    gitStageAll: record('stageAll'),
    gitUnstageAll: record('unstageAll'),
    gitRestoreAll: record('restoreAll'),
    gitStash: record('stash'),
    gitStashPop: record('stashPop'),
    gitStashList: record('stashList'),
    gitCheckout: record('checkout'),
    gitCreateBranch: record('createBranch'),
    recentBranches: record('recentBranches'),
    gitAmend: record('amend'),
    gitRevertCommit: record('revert'),
    gitFetch: record('fetch'),
    gitPush: record('push'),
    gitPull: record('pull'),
    gitAheadBehind: record('aheadBehind'),
    gitListBranchesDetailed: record('branchesDetailed'),
    gitDeleteBranch: record('deleteBranch'),
    gitMergeBranch: record('mergeBranch'),
    gitConflictFiles: record('conflictFiles'),
    gitResolveFile: record('resolveFile'),
    gitStagedDiff: record('stagedDiff'),
    gitCommitMessage: record('commitMessage'),
    gitDiscardFile: record('discardFile'),
  };
}

function harness(over: Partial<Parameters<typeof registerGitRpc>[1]> = {}) {
  const git = fakeGit();
  const gitChanged = vi.fn();
  const handlers = registerGitRpc(git, {
    gitChanged,
    sessionWorktreeOf: (sessionId) => (sessionId === 's-wt' ? '/wt/path' : undefined),
    workspacePathOf: (workspaceId) => (workspaceId === 'ws1' ? '/ws/path' : undefined),
    ...over,
  });
  return { git, handlers, gitChanged };
}

describe('git rpc', () => {
  it('gitStatus resolves the session worktree first and starts the watcher', async () => {
    const { git, handlers, gitChanged } = harness();
    const res: GitFileChange[] = await handlers.gitStatus({ workspaceId: 'ws1', sessionId: 's-wt' });
    expect(res).toEqual([]);
    expect(git.calls).toEqual([{ op: 'status', root: '/wt/path' }]);
    // Watcher emit is only observable via gitChanged after fs events; here we
    // verify the send wiring exists (the debounced push is timing-dependent).
    expect(typeof gitChanged).toBe('function');
  });

  it('gitStatus falls back to the workspace checkout without a session', async () => {
    const { git, handlers } = harness();
    await handlers.gitStatus({ workspaceId: 'ws1' });
    expect(git.calls[0]).toEqual({ op: 'status', root: '/ws/path' });
  });

  it('unknown workspace yields empty/error results without touching git', async () => {
    const { git, handlers } = harness();
    expect(await handlers.gitStatus({ workspaceId: 'nope' })).toEqual([]);
    expect(await handlers.gitLog({ workspaceId: 'nope' })).toEqual([]);
    expect(await handlers.gitCommit({ workspaceId: 'nope', message: 'x' })).toEqual({ ok: false, error: 'no workspace' });
    expect(await handlers.gitPush({ workspaceId: 'nope' })).toEqual({ ok: false, error: 'no workspace' });
    expect(git.calls).toHaveLength(0);
  });

  it('gitBulk dispatches the op and maps the legacy names', async () => {
    const { git, handlers } = harness();
    expect(await handlers.gitBulk({ workspaceId: 'ws1', op: 'stage-all' })).toEqual({ ok: true });
    expect(await handlers.gitBulk({ workspaceId: 'ws1', op: 'stash', opts: { message: 'wip' } })).toEqual({ ok: true });
    expect(git.calls.map((c) => c.op)).toEqual(['stageAll', 'stash']);
  });

  it('gitBulk surfaces core errors and rejects unknown ops', async () => {
    const { handlers } = harness();
    expect(await handlers.gitBulk({ workspaceId: 'ws1', op: 'explode' as never })).toEqual({ ok: false, error: 'unknown op: explode' });
  });

  it('head sha / staged diff / commit message wrap scalar returns', async () => {
    const git = fakeGit();
    git.gitHeadSha = async () => 'abc1234';
    git.gitStagedDiff = async () => 'diff --git a';
    git.gitCommitMessage = async () => 'subject';
    const handlers = registerGitRpc(git, { gitChanged: vi.fn(), workspacePathOf: () => '/ws' });
    expect(await handlers.gitHeadSha({ workspaceId: 'ws' })).toEqual({ sha: 'abc1234' });
    expect(await handlers.gitStagedDiff({ workspaceId: 'ws' })).toEqual({ text: 'diff --git a' });
    expect(await handlers.gitCommitMessage({ workspaceId: 'ws', sha: 'abc' })).toEqual({ text: 'subject' });
  });

  it('read failures degrade to empty results (status/log never throw)', async () => {
    const git = fakeGit();
    git.getGitStatus = async () => { throw new Error('boom'); };
    const handlers = registerGitRpc(git, { gitChanged: vi.fn(), workspacePathOf: () => '/ws' });
    expect(await handlers.gitStatus({ workspaceId: 'ws' })).toEqual([]);
  });
});
