/** Synchronous per-line syntax highlighting for diff previews.
 *
 *  Tide has no synchronous Prism/Shiki registry in the chat path — the
 *  markdown worker and the Pierre worker pool are both async and scoped to
 *  their surfaces. This tokenizer mirrors the token→palette roles of the Pierre
 *  theme bridge (pierre-bridge.ts tokenColors) so diff previews and the file
 *  viewer agree on what each token kind looks like. */

export interface HighlightSpan {
  text: string;
  cls: string;
}

/** Ladder: skip highlighting when a single line exceeds this (plain fallback
 *  for just that row) or when the block's total text exceeds the cap (plain
 *  fallback for the whole diff). */
export const MAX_HIGHLIGHT_LINE_CHARS = 1000;
export const MAX_HIGHLIGHT_BLOCK_CHARS = 500_000;

/** Whether the block gets highlighting at all — false past the total-text
 *  ladder rung. `totalChars` may be passed when the caller already knows it;
 *  otherwise it's summed from `lines`. */
export function shouldHighlight(lines: string[], totalChars?: number): boolean {
  const chars = totalChars ?? lines.reduce((n, l) => n + l.length, 0);
  return chars <= MAX_HIGHLIGHT_BLOCK_CHARS;
}

const CLS = {
  comment: 'text-muted-foreground/80 italic',
  string: 'text-success',
  keyword: 'text-reasoning',
  number: 'text-warning',
  constant: 'text-warning',
  func: 'text-info',
  type: 'text-ring',
} as const;

type TokenKind = keyof typeof CLS;

const KEYWORDS: Record<string, string[]> = {
  typescript: [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
    'case', 'break', 'continue', 'default', 'class', 'extends', 'implements', 'interface', 'type',
    'enum', 'namespace', 'declare', 'abstract', 'import', 'from', 'export', 'as', 'new', 'delete',
    'typeof', 'instanceof', 'in', 'of', 'void', 'this', 'super', 'public', 'private', 'protected',
    'readonly', 'static', 'get', 'set', 'async', 'await', 'try', 'catch', 'finally', 'throw',
    'yield', 'satisfies', 'keyof',
  ],
  python: [
    'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'pass', 'class',
    'import', 'from', 'as', 'global', 'nonlocal', 'lambda', 'with', 'try', 'except', 'finally',
    'raise', 'assert', 'del', 'yield', 'async', 'await', 'and', 'or', 'not', 'in', 'is',
  ],
  go: [
    'func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type',
    'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'switch', 'case', 'default',
    'break', 'continue', 'fallthrough', 'new', 'make', 'len', 'cap',
  ],
  rust: [
    'fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod',
    'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'self', 'Self', 'where', 'as', 'dyn',
    'move', 'ref', 'unsafe', 'crate', 'super', 'async', 'await',
  ],
} as const;

const CONSTANTS: Record<string, string[]> = {
  typescript: ['true', 'false', 'null', 'undefined'],
  javascript: ['true', 'false', 'null', 'undefined'],
  json: ['true', 'false', 'null'],
  python: ['None', 'True', 'False'],
  go: ['true', 'false', 'nil'],
  rust: ['true', 'false', 'None', 'Some', 'Ok', 'Err'],
} as const;

const HASH_COMMENT_LANGS = new Set(['python']);
const PLAIN_LANGS = new Set(['text', 'markdown', '']);

const tokenizerCache = new Map<string, RegExp | null>();

function buildTokenizer(lang: string): RegExp | null {
  if (PLAIN_LANGS.has(lang)) return null;
  const kws = KEYWORDS[lang] ?? (lang === 'javascript' ? KEYWORDS.typescript : undefined);
  const consts = CONSTANTS[lang];
  if (!kws && !consts) return null;

  // Ordered by priority: comments first so commented-out code never tokenizes,
  // keywords before call-sites so `if (` isn't a function name.
  const parts: [TokenKind, string][] = [
    ['comment', HASH_COMMENT_LANGS.has(lang) ? '#.*' : '//.*'],
    ['string', '"(?:\\\\.|[^"\\\\])*"'],
    ['string', "'(?:\\\\.|[^'\\\\])*'"],
  ];
  if (lang === 'typescript' || lang === 'javascript') {
    parts.push(['string', '`(?:\\\\.|[^`\\\\])*`']);
  }
  parts.push(['number', '\\b0x[\\da-fA-F]+\\b'], ['number', '\\b\\d[\\d_]*(?:\\.\\d+)?\\b']);
  if (kws?.length) parts.push(['keyword', `\\b(?:${kws.join('|')})\\b`]);
  if (consts?.length) parts.push(['constant', `\\b(?:${consts.join('|')})\\b`]);
  parts.push(['func', '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()'], ['type', '\\b[A-Z][A-Za-z0-9_$]*\\b']);

  const source = parts.map(([kind, re], i) => `(?<g${i}_${kind}>${re})`).join('|');
  return new RegExp(source, 'g');
}

function tokenizerFor(lang: string): RegExp | null {
  if (!tokenizerCache.has(lang)) {
    tokenizerCache.set(lang, buildTokenizer(lang));
  }
  return tokenizerCache.get(lang) ?? null;
}

function tokenize(text: string, lang: string): HighlightSpan[] {
  const re = tokenizerFor(lang);
  if (re == null) return [{ text, cls: '' }];
  const spans: HighlightSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) spans.push({ text: text.slice(last, idx), cls: '' });
    const name = Object.keys(m.groups ?? {}).find((k) => m.groups?.[k] !== undefined);
    const kind = name?.slice(name.indexOf('_') + 1) as TokenKind | undefined;
    spans.push({ text: m[0], cls: kind ? CLS[kind] : '' });
    last = idx + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), cls: '' });
  return spans;
}

// ── Memoized public API ────────────────────────────────────────────────

const CACHE_CAP = 4000;
const lru = new Map<string, HighlightSpan[]>();

/** Highlight one line, memoized by text+lang — diff blocks re-render per
 *  stream delta, so identical lines must not re-tokenize. */
export function highlightLine(text: string, lang: string): HighlightSpan[] {
  const key = `${lang}\u0000${text}`;
  const hit = lru.get(key);
  if (hit) {
    lru.delete(key);
    lru.set(key, hit);
    return hit;
  }
  const spans = tokenize(text, lang);
  lru.set(key, spans);
  if (lru.size > CACHE_CAP) {
    const oldest = lru.keys().next().value;
    if (oldest !== undefined) lru.delete(oldest);
  }
  return spans;
}

/** Diagnostics — current memo cache size. */
export function highlightCacheSize(): number {
  return lru.size;
}
