/** Permanent sigil gate for the sqlite driver seam (app/platform/sqlite.ts):
 *  bun:sqlite SILENTLY BINDS NULL for bare object keys — a corruption hazard,
 *  not an error — so every bind object passed to .run/.get/.all/.prepare (and
 *  .query) under app/core and in the seam itself must use `$`-prefixed keys;
 *  the seam strips the sigil for the better-sqlite3 backend, making `$` the
 *  one spelling safe under both drivers. The scanner is deliberately
 *  conservative: only literal object ARGUMENTS with statically visible keys
 *  are inspected — arrays, identifiers, template literals, spreads, computed
 *  keys, generic type-arguments, and arrow bodies are skipped rather than
 *  guessed at, so a pass never certifies dynamically-built bind objects. */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_TARGETS: string[] = [
  path.join(REPO_ROOT, 'app', 'core'),
  path.join(REPO_ROOT, 'app', 'platform', 'sqlite.ts'),
];

const BIND_CALL = /\.(?:run|get|all|prepare|query)\b\s*(?:<[^<>()]*>)?\s*\(/g;

interface Violation {
  file: string;
  line: number;
  bareKeys: string[];
  excerpt: string;
}

function collectTsFiles(p: string): string[] {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .flatMap((entry) => collectTsFiles(path.join(p, entry.name)));
  }
  return p.endsWith('.ts') ? [p] : [];
}

/** Blank out comments and string/template contents (keeping offsets and
 *  newlines 1:1) so brace balancing and call matching cannot be fooled by
 *  prose or quoted SQL. Offsets stay valid for reading keys back from the
 *  original source. */
function maskStringsAndComments(src: string): string {
  const chars = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      blank(start, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(i + 2, src.length);
      blank(start, i);
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i = Math.min(i + 1, src.length);
      blank(start + 1, i - 1);
      continue;
    }
    if (c === '`') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          // interpolation: opaque-skip to its closing brace (nesting aware)
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            else if (src[i] === "'" || src[i] === '"') {
              const q = src[i];
              i++;
              while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
            }
            i++;
          }
          continue;
        }
        i++;
      }
      i = Math.min(i + 1, src.length);
      blank(start + 1, i - 1);
      continue;
    }
    i++;
  }
  return chars.join('');
}

/** Region enclosed by the paren at openParen (which must index '('). */
function parenRegion(masked: string, openParen: number): [number, number] | null {
  let depth = 0;
  for (let i = openParen; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return [openParen + 1, i];
    }
  }
  return null;
}

/** Keys of a top-level object-literal body, or null when any segment cannot
 *  be statically understood (spread, computed key, method, ...) — callers
 *  must treat null as "skip", never as "clean". */
function objectLiteralKeys(original: string, masked: string, bodyStart: number, bodyEnd: number): string[] | null {
  const keys: string[] = [];
  const segments: [number, number][] = [];
  let depth = 0;
  let segStart = bodyStart;
  for (let i = bodyStart; i < bodyEnd; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      segments.push([segStart, i]);
      segStart = i + 1;
    }
  }
  segments.push([segStart, bodyEnd]);
  for (const [s, e] of segments) {
    const seg = original.slice(s, e).trim();
    if (seg === '') continue;
    let m = /^([$_A-Za-z][$_\w]*)\s*:/.exec(seg);
    if (m) {
      keys.push(m[1]);
      continue;
    }
    m = /^(['"])((?:\\.|(?!\1).)*)\1\s*:/.exec(seg);
    if (m) {
      keys.push(m[2]);
      continue;
    }
    if (/^[$_A-Za-z][$_\w]*$/.test(seg)) {
      keys.push(seg);
      continue;
    }
    return null;
  }
  return keys;
}

function scanSource(file: string, original: string): Violation[] {
  const masked = maskStringsAndComments(original);
  const violations: Violation[] = [];
  BIND_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BIND_CALL.exec(masked)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const region = parenRegion(masked, openParen);
    if (!region) continue;
    const [argsStart, argsEnd] = region;
    // depth = ()/[] nesting relative to the call's argument list; only
    // object literals at depth 0 are bind-object candidates.
    let depth = 0;
    for (let i = argsStart; i < argsEnd; i++) {
      const c = masked[i];
      if (c === '(' || c === '[') {
        depth++;
      } else if (c === ')' || c === ']') {
        depth--;
      } else if (c === '{' && depth === 0) {
        // An arrow body `(x) => { ... }` is a block, not a bind object.
        let j = i - 1;
        while (j >= argsStart && masked[j] === ' ') j--;
        if (masked[j] === '>' && masked[j - 1] === '=') continue;
        let bdepth = 0;
        let close = -1;
        for (let k = i; k < argsEnd; k++) {
          if (masked[k] === '{') bdepth++;
          else if (masked[k] === '}') {
            bdepth--;
            if (bdepth === 0) {
              close = k;
              break;
            }
          }
        }
        if (close === -1) continue;
        const keys = objectLiteralKeys(original, masked, i + 1, close);
        if (keys !== null && keys.length > 0 && keys.some((k) => !k.startsWith('$'))) {
          let line = 1;
          for (let k = 0; k < i; k++) if (original[k] === '\n') line++;
          violations.push({
            file,
            line,
            bareKeys: keys.filter((k) => !k.startsWith('$')),
            excerpt: original.slice(i, Math.min(close + 1, i + 90)).replace(/\s+/g, ' '),
          });
        }
        i = close;
      }
    }
  }
  return violations;
}

describe('sqlite sigil gate', () => {
  it('every bind object literal in app/core and the seam uses $-prefixed keys', () => {
    const files = SCAN_TARGETS.flatMap(collectTsFiles).sort();
    expect(files.length).toBeGreaterThan(50);
    const violations = files.flatMap((f) => scanSource(f, fs.readFileSync(f, 'utf8')));
    const rendered = violations
      .map(
        (v) =>
          `\n  ${path.relative(REPO_ROOT, v.file)}:${v.line} bare keys [${v.bareKeys.join(', ')}] — ${v.excerpt}`,
      )
      .join('');
    expect(
      violations,
      `bare (non-$) bind keys found — bun:sqlite silently binds them as NULL:${rendered}\n`,
    ).toEqual([]);
  });

  it('scanner catches bare-key bind objects and skips non-literal arguments', () => {
    const fixture = [
      "const bad1 = stmt.run({ id: 'a', n: 1 });",
      "const bad2 = x.get('positional', { name: 'b' });",
      'const bad3 = y.prepare(`SELECT 1`).get({ [k]: v }); // computed key → skipped',
      'const ok1 = stmt.run({ $id: 1, $n: 2 });',
      'const ok2 = x.all(...ids);',
      'const ok3 = map.get(key);',
      'const ok4 = db.prepare<[], { id: string }>(sql).all();',
      'const ok5 = s.get((e) => { inner.run({ $safe: 1 }); });',
      'const ok6 = s.get({ ...spread, $id: 1 });',
      "const ok7 = s.get({ '$ok': 1 });",
      "const bad4 = s.get({ 'quoted': 'bare' });",
    ].join('\n');
    const violations = scanSource('fixture.ts', fixture);
    expect(violations.map((v) => v.bareKeys)).toEqual([['id', 'n'], ['name'], ['quoted']]);
  });
});
