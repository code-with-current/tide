import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchRepo, type RepoCloner } from '../../../electron/knowledge/fetchers/repo.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'docs');

let tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyingCloner(): RepoCloner {
  return async (_url, dest) => copyDir(FIXTURES, dest);
}

function copyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

function initFixtureRepo(dir: string): void {
  const git = (args: string[]): void => execFileSync('git', args, { cwd: dir });
  git(['init']);
  git(['add', '-A']);
  git(['-c', 'user.email=tide@test.local', '-c', 'user.name=tide', 'commit', '-m', 'init']);
}

describe('fetchRepo url validation', () => {
  it('rejects non-https, non-git-host, and non owner/repo urls before cloning', async () => {
    await expect(fetchRepo('not a url')).rejects.toThrow(/invalid repo url/);
    await expect(fetchRepo('http://github.com/acme/widgets')).rejects.toThrow(/only https git remotes/);
    await expect(fetchRepo('ssh://git@github.com/acme/widgets')).rejects.toThrow(/only https git remotes/);
    await expect(fetchRepo('https://example.com/acme/widgets')).rejects.toThrow(/unsupported git host/);
    await expect(fetchRepo('https://github.com/acme')).rejects.toThrow(/<owner>\/<repo>/);
    await expect(fetchRepo('https://github.com/')).rejects.toThrow(/<owner>\/<repo>/);
    await expect(fetchRepo('https://github.com/acme/widgets/tree/main')).rejects.toThrow(/<owner>\/<repo>/);
    await expect(fetchRepo('file:///tmp/%zz/repo')).rejects.toThrow(/invalid repo url/);
  });

  it('normalizes https urls to origin+pathname before handing them to the cloner', async () => {
    const seen: string[] = [];
    await expect(
      fetchRepo('https://user:token@github.com/acme/widgets.git?foo=1#readme', {
        cloner: async (url) => {
          seen.push(url);
          throw new Error('stop');
        },
      }),
    ).rejects.toThrow(/stop/);
    expect(seen).toEqual(['https://github.com/acme/widgets.git']);
  });
});

describe('fetchRepo over an injected checkout', () => {
  it('walks the checkout with docs rules and prefixes origins with owner/repo', async () => {
    const docs = await fetchRepo('https://github.com/acme/widgets', { cloner: copyingCloner() });

    expect(docs.map((d) => d.origin).sort()).toEqual([
      'acme/widgets/guide.md',
      'acme/widgets/nested/deep.md',
      'acme/widgets/notes.txt',
    ]);
    expect(docs.map((d) => d.title).sort()).toEqual(['deep.md', 'guide.md', 'notes.txt']);
    const guide = docs.find((d) => d.origin === 'acme/widgets/guide.md');
    expect(guide?.content).toContain('Guide');
  });

  it('skips non-doc extensions, whitespace-only files, oversized files, and .git entries', async () => {
    const cloner: RepoCloner = async (_url, dest) => {
      copyDir(FIXTURES, dest);
      fs.mkdirSync(path.join(dest, '.git'));
      fs.writeFileSync(path.join(dest, '.git', 'leak.md'), 'internal git metadata');
      fs.writeFileSync(path.join(dest, 'huge.md'), 'x'.repeat(512 * 1024 + 1));
    };
    const docs = await fetchRepo('https://github.com/acme/widgets', { cloner });
    const all = JSON.stringify(docs);
    expect(all).not.toContain('debug.log');
    expect(all).not.toContain('must never be picked up');
    expect(all).not.toContain('internal git metadata');
    expect(all).not.toContain('x'.repeat(1024));
    expect(docs).toHaveLength(3);
  });

  it('removes the clone temp dir after success and after failure', async () => {
    const created: string[] = [];
    let cloner: RepoCloner = async (_url, dest) => {
      created.push(dest);
      copyDir(FIXTURES, dest);
    };
    await fetchRepo('https://github.com/acme/widgets', { cloner });
    expect(created).toHaveLength(1);
    expect(fs.existsSync(created[0])).toBe(false);

    cloner = async (_url, dest) => {
      created.push(dest);
      throw new Error('network down');
    };
    await expect(fetchRepo('https://github.com/acme/widgets', { cloner })).rejects.toThrow();
    expect(created).toHaveLength(2);
    expect(fs.existsSync(created[1])).toBe(false);
  });
});

describe('fetchRepo with the real git cloner', () => {
  it('shallow-clones a local fixture repo via file:// url and maps failures', async () => {
    const repo = tmpDir('tide-repo-fixture-');
    fs.writeFileSync(path.join(repo, 'README.md'), '# widgets\nrepo readme contents');
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, 'docs', 'usage.txt'), 'usage notes');
    initFixtureRepo(repo);

    const slug = `${path.basename(path.dirname(repo))}/${path.basename(repo)}`;
    const docs = await fetchRepo(`file://${repo}`);

    expect(docs.map((d) => d.origin).sort()).toEqual([
      `${slug}/README.md`,
      `${slug}/docs/usage.txt`,
    ]);
    expect(docs.find((d) => d.origin === `${slug}/README.md`)?.content).toContain('repo readme contents');

    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), 'v2 changes');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=tide@test.local', '-c', 'user.name=tide', 'commit', '-m', 'more'], {
      cwd: repo,
    });

    const again = await fetchRepo(`file://${repo}`);
    expect(again.map((d) => d.origin)).toContain(`${slug}/CHANGELOG.md`);
  });

  it('maps a failed clone to a git clone error carrying stderr', async () => {
    await expect(fetchRepo('file:///nonexistent-tide-owner/nonexistent-tide-repo-xyz')).rejects.toThrow(
      /git clone failed for file:\/\/\/nonexistent-tide-owner\/nonexistent-tide-repo-xyz/,
    );
  });
});
