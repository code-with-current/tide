/** Stop-gap context injector: detect file paths mentioned in a user message and fetch their contents into the system prompt (conservatively — missing a reference is preferred to reading the wrong file). Used until the model can read files itself via tools. */

import * as api from '@/lib/api/client';

// Path-like token: a `.` / `src/` / `app/foo.ts` style run, with at least
// one slash OR a known code extension. We require a slash to avoid flagging
// every capitalized word as a path; bare `package.json` is the exception.
const PATH_RE =
  /(?:^|[\s(`'"])((?:\.\/|\.\.\/|\/)?(?:[A-Za-z0-9._-]+\/){1,5}[A-Za-z0-9._-]+\.[A-Za-z0-9]+|[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|md|markdown|json|yml|yaml|toml|ini|cfg|sh|bash|zsh|sql|html|css|scss|vue|svelte|swift|dart|lua|sql))(?=[)\s`'".?,;:!]|$)/g;

// Always-include these if mentioned, even without a slash.
const KNOWN_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'README.md',
  'README',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
]);

/** Match both kinds of file references in a user message. */
export function extractFilePaths(message: string): string[] {
  const found = new Set<string>();

  // 1) Explicit path-like tokens.
  for (const m of message.matchAll(PATH_RE)) {
    const p = m[1].trim();
    if (p) found.add(p);
  }

  // 2) Known bare filenames.
  const lower = message.toLowerCase();
  for (const f of KNOWN_FILES) {
    const re = new RegExp(`(^|[^\\w./])${f.replace(/\./g, '\\.')}($|[^\\w./])`, 'i');
    if (re.test(lower)) found.add(f);
  }

  return Array.from(found).slice(0, 6); // cap to keep tokens bounded
}

/** Hard cap on total injected bytes across all referenced files. */
const MAX_TOTAL_BYTES = 200_000;

/** Fetch each referenced file's contents and assemble them into a `# Referenced files` block for the system prompt. Returns '' if none found/fetchable. */
export async function buildReferencedFilesBlock(
  workspaceId: string,
  userMessage: string,
): Promise<string> {
  const paths = extractFilePaths(userMessage);
  if (paths.length === 0) return '';

  const blocks: string[] = [];
  let totalBytes = 0;

  for (const p of paths) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      blocks.push(`(…truncated context budget; \`${p}\` not fetched)`);
      continue;
    }
    const res = await api.readFileInWorkspace(workspaceId, p).catch(() => null);
    if (!res || res.ok !== true) continue;

    const note = res.truncated ? ` (truncated — file is ${res.bytes.toLocaleString()} bytes)` : '';
    const header = `--- ${p}${note} ---`;
    const sep = '-'.repeat(Math.min(80, header.length));
    blocks.push(`${sep}\n${header}\n${sep}\n${res.content}`);
    totalBytes += res.bytes;
  }

  if (blocks.length === 0) return '';
  return `\n# Referenced files\nThe user mentioned these paths in their message; their contents are included here so you can answer specifically:\n\n${blocks.join('\n\n')}\n`;
}
