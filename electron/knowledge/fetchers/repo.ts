/** Repo fetcher: validates a git remote URL, shallow-clones it into a private
 *  temp dir (`git clone --depth 1`, spawn shell:false like the git IPC layer),
 *  reads doc-shaped files from the checkout via the docs walker, then deletes
 *  the temp dir — every fetch is self-cleaning, so neither the manager nor
 *  source removal needs checkout-dir bookkeeping. Origins are
 *  `owner/repo/<relpath>` so memory hits read like paths. The cloner is
 *  injectable for network-free tests. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toolEnv } from '../../agent/tools/tool-env.js';
import { fetchDocs } from './docs.js';
import type { SourceDocument } from '../types.js';

const CLONE_TIMEOUT_MS = 120_000;
const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

export type RepoCloner = (repoUrl: string, destDir: string) => Promise<void>;

export interface FetchRepoOptions {
  cloner?: RepoCloner;
}

export async function fetchRepo(repoUrl: string, opts: FetchRepoOptions = {}): Promise<SourceDocument[]> {
  const { url, slug } = parseRepoUrl(repoUrl);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-repo-'));
  try {
    await (opts.cloner ?? defaultCloner)(url, dest);
    const base = fs.realpathSync(dest);
    const docs = await fetchDocs(base, { allowedRoots: [base] });
    return docs
      .map((doc) => ({
        title: doc.title,
        content: doc.content,
        origin: repoOrigin(slug, base, doc.origin),
      }))
      .filter((doc) => !doc.origin.split('/').includes('.git'));
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

function repoOrigin(slug: string, base: string, absFile: string): string {
  const rel = path.relative(base, absFile).split(path.sep).join('/');
  return `${slug}/${rel}`;
}

/** Accepts https remotes on known git hosts pointing at <owner>/<repo>, plus
 *  file:// remotes (local fixture repos). Everything else — plain web pages,
 *  ssh/ftp schemes, bare hosts — is rejected before any process spawns. */
function parseRepoUrl(raw: string): { url: string; slug: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid repo url: ${raw}`);
  }
  if (u.protocol === 'file:') {
    const segs = safeDecode(u.pathname).split('/').filter(Boolean);
    if (segs.length < 2) throw new Error(`invalid repo url: ${raw}`);
    return { url: raw, slug: `${segs[segs.length - 2]}/${trimGitSuffix(segs[segs.length - 1])}` };
  }
  if (u.protocol !== 'https:') {
    throw new Error(`unsupported repo url '${raw}': only https git remotes are allowed`);
  }
  if (!GIT_HOSTS.has(u.hostname)) {
    throw new Error(`unsupported git host '${u.hostname}': expected one of ${[...GIT_HOSTS].join(', ')}`);
  }
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length !== 2) {
    throw new Error(`unsupported repo url '${raw}': expected <owner>/<repo> path`);
  }
  // origin+pathname drops any embedded credentials and fragment.
  return { url: `${u.origin}${u.pathname}`, slug: `${segs[0]}/${trimGitSuffix(segs[segs.length - 1])}` };
}

function trimGitSuffix(name: string): string {
  return name.replace(/\.git$/, '');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`invalid repo url: malformed percent-encoding '${value}'`);
  }
}

async function defaultCloner(repoUrl: string, destDir: string): Promise<void> {
  try {
    await runGit(['clone', '--depth', '1', '--single-branch', repoUrl, destDir]);
  } catch (e) {
    throw new Error(`git clone failed for ${repoUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: toolEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      reject(new Error(`timed out after ${CLONE_TIMEOUT_MS}ms`));
    }, CLONE_TIMEOUT_MS);
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 65_536) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git exit ${code}`));
    });
  });
}
