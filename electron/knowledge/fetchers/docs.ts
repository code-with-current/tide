/** Docs fetcher: reads a local markdown/text file or recursively walks a
 *  directory of them, producing one SourceDocument per file with the absolute
 *  path as origin. Locations are validated against an allow-list of roots
 *  (default: appDataDir) after realpath resolution so symlinked entries cannot
 *  escape it. Files over MAX_FILE_BYTES are skipped to bound memory use. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appDataDir } from '../../appPaths.js';
import type { SourceDocument } from '../types.js';

const MAX_FILE_BYTES = 512 * 1024;
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);

export interface FetchDocsOptions {
  allowedRoots?: string[];
}

export async function fetchDocs(location: string, opts: FetchDocsOptions = {}): Promise<SourceDocument[]> {
  const roots = (opts.allowedRoots ?? [appDataDir()]).map((root) => fs.realpathSync(root));
  const target = fs.realpathSync(location);
  if (!isWithin(target, roots)) {
    throw new Error(`docs location is outside the allowed roots: ${target}`);
  }

  const stat = fs.statSync(target);
  const files: string[] = [];
  if (stat.isFile()) {
    if (!DOC_EXTENSIONS.has(path.extname(target).toLowerCase())) {
      throw new Error(`unsupported docs file: ${target}`);
    }
    if (stat.size <= MAX_FILE_BYTES) files.push(target);
  } else {
    collectFiles(target, roots, files);
  }
  return files
    .sort()
    .map((file) => ({ title: path.basename(file), content: readDoc(file), origin: file }))
    .filter((doc) => doc.content.trim().length > 0);
}

function collectFiles(dir: string, roots: string[], out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(path.join(dir, entry.name));
    } catch {
      continue;
    }
    if (!isWithin(resolved, roots)) continue;
    if (entry.isDirectory()) {
      collectFiles(resolved, roots, out);
    } else if (entry.isFile() && DOC_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      try {
        if (fs.statSync(resolved).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      out.push(resolved);
    }
  }
}

function readDoc(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isWithin(p: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}
