/**
 * Scan project-level and user-level agent context.
 *
 * Sources, in priority order (first match wins on name collisions):
 *
 *   Project (per-workspace):
 *     <workspace>/.claude/CLAUDE.md | AGENT.md   → contextFiles
 *     <workspace>/.claude/skills/<name>.md       → skills
 *     <workspace>/.claude/skills/<name>/SKILL.md → skills (modern convention)
 *     <workspace>/.claude/agents/<name>.md       → agents
 *     <workspace>/.claude/agents/<name>/SKILL.md → agents
 *     ...same for .agent/...
 *
 *   User (global, ~):
 *     ~/.claude/skills/...    → skills (source: 'user')
 *     ~/.claude/agents/...    → agents (source: 'user')
 *     ...same for .agent/...
 *
 * Both `.claude` and `.agent` are scanned (previously only the first found
 * was scanned, which silently dropped anything in the other). Project
 * entries take precedence over user entries on name conflicts — a
 * project-local skill always shadows a globally-installed one with the
 * same name, mirroring PATH lookup precedence.
 *
 * Each entry carries `source: 'project' | 'user'` so the renderer can badge
 * it. Symlinks are followed (user skills are typically symlinked into
 * ~/.claude/skills/ from elsewhere).
 *
 * The scanner is defensive: missing files / unreadable folders are skipped
 * silently. No file is required — this just surfaces what exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MAX_FILE_BYTES = 16 * 1024; // 16 KB cap per file — keep picker fast

export interface ProjectContextFile {
  /** Skill/agent/context name. For dir-based skills, the directory name;
   *  for flat files, the filename without .md. */
  name: string;
  /** Relative path from the scanned root (project root OR user home),
   *  for display. e.g. ".claude/skills/foo/SKILL.md" or "foo.md". */
  path: string;
  /** Absolute path to the file. Handed to the model so it can `read_file`
   *  the skill on demand (progressive disclosure) — including user-level
   *  skills that live outside the workspace, which read_file allows via the
   *  skill-root path-safety exception. */
  absPath: string;
  /** First non-empty line of the file, used as a description in the picker. */
  description: string;
  /** Full file content (capped). Used to inject as context on pick. */
  content: string;
  /** Approx byte size before truncation. */
  bytes: number;
  /** Whether the content was truncated. */
  truncated: boolean;
  /** Where the entry came from — drives a badge in the picker. */
  source: 'project' | 'user';
}

export interface ProjectEntries {
  /** Root-level CLAUDE.md / AGENT.md, if present. Always source: 'project'. */
  contextFiles: ProjectContextFile[];
  /** Project + user skills, deduped by name (project wins). */
  skills: ProjectContextFile[];
  /** Project + user agents, deduped by name (project wins). */
  agents: ProjectContextFile[];
}

const CONTEXT_FILE_NAMES = ['CLAUDE.md', 'AGENT.md'];
// `.zcode` is the app's own config dir (~/.zcode/skills); `.claude`/`.agent`
// cover the broader ecosystem. All three are scanned at project + user level.
const PROJECT_DIRS = ['.claude', '.agent', '.zcode'];
const SUBDIRS = ['skills', 'agents'] as const;
type SubDir = (typeof SUBDIRS)[number];

/**
 * Scan project-level and user-level agent context. Safe to call on any
 * directory — returns empty lists if nothing relevant exists.
 */
export function scanProjectEntries(workspaceRoot: string): ProjectEntries {
  const result: ProjectEntries = { contextFiles: [], skills: [], agents: [] };
  let root: string;
  try {
    root = fs.realpathSync(workspaceRoot);
  } catch {
    return result;
  }

  // 1. Root-level CLAUDE.md / AGENT.md — project only (no user equivalent).
  for (const name of CONTEXT_FILE_NAMES) {
    const file = readFileCapped(path.join(root, name), name, 'project');
    if (file) {
      result.contextFiles.push(file);
      break; // one is enough; CLAUDE.md wins (checked first)
    }
  }

  // 2. Project-level skills/agents — scan BOTH .claude and .agent, dedupe
  // by name (.claude wins because it's checked first). Both feed the same
  // `skills` / `agents` arrays via the dedupe-when-pushing helper.
  for (const projectDir of PROJECT_DIRS) {
    const projectDirAbs = path.join(root, projectDir);
    if (!isDirectory(projectDirAbs)) continue;
    for (const sub of SUBDIRS) {
      const found = scanSkillOrAgentDir(path.join(projectDirAbs, sub), sub, 'project');
      mergeDedup(result[sub], found);
    }
  }

  // 3. User-level skills/agents — scan ~/.claude and ~/.agent the same way.
  // Project entries already collected above take precedence (checked first),
  // so mergeDedup will skip any user entry whose name collides with a
  // project entry.
  const home = os.homedir();
  for (const userDir of PROJECT_DIRS) {
    const userDirAbs = path.join(home, userDir);
    if (!isDirectory(userDirAbs)) continue;
    // Skip if the user dir IS the project dir (e.g. workspace is ~) —
    // otherwise we'd double-count every project entry as user.
    if (samePath(userDirAbs, path.join(root, userDir))) continue;
    for (const sub of SUBDIRS) {
      const found = scanSkillOrAgentDir(path.join(userDirAbs, sub), sub, 'user');
      mergeDedup(result[sub], found);
    }
  }

  return result;
}

/**
 * Scan one skills/ or agents/ directory. Handles three entry shapes:
 *   - `<name>.md` flat file (legacy + simple case)
 *   - `<name>/SKILL.md` directory (modern Claude Code convention)
 *   - symlinks to either of the above (resolved via fs.statSync)
 *
 * `.DS_Store`, hidden files, and other extensions are skipped. `seen` is
 * local to one scan dir — cross-dir dedupe happens in the caller.
 */
function scanSkillOrAgentDir(
  subAbs: string,
  _sub: SubDir,
  source: 'project' | 'user',
): ProjectContextFile[] {
  const out: ProjectContextFile[] = [];
  const seen = new Set<string>();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(subAbs, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    // Skip dotfiles (.DS_Store, .gitkeep, etc.) outright.
    if (entry.name.startsWith('.')) continue;

    const entryAbs = path.join(subAbs, entry.name);
    // Use statSync (follows symlinks) rather than the Dirent's own type —
    // user-level skills are frequently symlinked into ~/.claude/skills/
    // from elsewhere, and we want to classify the TARGET, not the link.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entryAbs);
    } catch {
      continue;
    }

    if (stat.isFile()) {
      // Flat file: <name>.md
      if (!entry.name.endsWith('.md')) continue;
      const name = entry.name.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const file = readFileCapped(entryAbs, entry.name, source);
      if (file) {
        file.name = name;
        out.push(file);
      }
    } else if (stat.isDirectory()) {
      // Modern dir-based skill: <name>/SKILL.md
      const name = entry.name;
      if (seen.has(name)) continue;
      seen.add(name);
      const skillMd = path.join(entryAbs, 'SKILL.md');
      const file = readFileCapped(skillMd, `${entry.name}/SKILL.md`, source);
      if (file) {
        // readFileCapped derives `name` from the basename — for SKILL.md,
        // that'd be "SKILL". Override with the directory name, which is
        // the actual skill identifier.
        file.name = name;
        out.push(file);
      }
    }
  }

  return out;
}

/**
 * Push entries from `src` into `dst`, skipping any whose name already
 * exists in `dst`. This is what gives project entries precedence over
 * user entries — project entries are merged first, so user collisions
 * are silently dropped.
 */
function mergeDedup(dst: ProjectContextFile[], src: ProjectContextFile[]): void {
  for (const entry of src) {
    if (dst.some((existing) => existing.name === entry.name)) continue;
    dst.push(entry);
  }
}

/** Like fs.statSync(...).isDirectory() but returns false on any error. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True if both paths resolve to the same absolute location. */
function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * Read a markdown file capped at MAX_FILE_BYTES. Derives a short description
 * from the first non-empty, non-frontmatter line. Returns null if the file
 * can't be read or is empty.
 */
function readFileCapped(
  absPath: string,
  relPath: string,
  source: 'project' | 'user',
): ProjectContextFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  const bytes = Buffer.byteLength(raw, 'utf-8');
  const truncated = bytes > MAX_FILE_BYTES;
  const content = truncated ? raw.slice(0, MAX_FILE_BYTES) : raw;

  // Derive a name from the filename (without .md).
  const baseName = path.basename(relPath, '.md');

  // Derive a description: first non-empty line that isn't frontmatter or
  // a markdown heading marker. Strip leading "#", "-", "*", ">".
  let description = '';
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '---') {
      // Could be the start/end of YAML frontmatter — toggle and skip.
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) continue;
    // Skip pure-heading lines like "# Refactor Skill" — use them only as
    // a fallback if no body line exists.
    const stripped = trimmed.replace(/^#+\s*/, '').replace(/^[-*>\s]+/, '');
    if (stripped) {
      description = stripped.slice(0, 120);
      break;
    }
  }
  if (!description) {
    // Fall back to the first heading (or the filename).
    for (const line of lines) {
      const m = line.match(/^#\s+(.+)$/);
      if (m) { description = m[1].slice(0, 120); break; }
    }
  }
  if (!description) description = baseName;

  return { name: baseName, path: relPath, absPath, description, content, bytes, truncated, source };
}
