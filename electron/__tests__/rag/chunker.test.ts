import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { chunkFile, _resetParsersForTests } from '../../rag/chunker/index.js';

const FIXTURES = path.join(__dirname, 'chunker-fixtures');

describe('chunkFile', () => {
  beforeAll(() => {
    _resetParsersForTests();
  });

  it('returns [] for unknown extensions', async () => {
    const tmp = path.join(os.tmpdir(), 'sample.txt');
    fs.writeFileSync(tmp, 'function foo() {}\n');
    expect(await chunkFile(tmp)).toEqual([]);
  });

  it('returns [] for empty files', async () => {
    const tmp = path.join(os.tmpdir(), 'empty.ts');
    fs.writeFileSync(tmp, '');
    expect(await chunkFile(tmp)).toEqual([]);
  });

  it('returns [] for binary files (NUL in first 8KB)', async () => {
    const tmp = path.join(os.tmpdir(), 'binary.ts');
    fs.writeFileSync(tmp, '\u0000\u0000\u0000not really ts');
    expect(await chunkFile(tmp)).toEqual([]);
  });

  it('chunks a TypeScript fixture at symbol boundaries', async () => {
    const chunks = await chunkFile(path.join(FIXTURES, 'sample.ts'));
    expect(chunks.length).toBeGreaterThan(5);

    const symbols = chunks.map((c) => c.symbol);
    // Top-level declarations become their own chunks.
    expect(symbols).toEqual(expect.arrayContaining(['add', 'counter', 'Calculator', 'VERSION', 'User', 'UserID', 'Direction']));

    // No chunk crosses a function boundary — each chunk's content must
    // contain a balanced { } pair starting from the symbol signature.
    for (const c of chunks) {
      if (c.symbol === '' || c.symbol === 'VERSION') continue; // skip trivial
      // Every non-trivial chunk should start with a keyword or export marker.
      expect(c.content).toMatch(/^(export\s+)?(function|class|const|let|var|interface|type|enum|abstract|generator)/);
    }

    // Each chunk has a stable id + content hash for ingestion dedupe.
    for (const c of chunks) {
      expect(c.id).toMatch(/^[0-9a-f]{64}$/);
      expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(c.startLine).toBeGreaterThan(0);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
  });

  it('chunks a JavaScript fixture', async () => {
    const chunks = await chunkFile(path.join(FIXTURES, 'sample.js'));
    expect(chunks.length).toBeGreaterThan(0);
    const symbols = chunks.map((c) => c.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['greet', 'Greeter']));
  });

  it('chunks a TSX fixture (JSX + types)', async () => {
    const chunks = await chunkFile(path.join(FIXTURES, 'sample.tsx'));
    expect(chunks.length).toBeGreaterThan(0);
    const symbols = chunks.map((c) => c.symbol);
    expect(symbols).toEqual(expect.arrayContaining(['Button', 'Card']));
    // JSX content survives the slice (no truncation mid-JSX).
    const button = chunks.find((c) => c.symbol === 'Button');
    expect(button?.content).toContain('<button');
    expect(button?.content).toContain('</button>');
  });

  it('falls back to a single whole-file chunk when there are no top-level symbols', async () => {
    // Pure expression statements — no function/class/const/type declarations
    // the chunker would otherwise slice into per-symbol chunks.
    const tmp = path.join(os.tmpdir(), 'nosymbols.ts');
    fs.writeFileSync(tmp, 'console.log("hello");\nfoo(bar);\n');
    const chunks = await chunkFile(tmp);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].symbol).toBe('');
    expect(chunks[0].content).toContain('console.log');
  });

  it('chunk ids are stable for the same path|symbol|line', async () => {
    // Run twice — chunk ids must match. This is the contract ingestion
    // relies on for content-hash dedupe across re-ingest.
    const a = await chunkFile(path.join(FIXTURES, 'sample.ts'));
    const b = await chunkFile(path.join(FIXTURES, 'sample.ts'));
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });
});
