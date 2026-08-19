/** git_repo tool: read-only access to any git repository — remote URL or local path.
 * Remote github.com/gitlab.com URLs take a REST fast path (raw CDN + API);
 * every REST failure, plus all other remotes and local paths, fall back to a
 * cached blob-filtered bare clone queried via git plumbing. Nothing is ever
 * checked out into the workspace. */

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { tool } from 'ai';
import { z } from 'zod';
import { toolEnv } from './tool-env';
import type { ToolResult, ToolRegistration } from './types';
import type { ToolContext } from './tool-context';
import { withPermission } from '../permission-wrapper';
import { resolveInsideWorkspace } from '../path-safety.js';

const execFileP = promisify(execFile);
const MAX_BUFFER = 50 * 1024 * 1024; // 50 MB — ref logs and trees can be large
const MAX_OUTPUT = 512 * 1024; // 512 KB returned to the model
const CLONE_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 30_000;
const REST_TIMEOUT_MS = 15_000;
const CACHE_DIR = path.join(os.tmpdir(), 'tide-git-repo-cache');
const MAX_CACHE_ENTRIES = 10;

const OPS = ['info', 'branches', 'files', 'read', 'log', 'show', 'blame', 'search'] as const;
type Op = (typeof OPS)[number];

/** Refs are passed to git as argv entries; charset check blocks flag smuggling. */
const SAFE_REF = /^[A-Za-z0-9._\/@\-]{1,128}$/;

function validateRef(ref: string): string | null {
  if (!ref || ref.startsWith('-') || ref.includes('..') || ref.includes(' ') || !SAFE_REF.test(ref)) {
    return null;
  }
  return ref;
}

function validatePathArg(p: string | undefined): string | null {
  if (p === undefined) return '';
  if (p === '' || p.startsWith('-') || p.includes('\0')) return null;
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (norm.split('/').includes('..')) return null;
  return norm.replace(/^\/+/, '');
}

interface RemoteTarget {
  host: string;
  owner: string;
  repo: string;
  url: string;
}

function parseRemote(repo: string): RemoteTarget | null {
  let m = repo.match(/^https:\/\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/);
  if (!m) m = repo.match(/^git@([^:]+):([^\/]+)\/([^\/]+?)(?:\.git)?$/);
  if (!m) m = repo.match(/^ssh:\/\/git@([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
  if (!m) return null;
  return { host: m[1].toLowerCase(), owner: m[2], repo: m[3], url: repo };
}

function isRemoteRepo(repo: string): boolean {
  return /^(https:\/\/|git@|ssh:\/\/git@)/.test(repo);
}

// ─── REST fast path (github.com / gitlab.com) ─────────────────────────

const pinnedRefs = new Map<string, string>(); // `${url}#${ref}` → commit sha, session-scoped

async function apiGet(url: string, headers: Record<string, string> = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Tide/1.0 (coding agent)', Accept: 'application/vnd.github+json', ...headers },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function rawGet(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Tide/1.0 (coding agent)' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function clip(text: string, label: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n[truncated at ${MAX_OUTPUT.toLocaleString()} chars — ${label}]`;
}

class RestError extends Error {}

/** Resolve a ref (branch/tag/sha) to a commit sha via REST, honoring the session pin. */
async function restResolveSha(t: RemoteTarget, ref: string): Promise<string> {
  const key = `${t.url}#${ref}`;
  const pinned = pinnedRefs.get(key);
  if (pinned) return pinned;
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  let sha: string | null = null;
  if (t.host === 'github.com') {
    const j = await apiGet(`https://api.github.com/repos/${t.owner}/${t.repo}/commits/${encodeURIComponent(ref)}`);
    sha = j?.sha ?? null;
  } else {
    const proj = encodeURIComponent(`${t.owner}/${t.repo}`);
    const j = await apiGet(`https://gitlab.com/api/v4/projects/${proj}/repository/commits/${encodeURIComponent(ref)}`);
    sha = j?.id ?? null;
  }
  if (!sha) throw new RestError(`could not resolve ref '${ref}'`);
  pinnedRefs.set(key, sha);
  return sha;
}

/** Run one op over REST. Throws RestError on any failure — the caller falls back to clone. */
async function restOp(op: Op, t: RemoteTarget, args: {
  ref?: string; commit?: string; file?: string; limit?: number; query?: string; regex?: boolean; base?: string;
}): Promise<ToolResult> {
  const ref = args.ref ?? 'HEAD';
  const gh = `https://api.github.com/repos/${t.owner}/${t.repo}`;
  const glProj = encodeURIComponent(`${t.owner}/${t.repo}`);
  const gl = `https://gitlab.com/api/v4/projects/${glProj}/repository`;

  switch (op) {
    case 'info': {
      const j = t.host === 'github.com'
        ? await apiGet(gh)
        : await apiGet(`https://gitlab.com/api/v4/projects/${glProj}`);
      const lines = t.host === 'github.com'
        ? [
            `repo: ${j.full_name}`,
            `default_branch: ${j.default_branch}`,
            `description: ${j.description ?? ''}`,
            `stars: ${j.stargazers_count} · forks: ${j.forks_count}`,
            `pushed_at: ${j.pushed_at}`,
          ]
        : [
            `repo: ${j.path_with_namespace}`,
            `default_branch: ${j.default_branch}`,
            `description: ${j.description ?? ''}`,
            `stars: ${j.star_count} · forks: ${j.forks_count}`,
            `last_activity_at: ${j.last_activity_at}`,
          ];
      return { status: 'executed', output: lines.join('\n'), meta: `rest · ${t.host}` };
    }
    case 'branches': {
      if (t.host === 'github.com') {
        const j = await apiGet(`${gh}/branches?per_page=100`);
        return { status: 'executed', output: clip(j.map((b: any) => `${b.name}${b.protected ? ' (protected)' : ''}`).join('\n'), 'branch list'), meta: 'rest · github' };
      }
      const j = await apiGet(`${gl}/branches?per_page=100`);
      return { status: 'executed', output: clip(j.map((b: any) => b.name).join('\n'), 'branch list'), meta: 'rest · gitlab' };
    }
    case 'files': {
      const sha = await restResolveSha(t, ref);
      if (t.host === 'github.com') {
        const j = await apiGet(`${gh}/git/trees/${sha}?recursive=1`);
        const filter = args.file ? args.file.replace(/\/$/, '') + '/' : '';
        const names = j.tree
          .filter((e: any) => e.type === 'blob' && (!filter || e.path.startsWith(filter)))
          .map((e: any) => e.path);
        const trunc = j.truncated ? '\n[listing truncated by the API — large repo; scope with a file prefix]' : '';
        return { status: 'executed', output: clip(names.join('\n') + trunc || '(no files)', 'file list'), meta: `rest · ${names.length} files` };
      }
      const j = await apiGet(`${gl}/tree?ref=${encodeURIComponent(sha)}&recursive=true&per_page=100`);
      const filter = args.file ? args.file.replace(/\/$/, '') + '/' : '';
      const names = j
        .filter((e: any) => e.type === 'blob' && (!filter || e.path.startsWith(filter)))
        .map((e: any) => e.path);
      const trunc = j.length >= 100 ? '\n[listing capped at the first 100 entries — scope with a file prefix]' : '';
      return { status: 'executed', output: clip(names.join('\n') + trunc || '(no files)', 'file list'), meta: `rest · ${names.length} files` };
    }
    case 'read': {
      const clean = validatePathArg(args.file ?? '');
      if (clean === null || clean === '') throw new RestError('read requires a file path');
      if (t.host === 'github.com') {
        const text = await rawGet(`https://raw.githubusercontent.com/${t.owner}/${t.repo}/${encodeURIComponent(ref)}/${clean.split('/').map(encodeURIComponent).join('/')}`);
        return { status: 'executed', output: clip(text, 'file contents'), meta: `rest · ${text.length.toLocaleString()} chars` };
      }
      const text = await rawGet(`https://gitlab.com/${t.owner}/${t.repo}/raw/${encodeURIComponent(ref)}/${clean.split('/').map(encodeURIComponent).join('/')}`);
      return { status: 'executed', output: clip(text, 'file contents'), meta: `rest · ${text.length.toLocaleString()} chars` };
    }
    case 'log': {
      const n = Math.min(args.limit ?? 30, 100);
      if (t.host === 'github.com') {
        let u = `${gh}/commits?per_page=${n}`;
        if (args.ref && args.ref !== 'HEAD') u += `&sha=${encodeURIComponent(args.ref)}`;
        if (args.file) u += `&path=${encodeURIComponent(args.file)}`;
        const j = await apiGet(u);
        const out = j.map((c: any) =>
          `${c.sha.slice(0, 10)} ${c.commit.author.date} ${c.commit.author.name}\n  ${c.commit.message.split('\n')[0]}`,
        ).join('\n');
        return { status: 'executed', output: clip(out || '(no commits)', 'log'), meta: `rest · ${j.length} commits` };
      }
      let u = `${gl}/commits?per_page=${n}`;
      if (args.ref && args.ref !== 'HEAD') u += `&ref_name=${encodeURIComponent(args.ref)}`;
      if (args.file) u += `&path=${encodeURIComponent(args.file)}`;
      const j = await apiGet(u);
      const out = j.map((c: any) =>
        `${c.id.slice(0, 10)} ${c.committed_date} ${c.author_name}\n  ${c.title}`,
      ).join('\n');
      return { status: 'executed', output: clip(out || '(no commits)', 'log'), meta: `rest · ${j.length} commits` };
    }
    case 'show': {
      const commit = args.commit ?? args.base;
      if (!commit) throw new RestError('show requires a commit or base..head range');
      if (t.host === 'github.com') {
        const j = await apiGet(`${gh}/commits/${encodeURIComponent(commit)}`);
        const files = j.files?.map((f: any) =>
          `${f.status.padEnd(10)} ${f.changes} ${f.filename}\n${(f.patch ?? '').split('\n').map((l: string) => '  ' + l).join('\n')}`,
        ).join('\n\n');
        const head = `${j.sha}\n${j.commit.author.name} · ${j.commit.author.date}\n\n${j.commit.message}\n`;
        return { status: 'executed', output: clip(head + '\n' + (files ?? '(no files)'), 'patch'), meta: 'rest · github' };
      }
      const j = await apiGet(`${gl}/commits/${encodeURIComponent(commit)}/diff`);
      const out = j.map((d: any) => `${d.new_path}\n${d.diff}`).join('\n\n');
      return { status: 'executed', output: clip(out || '(empty diff)', 'patch'), meta: 'rest · gitlab' };
    }
    case 'blame': {
      const clean = validatePathArg(args.file ?? '');
      if (clean === null || clean === '') throw new RestError('blame requires a file path');
      if (t.host !== 'gitlab.com') throw new RestError('github blame needs GraphQL+token — falling back to git');
      const sha = await restResolveSha(t, ref);
      const j = await apiGet(`${gl}/blame?ref=${encodeURIComponent(sha)}&filepath=${encodeURIComponent(clean)}`);
        const out = j.map((b: any) => `${(b.commit?.id ?? '').slice(0, 10)} (${b.commit?.author_name}) lines ${b.lines[0]}-${b.lines[b.lines.length - 1]}`).join('\n');
      return { status: 'executed', output: clip(out || '(no blame data)', 'blame'), meta: 'rest · gitlab' };
    }
    case 'search': {
      if (!args.query) throw new RestError('search requires a query');
      if (t.host !== 'github.com') throw new RestError('gitlab code search unavailable via REST — falling back to git');
      const q = encodeURIComponent(`${args.query} repo:${t.owner}/${t.repo}`);
      const j = await apiGet(`https://api.github.com/search/code?q=${q}&per_page=30`);
      const out = (j.items ?? []).map((i: any) => `${i.path}`).join('\n');
      return { status: 'executed', output: clip(out || '(no matches)', 'results'), meta: `rest · ${j.total_count ?? 0} matches` };
    }
  }
}

// ─── Clone backend (any remote, local paths) ──────────────────────────

/** Run git argv with cwd/timeout; non-zero exit returns code + captured output so callers can decide. */
async function gitRun(argv: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('git', argv, {
      cwd,
      env: toolEnv({ GIT_TERMINAL_PROMPT: '0' }),
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return { code: 0, out: stdout + (stderr ? `\n[stderr]\n${stderr}` : '') };
  } catch (e: any) {
    if (e.killed || e.code === 'ETIMEDOUT') throw new Error(`git timed out after ${timeoutMs}ms`);
    const out = `${e.stdout ?? ''}${e.stderr ? `\n[stderr]\n${e.stderr}` : ''}`;
    return { code: typeof e.code === 'number' ? e.code : 1, out: out || (e.message ?? String(e)) };
  }
}

/** Bare blob-filtered clone cache: <tmp>/tide-git-repo-cache/<sha16(url)>.
 * LRU-evicts beyond MAX_CACHE_ENTRIES by dir mtime. */
async function cloneDirFor(url: string): Promise<string> {
  const dir = path.join(CACHE_DIR, createHash('sha1').update(url).digest('hex').slice(0, 16));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    evictCache();
    const clone = await gitRun(['clone', '--bare', '--filter=blob:none', '--no-checkout', url, dir], CACHE_DIR, CLONE_TIMEOUT_MS);
    if (clone.code !== 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`clone failed: ${clone.out.trim().split('\n').pop()}`);
    }
  } else {
    try {
      await gitRun(['fetch', '--all', '--prune'], dir, FETCH_TIMEOUT_MS);
    } catch {
      // stale cache is better than failing the op — ref may have moved
    }
    fs.utimesSync(dir, new Date(), new Date());
  }
  return dir;
}

/** Best-effort LRU eviction of the clone cache (mtime order, keep newest MAX_CACHE_ENTRIES). */
function evictCache(): void {
  try {
    const entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const p = path.join(CACHE_DIR, d.name);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(MAX_CACHE_ENTRIES)) fs.rmSync(e.p, { recursive: true, force: true });
  } catch { /* cache dir may not exist yet */ }
}

async function cloneOp(op: Op, repo: string, args: {
  ref?: string; commit?: string; file?: string; limit?: number; query?: string; regex?: boolean; base?: string;
}): Promise<ToolResult> {
  const isLocal = !isRemoteRepo(repo);
  const cwd = isLocal
    ? path.resolve(repo)
    : await cloneDirFor(repo);
  if (isLocal && !fs.existsSync(path.join(cwd, '.git')) && !fs.existsSync(path.join(cwd, 'HEAD'))) {
    return { status: 'failed', output: `Not a git repository: ${repo}` };
  }

  const ref = args.ref ?? 'HEAD';
  const vref = validateRef(ref);
  if (!vref) return { status: 'failed', output: `Invalid ref: ${ref}` };
  const vfile = validatePathArg(args.file);
  if (vfile === null) return { status: 'failed', output: `Invalid path: ${args.file}` };
  const limit = Math.min(Math.max(args.limit ?? 30, 1), 200);

  let argv: string[];
  let noMatchIsOk = false;
  switch (op) {
    case 'info':
      argv = ['log', '-1', '--format=%H%n%an <%ae>%n%aI%n%s', vref];
      break;
    case 'branches':
      argv = ['for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/heads', 'refs/remotes', 'refs/tags'];
      break;
    case 'files':
      argv = ['ls-tree', '-r', '--name-only', vref, ...(vfile ? ['--', vfile] : [])];
      break;
    case 'read': {
      if (!vfile) return { status: 'failed', output: 'read requires a file path' };
      const r = await gitRun(['show', `${vref}:${vfile}`], cwd, FETCH_TIMEOUT_MS);
      return { status: 'executed', output: clip(r.out, 'file contents'), meta: `git · ${r.out.length.toLocaleString()} chars` };
    }
    case 'log':
      argv = ['log', `-n${limit}`, '--format=%h %aI %an%n  %s', vref, ...(vfile ? ['--', vfile] : [])];
      break;
    case 'show': {
      const target = args.commit ?? vref;
      const vt = validateRef(target.split('..').join(''));
      if (!vt) return { status: 'failed', output: `Invalid commit/range: ${target}` };
      argv = ['show', '--no-color', '--no-ext-diff', target, ...(vfile ? ['--', vfile] : [])];
      break;
    }
    case 'blame': {
      if (!vfile) return { status: 'failed', output: 'blame requires a file path' };
      argv = ['blame', '--line-porcelain', vref, '--', vfile];
      break;
    }
    case 'search': {
      if (!args.query) return { status: 'failed', output: 'search requires a query' };
      argv = ['grep', '-n', args.regex ? '-E' : '-F', '--', args.query, vref];
      noMatchIsOk = true; // git grep exits 1 on zero matches
      break;
    }
  }

  const r = await gitRun(argv, cwd, FETCH_TIMEOUT_MS);
  if (r.code !== 0 && !noMatchIsOk) {
    return { status: 'failed', output: `git ${argv[0]} failed (exit ${r.code}): ${r.out.trim().slice(0, 2000)}` };
  }
  if (!r.out.trim() && noMatchIsOk) {
    return { status: 'executed', output: '(no matches)', meta: 'git · 0 matches' };
  }
  const out = op === 'blame' ? condenseBlame(r.out) : r.out;
  return {
    status: 'executed',
    output: clip(out || '(no output)', op),
    meta: `git · ${isLocal ? 'local' : 'clone'}`,
  };
}

/** --line-porcelain → one `sha (author date) line-text` entry per line. */
function condenseBlame(porcelain: string): string {
  const out: string[] = [];
  let cur: { sha: string; author: string; date: string } | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('\t')) {
      out.push(`${cur?.sha.slice(0, 10) ?? '?'} (${cur?.author ?? '?'} ${cur?.date ?? '?'}) ${line.slice(1)}`);
    } else if (line.startsWith('author ')) cur &&= { ...cur, author: line.slice(7) };
    else if (line.startsWith('author-time ')) {
      const d = new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10);
      cur &&= { ...cur, date: d };
    } else if (/^[0-9a-f]{40} \d+ \d+ \d+$/.test(line)) {
      cur = { sha: line.slice(0, 40), author: '', date: '' };
    }
  }
  return out.join('\n');
}

// ─── Dispatch: REST fast path → clone fallback ────────────────────────

async function runGitRepo(args: {
  op: string; repo: string; ref?: string; commit?: string; file?: string;
  limit?: number; query?: string; regex?: boolean;
}, workspaceRoot?: string): Promise<ToolResult> {
  if (!args.repo) return { status: 'failed', output: 'Missing required arg: repo' };
  const op = args.op as Op;
  if (!OPS.includes(op)) {
    return { status: 'failed', output: `Invalid op '${args.op}'. Valid: ${OPS.join(', ')}` };
  }

  // Local repos are sandboxed to the workspace root — same boundary
  // read_file enforces. Without it, `git show ref:file` would read any
  // tracked file on disk, auto-approved in every mode. Remote URLs are
  // unrestricted.
  if (!isRemoteRepo(args.repo)) {
    if (!workspaceRoot) {
      return { status: 'failed', output: 'Local repository access requires a workspace context. Use a remote URL instead.' };
    }
    try {
      resolveInsideWorkspace(workspaceRoot, args.repo);
    } catch {
      return {
        status: 'failed',
        output: `Local repository "${args.repo}" resolves outside the workspace root — git_repo only reads local repos inside the current workspace (remote URLs are unrestricted).`,
      };
    }
  }

  const remote = isRemoteRepo(args.repo) ? parseRemote(args.repo) : null;
  if (isRemoteRepo(args.repo) && !remote) {
    return { status: 'failed', output: `Unrecognized remote URL: ${args.repo}` };
  }

  if (remote && (remote.host === 'github.com' || remote.host === 'gitlab.com')) {
    try {
      return await restOp(op, remote, args);
    } catch (e: any) {
      const reason = e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'error');
      try {
        const r = await cloneOp(op, args.repo, args);
        return { ...r, meta: `${r.meta ?? ''} · rest fallback (${reason})`.trim() };
      } catch (e2: any) {
        return { status: 'failed', output: `REST failed (${reason}); clone fallback failed: ${e2?.message ?? e2}` };
      }
    }
  }

  try {
    return await cloneOp(op, args.repo, args);
  } catch (e: any) {
    return { status: 'failed', output: `git_repo ${op} failed: ${e?.message ?? e}` };
  }
}

const DESCRIPTION =
`Read a git repository — remote URL (https://, git@, ssh://) or local path — without cloning into the workspace. Read-only. One op per call:
- info: default branch, HEAD commit
- branches: local/remote branches and tags
- files: recursive file listing at a ref (optionally scoped to a path prefix)
- read: single file contents at a ref
- log: commit history (optionally path-scoped)
- show: a commit's patch, or diff a base..head range
- blame: per-line authorship of a file
- search: literal or regex content search across the repo at a ref
Prefer this over cloning via bash.`;

const zArgs = {
  op: z.enum(OPS).describe('Operation to run'),
  repo: z.string().describe('Remote URL (https://github.com/o/r, git@host:o/r) or local repo path'),
  ref: z.string().optional().describe('Branch, tag, or sha (default HEAD)'),
  commit: z.string().optional().describe('Commit sha for show'),
  file: z.string().optional().describe('File path for read/blame, path prefix for files, path filter for log'),
  limit: z.number().optional().describe('Max commits for log (default 30)'),
  query: z.string().optional().describe('Search string for search'),
  regex: z.boolean().optional().describe('Treat query as a POSIX regex (default literal)'),
};

export const gitRepoTool: ToolRegistration = {
  name: 'git_repo',
  definition: {
    name: 'git_repo',
    description: DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...OPS], description: 'Operation to run' },
        repo: { type: 'string', description: 'Remote URL or local repo path' },
        ref: { type: 'string', description: 'Branch/tag/sha (default HEAD)' },
        commit: { type: 'string', description: 'Commit sha for show' },
        file: { type: 'string', description: 'File path / prefix / filter' },
        limit: { type: 'number', description: 'Max commits for log' },
        query: { type: 'string', description: 'Search string' },
        regex: { type: 'boolean', description: 'Query is a regex' },
      },
      required: ['op', 'repo'],
    },
  },
  riskTier: 'read_only',
  requiresWorktree: false,
  timeoutMs: 120_000,
  autoApproveIn: ['plan', 'ask', 'edit', 'full'],
  execute: async (args, ctx) => runGitRepo(args as any, ctx?.workspaceRoot),
};

export function createGitRepoTool(ctx: ToolContext) {
  return tool({
    description: DESCRIPTION,
    inputSchema: z.object(zArgs),
    execute: async (args) =>
      withPermission(ctx, 'git_repo', args, () =>
        runGitRepo(args as any, ctx.workspaceRoot),
      ),
  });
}
