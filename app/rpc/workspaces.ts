/** Workspaces RPC — port of the workspace-domain channels from
 *  electron/ipc/handlers.ts (tide:listWorkspaces … tide:workspacesExist, the
 *  add-workspace flow with per-step progress pushes, file tree, workspace
 *  context, sandboxed file reads) plus listBranches/listConfigFiles from the
 *  sessions module. The store surface is injectable so tests run against
 *  temp state; fs paths are resolved through the same expandPath/readDirTree
 *  helpers the Electron shell used. */

import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';
import { syncCoAuthorHook } from '../core/git-coauthor.js';
import { scanProjectEntries } from '../core/agent/project-context.js';
import { TEMPLATES_BY_ID } from '../../src/lib/templates';
import type {
  Workspace,
  WorkspaceAddInput,
  WorkspaceFileReadResult,
  WorkspaceProgressEvent,
} from '../../shared/rpc';
import type { FileNode } from '../../src/types';

const log = createLogger('workspaces-rpc');

/** The core-store surface the handlers touch — satisfied structurally by
 *  app/core/store (production default) and test doubles alike. */
export interface WorkspaceDomain {
  listWorkspaces(): Workspace[];
  addWorkspace(workspace: Workspace): void;
  updateWorkspace(id: string, patch: Partial<Workspace>): void;
  archiveWorkspace(id: string): void;
  unarchiveWorkspace(id: string): void;
  deleteWorkspace(id: string): void;
  getLastSession(): { sessionId: string | null; workspaceId: string | null };
  setLastSession(sessionId: string | null, workspaceId: string | null): void;
}

export interface WorkspacesRpcOpts {
  /** Pushes the add-workspace per-step milestones (clone/folder/…). */
  progress?: (e: WorkspaceProgressEvent) => void;
  /** Session-domain surface for listBranches/listConfigFiles. */
  listBranches?: (workspaceId: string) => Promise<string[]>;
  listConfigFiles?: (workspaceId: string) => string[];
}

/** Expand ~ to the home directory (workspace paths may be stored with one). */
export function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(process.env.HOME || process.env.USERPROFILE || '~', p.slice(2));
  }
  return p;
}

/** Read a directory tree recursively up to maxDepth — the file explorer's
 *  3-level snapshot. VCS/metadata/build noise is skipped. */
export function readDirTree(basePath: string, relativePath: string, maxDepth: number): FileNode[] {
  if (maxDepth < 0) return [];
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.DS_Store') continue;
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') continue;

    const entryRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: entryRelative,
        kind: 'dir',
        expanded: maxDepth > 1,
        children: readDirTree(basePath, entryRelative, maxDepth - 1),
      });
    } else {
      nodes.push({
        name: entry.name,
        path: entryRelative,
        kind: 'file',
      });
    }
  }
  return nodes;
}

/** Detect git info at a path — branch/head/file-count via git CLI. Returns
 *  null when the path isn't a repo (or git fails). */
export async function detectGit(dirPath: string): Promise<{ branch: string; headCommit: string; fileCount: number } | null> {
  try {
    if (!fs.existsSync(path.join(dirPath, '.git'))) return null;
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: dirPath, encoding: 'utf-8', timeout: 5000 });
    const { stdout: headCommit } = await execAsync('git rev-parse --short HEAD', { cwd: dirPath, encoding: 'utf-8', timeout: 5000 });
    const { stdout: fileCountStr } = await execAsync('git ls-files | wc -l', { cwd: dirPath, encoding: 'utf-8', timeout: 5000 });
    return { branch: branch.trim(), headCommit: headCommit.trim(), fileCount: parseInt(fileCountStr.trim(), 10) || 0 };
  } catch {
    return null;
  }
}

export function registerWorkspacesRpc(domain: WorkspaceDomain, opts: WorkspacesRpcOpts = {}) {
  const progress = opts.progress;
  const listBranches = opts.listBranches;
  const listConfigFiles = opts.listConfigFiles;

  const workspaceOf = (workspaceId: string) => domain.listWorkspaces().find((w) => w.id === workspaceId);

  return {
    workspaceList: (_: Record<string, never>) => domain.listWorkspaces(),

    workspaceGet: ({ workspaceId }: { workspaceId: string }) => workspaceOf(workspaceId) ?? null,

    workspaceAdd: async ({ input }: { input: WorkspaceAddInput }) => {
      const template = input.template ? TEMPLATES_BY_ID[input.template as keyof typeof TEMPLATES_BY_ID] : undefined;
      let dirPath = input.path;

      const rid = input.requestId;
      const send = (step: WorkspaceProgressEvent['step'], status: 'active' | 'done' | 'failed', label: string, detail?: string) => {
        if (!rid || !progress) return;
        progress({ requestId: rid, step, status, label, detail });
      };

      if (input.repository && !fs.existsSync(dirPath)) {
        const parentDir = path.dirname(dirPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        send('clone', 'active', 'Cloning repository…', input.repository);
        try {
          execSync(`git clone --depth 1 "${input.repository}" "${dirPath}"`, {
            stdio: 'pipe',
            timeout: 120_000,
          });
        } catch (e) {
          send('clone', 'failed', 'Clone failed');
          throw new Error(`Git clone failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        send('clone', 'done', 'Repository cloned');
      }

      if (!input.repository && !fs.existsSync(dirPath)) {
        send('folder', 'active', 'Creating project folder…');
        try {
          fs.mkdirSync(dirPath, { recursive: true });
          send('folder', 'done', 'Project folder created');
          // Empty/new-project case (no template): init git now since there's
          // no scaffold step coming. Templated projects init after scaffolding.
          if (!template || template.scaffold.length === 0) {
            send('git', 'active', 'Initializing git…');
            execSync('git init --quiet', { cwd: dirPath, stdio: 'pipe', timeout: 10_000 });
            send('git', 'done', 'Git initialized');
          }
        } catch (e) {
          send('folder', 'failed', 'Folder creation failed');
          throw new Error(`Failed to create project directory: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (template && template.scaffold.length > 0 && !input.repository) {
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

        const runStep = (label: string, argv: string[]) => {
          const r = spawnSync(argv[0], argv.slice(1), {
            cwd: dirPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 600_000,
          });
          if (r.status !== 0) {
            const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n');
            throw new Error(`${label} failed (exit ${r.status}):\n${tail}`);
          }
        };

        try {
          send('scaffold', 'active', `Scaffolding ${template.label}…`, template.label);
          runStep('Scaffold', template.scaffold);
          send('scaffold', 'done', `${template.label} scaffolded`, template.label);
          if (template.install) {
            send('install', 'active', 'Installing dependencies…');
            runStep('Install', template.install);
            send('install', 'done', 'Dependencies installed');
          }
        } catch (e) {
          throw new Error(`Template '${template.id}' failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        if (!fs.existsSync(path.join(dirPath, '.git'))) {
          send('git', 'active', 'Initializing git…');
          try {
            execSync('git init --quiet', { cwd: dirPath, stdio: 'pipe', timeout: 10_000 });
            send('git', 'done', 'Git initialized');
          } catch {
            send('git', 'failed', 'Git init skipped');
          }
        }
      }

      if (input.initGit && !input.repository && fs.existsSync(dirPath) && !fs.existsSync(path.join(dirPath, '.git'))) {
        send('git', 'active', 'Initializing git…');
        try {
          execSync('git init --quiet', { cwd: dirPath, stdio: 'pipe', timeout: 10_000 });
          send('git', 'done', 'Git initialized');
        } catch {
          send('git', 'failed', 'Git init skipped');
        }
      }

      send('detect', 'active', 'Detecting repository…');
      const gitInfo = await detectGit(dirPath);
      send('detect', 'done', 'Repository ready');
      const name = input.name || path.basename(dirPath);

      const workspace: Workspace = {
        id: `ws_${Math.random().toString(36).slice(2, 10)}`,
        name,
        path: dirPath,
        repository: input.repository,
        branch: gitInfo?.branch ?? 'main',
        headCommit: gitInfo?.headCommit ?? 'unknown',
        isDefault: false,
        fileCount: gitInfo?.fileCount ?? 0,
        worktreeLocation: '.agent/worktrees/',
        scripts: input.scripts ?? [],
      };

      domain.addWorkspace(workspace);
      try {
        syncCoAuthorHook(dirPath);
      } catch (e) {
        log.warn('co-author hook sync failed', { err: e instanceof Error ? e.message : String(e) });
      }
      return workspace;
    },

    workspaceUpdate: ({ workspaceId, patch }: { workspaceId: string; patch: Partial<Workspace> }) => {
      domain.updateWorkspace(workspaceId, patch);
      return workspaceOf(workspaceId) ?? null;
    },

    workspaceArchive: ({ workspaceId }: { workspaceId: string }) => {
      domain.archiveWorkspace(workspaceId);
      return {};
    },

    workspaceUnarchive: ({ workspaceId }: { workspaceId: string }) => {
      domain.unarchiveWorkspace(workspaceId);
      return {};
    },

    workspaceDelete: ({ workspaceId }: { workspaceId: string }) => {
      try {
        domain.deleteWorkspace(workspaceId);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    workspacesExist: ({ paths }: { paths: string[] }) => {
      const result: Record<string, boolean> = {};
      for (const p of paths ?? []) {
        try {
          result[p] = fs.existsSync(p) && fs.statSync(p).isDirectory();
        } catch {
          result[p] = false;
        }
      }
      return result;
    },

    lastSessionGet: (_: Record<string, never>) => domain.getLastSession(),

    lastSessionSet: ({ sessionId, workspaceId }: { sessionId: string | null; workspaceId: string | null }) => {
      domain.setLastSession(sessionId, workspaceId);
      return {};
    },

    workspaceListBranches: async ({ workspaceId }: { workspaceId: string }) =>
      listBranches ? listBranches(workspaceId) : [],

    workspaceListConfigFiles: ({ workspaceId }: { workspaceId: string }) =>
      listConfigFiles ? listConfigFiles(workspaceId) : [],

    fileTreeGet: ({ workspaceId }: { workspaceId: string }) => {
      const ws = workspaceOf(workspaceId);
      if (!ws) return [];
      const dirPath = expandPath(ws.path);
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
      try {
        return readDirTree(dirPath, '', 3);
      } catch {
        return [];
      }
    },

    workspaceContextGet: ({ workspaceId }: { workspaceId: string }): string => {
      const ws = workspaceOf(workspaceId);
      if (!ws) return '';

      const dirPath = expandPath(ws.path);
      const lines: string[] = [];

      try {
        const pkgRaw = fs.readFileSync(path.join(dirPath, 'package.json'), 'utf-8');
        const pkg = JSON.parse(pkgRaw);
        lines.push(`Project: ${pkg.name ?? path.basename(dirPath)}`);
        if (pkg.description) lines.push(`Description: ${pkg.description}`);
        if (pkg.version) lines.push(`Version: ${pkg.version}`);
        if (pkg.private != null) lines.push(`Private: ${pkg.private}`);
        const depKeys = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
        if (depKeys.length) {
          const interesting = depKeys.filter((k) =>
            /^(react|next|vue|nuxt|svelte|@angular|electron|vite|typescript|tailwind|express|fastify|nest|prisma|drizzle|@modelcontextprotocol|ai|openai|anthropic|zustand|redux|@tanstack)/i.test(k),
          );
          const shown = interesting.length ? interesting : depKeys.slice(0, 12);
          lines.push(`Stack: ${shown.join(', ')}${depKeys.length > shown.length ? ` (+${depKeys.length - shown.length} more)` : ''}`);
        }
        const scripts = Object.entries(pkg.scripts ?? {});
        if (scripts.length) {
          const shown = scripts.slice(0, 6).map(([k]) => k).join(', ');
          lines.push(`Scripts: ${shown}${scripts.length > 6 ? ` (+${scripts.length - 6} more)` : ''}`);
        }
      } catch {
        lines.push(`Project: ${path.basename(dirPath)} (no package.json)`);
      }

      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const visible = entries
          .filter((e) => !(e.name.startsWith('.') && e.name !== '.agent') && !['node_modules', 'dist', 'build', 'release', 'target'].includes(e.name))
          .slice(0, 40)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        if (visible.length) lines.push(`Top-level: ${visible.join(', ')}`);
      } catch {
        // unreadable — skip
      }

      for (const name of ['README.md', 'README.MD', 'README.txt', 'README']) {
        try {
          const readme = fs.readFileSync(path.join(dirPath, name), 'utf-8');
          const excerpt = readme.split('\n').slice(0, 40).join('\n').trim();
          if (excerpt) {
            lines.push(`---\nREADME (${name}):\n${excerpt}`);
          }
          break;
        } catch {
          // try next
        }
      }

      try {
        const entries = scanProjectEntries(dirPath);
        for (const ctx of entries.contextFiles) {
          lines.push(`---\n${ctx.path} (project agent guidance — always apply; where these rules conflict with your defaults, these rules win):\n${ctx.content}`);
          break;
        }
      } catch {
        // scan failure — skip
      }

      return lines.join('\n');
    },

    workspaceFileRead: ({ workspaceId, relPath }: { workspaceId: string; relPath: string }): WorkspaceFileReadResult => {
      const ws = workspaceOf(workspaceId);
      if (!ws) return { ok: false, reason: 'workspace not found' };

      const root = expandPath(ws.path);
      const full = path.resolve(root, relPath);

      const rel = path.relative(root, full);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, reason: 'path escapes workspace root' };
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        return { ok: false, reason: 'file not found' };
      }
      if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };

      const binExt = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|tar|gz|bz2|7z|rar|exe|dll|so|dylib|class|jar|war|wasm|mp[34]|wav|ogg|mov|mp4|avi|mkv|ttf|otf|woff2?|eot|sumo|db|sqlite|db3)$/i;
      if (binExt.test(relPath)) return { ok: false, reason: 'binary file' };

      const MAX_BYTES = 256 * 1024;
      const truncated = stat.size > MAX_BYTES;

      try {
        const fd = fs.openSync(full, 'r');
        try {
          const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
          fs.readSync(fd, buf, 0, buf.length, 0);
          let content = buf.toString('utf-8');
          if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
          return { ok: true, content, truncated, bytes: stat.size };
        } finally {
          fs.closeSync(fd);
        }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : 'read failed' };
      }
    },

    gitRepoDetect: async ({ dirPath }: { dirPath: string }) => {
      const info = await detectGit(dirPath);
      return info ? { ...info, isRepo: true } : null;
    },
  };
}
