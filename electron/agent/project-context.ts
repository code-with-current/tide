/** Scan project-level and user-level agent context (.claude/.agent/.zcode at both workspace and ~). Project entries shadow user entries on name collisions; each entry carries `source: 'project' | 'user'`. Defensive: missing/unreadable files are skipped silently. */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BUILTIN_SKILLS } from '../../src/lib/prompts/_skills-bundle.js';

/** Ensure built-in skills exist as real files on disk so the orchestrator's
 *  LOAD_SKILL path + read_file tool can resolve them. Written once to
 *  <appData>/builtin-skills/<name>.md. Returns the abs paths. */
function ensureBuiltinSkillFiles(): Array<{ name: string; description: string; absPath: string; body: string }> {
  const dir = path.join(os.homedir(), '.tide' + (process.env.NODE_ENV === 'development' ? '-dev' : ''), 'builtin-skills');
  const out: Array<{ name: string; description: string; absPath: string; body: string }> = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* exists */ }
  for (const skill of BUILTIN_SKILLS) {
    const filePath = path.join(dir, `${skill.name}.md`);
    try {
      // Always overwrite so app updates refresh the skill content.
      fs.writeFileSync(filePath, `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}`, 'utf-8');
    } catch { /* read-only — skip */ }
    out.push({ name: skill.name, description: skill.description, absPath: filePath, body: skill.body });
  }
  return out;
}

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

const CONTEXT_FILE_NAMES = ['CLAUDE.md', 'AGENT.md', 'AGENTS.md'];
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

  // 0. Built-in app skills (bundled with Tide, always available).
  // Written to disk so the orchestrator's LOAD_SKILL + read_file can resolve them.
  const builtinFiles = ensureBuiltinSkillFiles();
  for (const skill of builtinFiles) {
    result.skills.push({
      name: skill.name,
      description: skill.description,
      source: 'project',
      path: `<builtin>/${skill.name}`,
      absPath: skill.absPath,
      body: skill.body,
    });
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

/** Scan one skills/ or agents/ directory. Handles flat `<name>.md` files, dir-based `<name>/SKILL.md`, and symlinks (classified via statSync, which follows the link). Dotfiles and non-.md entries are skipped. */
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

/** Push entries from `src` into `dst`, skipping name collisions — this gives project entries precedence (merged first) over user entries. */
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

/** Read a markdown file capped at MAX_FILE_BYTES; derives a short description from the first non-empty, non-frontmatter line. Returns null if unreadable or empty. */
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
