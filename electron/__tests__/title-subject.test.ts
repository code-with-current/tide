import { describe, expect, it } from 'vitest';
import { buildTitleSubject } from '../agent/title';

describe('buildTitleSubject', () => {
  it('passes ordinary text through', () => {
    expect(buildTitleSubject('fix the auth flow', [])).toBe('fix the auth flow');
  });

  it('falls back to attachment names + inline excerpt when text is empty', () => {
    const out = buildTitleSubject('', [
      { path: 'src/report.ts', kind: 'code', content: 'export function totals() {}' },
      { path: 'logo.png', kind: 'image' },
    ]);
    expect(out).toContain('report.ts');
    expect(out).toContain('logo.png');
    expect(out).toContain('export function totals()');
  });

  it('image-only attachments produce a names-only subject', () => {
    const out = buildTitleSubject('   ', [{ path: 'shots/home.png', kind: 'image' }]);
    expect(out).toContain('home.png');
    expect(out).not.toContain('\n\n');
  });

  it('uses only the path basename, not full paths', () => {
    const out = buildTitleSubject('', [{ path: '/a/b/c/main.rs', kind: 'code', content: 'fn main() {}' }]);
    expect(out).toContain('main.rs');
    expect(out).not.toContain('/a/b/c');
  });

  it('clamps very long text so the title model never chokes on pastes', () => {
    const long = 'x'.repeat(20_000);
    const out = buildTitleSubject(long, []);
    expect(out.length).toBeLessThanOrEqual(6_001);
    expect(out.endsWith('…')).toBe(true);
  });

  it('clamps the attachment excerpt too', () => {
    const out = buildTitleSubject('', [{ path: 'big.txt', kind: 'text', content: 'y'.repeat(5_000) }]);
    expect(out.length).toBeLessThanOrEqual(1_200);
  });
});
