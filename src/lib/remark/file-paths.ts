/** remark plugin: detect file paths in markdown and wrap them in clickable `<a data-file-path>` links. Runs after remark-gfm. Strict match: needs `/`, ends with a known extension, preceded by whitespace/delimiter; code is excluded by remark. The container reads `data-file-path` and calls `useUi.openFile`; the `tide-file://` URL avoids browser navigation. */

const KNOWN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
  '.cs', '.rb', '.php', '.swift', '.lua', '.sh', '.bash',
  '.vue', '.dart', '.html', '.css', '.scss', '.less',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.md', '.mdx',
  '.sql', '.graphql', '.gql', '.env', '.gitignore',
  '.wasm', '.onnx', '.svg', '.png', '.jpg', '.jpeg', '.gif',
]);

// Build a regex alternation from the extensions for fast matching.
const EXT_PATTERN = Array.from(KNOWN_EXTENSIONS)
  .sort((a, b) => b.length - a.length) // longer first so .tsx before .ts
  .map((e) => e.slice(1)) // drop the leading dot
  .join('|');

const PATH_REGEX = new RegExp(
  // Group 1: prefix (whitespace/start/delimiter that we preserve)
  '(^|[\\s(\\[{\'"`])' +
  // Group 2: the file path itself
  '(' +
    '(?:\\.?\\/)?' +           // optional ./ or /
    '(?:[\\w.@-]+\\/){1,8}' +   // 1-8 directory segments
    '[\\w@.-]+' +               // filename
    '\\.(?:' + EXT_PATTERN + ')' + // known extension
  ')',
  'g',
);

export function remarkFilePaths() {
  return (tree: any) => {
    walk(tree);
  };
}

function walk(node: any) {
  if (!node || !node.children) return;

  const newChildren: any[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const parts = splitFilePaths(child.value);
      newChildren.push(...parts);
    } else {
      // Recurse into non-text nodes (paragraphs, blockquotes, etc.)
      walk(child);
      newChildren.push(child);
    }
  }
  node.children = newChildren;
}

/** Split a text string into alternating text + link nodes wherever a
 *  file path is detected. Returns the original node unchanged if no
 *  paths are found. */
function splitFilePaths(text: string): any[] {
  PATH_REGEX.lastIndex = 0;
  const matches = [...text.matchAll(PATH_REGEX)];
  if (matches.length === 0) return [{ type: 'text', value: text }];

  const parts: any[] = [];
  let lastEnd = 0;

  for (const m of matches) {
    const prefix = m[1]; // the leading whitespace/delimiter
    const filePath = m[2]; // the actual path

    // Calculate where the path starts in the original text
    const matchStart = (m.index ?? 0) + prefix.length;

    // Text before the path
    if (matchStart > lastEnd) {
      parts.push({ type: 'text', value: text.slice(lastEnd, matchStart) });
    }

    // The link node — data-file-path is read by the click handler
    parts.push({
      type: 'link',
      url: `tide-file://${filePath}`,
      data: {
        hProperties: {
          className: 'file-path-link',
          // Custom data attr — the container onClick reads this
          'data-file-path': filePath,
        },
      },
      children: [{ type: 'text', value: filePath }],
    });

    lastEnd = matchStart + filePath.length;
  }

  // Trailing text
  if (lastEnd < text.length) {
    parts.push({ type: 'text', value: text.slice(lastEnd) });
  }

  return parts;
}
