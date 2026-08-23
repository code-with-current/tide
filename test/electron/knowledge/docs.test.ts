import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchDocs } from '../../../electron/knowledge/fetchers/docs.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'docs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('fetchDocs', () => {
  it('walks a directory recursively, picking only doc extensions', async () => {
    const docs = await fetchDocs(FIXTURES, { allowedRoots: [FIXTURES] });

    const origins = docs.map((d) => d.origin).sort();
    expect(origins).toEqual([
      path.join(FIXTURES, 'guide.md'),
      path.join(FIXTURES, 'nested', 'deep.md'),
      path.join(FIXTURES, 'notes.txt'),
    ]);
    expect(docs.map((d) => d.title).sort()).toEqual(['deep.md', 'guide.md', 'notes.txt']);
  });

  it('ignores non-doc extensions and whitespace-only files', async () => {
    const docs = await fetchDocs(FIXTURES, { allowedRoots: [FIXTURES] });
    const all = JSON.stringify(docs);
    expect(all).not.toContain('debug.log');
    expect(all).not.toContain('empty.md');
    expect(all).not.toContain('must never be picked up');
  });

  it('reads a single file location with absolute-path origin and raw content', async () => {
    const single = path.join(FIXTURES, 'nested', 'deep.md');
    const [doc] = await fetchDocs(single, { allowedRoots: [FIXTURES] });

    expect(doc.origin).toBe(single);
    expect(doc.title).toBe('deep.md');
    expect(doc.content).toContain('Deeply nested markdown fixture.');
  });

  it('rejects a location outside the default allow-list of appDataDir()', async () => {
    const outside = tmpDir('tide-docs-outside-');
    try {
      const file = path.join(outside, 'x.md');
      fs.writeFileSync(file, 'outside content');
      await expect(fetchDocs(outside)).rejects.toThrow(/outside the allowed roots/);
      await expect(fetchDocs(file)).rejects.toThrow(/outside the allowed roots/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('honors explicit allowed roots', async () => {
    const root = tmpDir('tide-docs-root-');
    try {
      const nested = path.join(root, 'sub');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'a.md'), 'allowed content');
      fs.writeFileSync(path.join(root, 'b.txt'), 'also allowed');

      const docs = await fetchDocs(root, { allowedRoots: [root] });
      expect(docs).toHaveLength(2);

      const sibling = path.join(root, 'sibling');
      fs.mkdirSync(sibling);
      await expect(fetchDocs(nested, { allowedRoots: [sibling] })).rejects.toThrow(/outside the allowed roots/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws for a single file with an unsupported extension', async () => {
    await expect(fetchDocs(path.join(FIXTURES, 'debug.log'), { allowedRoots: [FIXTURES] })).rejects.toThrow(
      /unsupported docs file/,
    );
  });

  it('skips files over the 512KB size cap during the walk and for single-file locations', async () => {
    const root = tmpDir('tide-docs-cap-');
    try {
      fs.writeFileSync(path.join(root, 'small.md'), 'small enough');
      fs.writeFileSync(path.join(root, 'huge.md'), 'x'.repeat(512 * 1024 + 1));

      const walked = await fetchDocs(root, { allowedRoots: [root] });
      expect(walked.map((d) => d.title)).toEqual(['small.md']);

      await expect(fetchDocs(path.join(root, 'huge.md'), { allowedRoots: [root] })).resolves.toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not follow symlinks that escape the allowed roots', async () => {
    const root = tmpDir('tide-docs-link-');
    const secretDir = tmpDir('tide-docs-secret-');
    try {
      const secret = path.join(secretDir, 'secret.md');
      fs.writeFileSync(secret, 'top secret contents');
      fs.symlinkSync(secret, path.join(root, 'leak.md'));
      fs.writeFileSync(path.join(root, 'ok.md'), 'fine to index');

      const docs = await fetchDocs(root, { allowedRoots: [root] });
      expect(docs.map((d) => d.title)).toEqual(['ok.md']);
      expect(JSON.stringify(docs)).not.toContain('top secret contents');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('throws when the location does not exist', async () => {
    const missing = path.join(tmpDir('tide-docs-missing-'), 'nope.md');
    await expect(fetchDocs(missing, { allowedRoots: [os.tmpdir()] })).rejects.toThrow();
  });
});
