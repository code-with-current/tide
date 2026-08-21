import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../tide-system-prompt';

describe('buildSystemPrompt injected context', () => {
  it('renders date and env info lines', () => {
    const sp = buildSystemPrompt({
      envInfo: { platform: 'darwin', arch: 'arm64', release: '24.3.0', shell: '/bin/zsh' },
    });
    expect(sp).toContain('- Date: ');
    expect(sp).toContain('- Platform: darwin arm64 24.3.0');
    expect(sp).toContain('- Shell (used by the bash tool): /bin/zsh');
  });

  it('renders the git snapshot with counts, staged letters, and recent commits', () => {
    const sp = buildSystemPrompt({
      gitSnapshot: {
        branch: 'main',
        headCommit: 'abc1234567',
        status: [
          { path: 'src/a.ts', status: 'modified', staged: true, additions: 2, deletions: 1 },
          { path: 'notes.txt', status: 'untracked', staged: false, additions: 0, deletions: 0 },
        ],
        log: [{ sha: 'def9876543', author: 'Jane', date: '2025-07-20T10:00:00Z', subject: 'fix widget', parents: [] }],
      },
    });
    expect(sp).toContain('# Git state (at turn start)');
    expect(sp).toContain('- Branch: main @ abc1234');
    expect(sp).toContain('- Working tree: 1 modified, 1 untracked');
    expect(sp).toContain('  - M src/a.ts (+2 −1)');
    expect(sp).toContain('  - ?? notes.txt');
    expect(sp).toContain('  - def9876 fix widget — Jane, 2025-07-20');
  });

  it('omits the git block entirely for a non-repo', () => {
    const sp = buildSystemPrompt({
      gitSnapshot: { branch: null, headCommit: null, status: [], log: [] },
    });
    expect(sp).not.toContain('# Git state');
  });
});
