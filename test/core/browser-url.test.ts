import { describe, expect, it } from 'vitest';
import { normalizeUrl, isNavigableUrl } from '@/lib/browser-url';

describe('normalizeUrl', () => {
  it('adds https:// to bare hosts', () => expect(normalizeUrl('example.com')).toBe('https://example.com'));
  it('adds http:// to localhost', () => expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173'));
  it('keeps full https urls', () => expect(normalizeUrl('https://a.b/c')).toBe('https://a.b/c'));
  it('keeps full http urls', () => expect(normalizeUrl('http://a.b/c')).toBe('http://a.b/c'));
  it('empty → empty', () => expect(normalizeUrl('')).toBe(''));
});

describe('isNavigableUrl', () => {
  it('accepts http/https', () => expect(isNavigableUrl('https://x.dev')).toBe(true));
  it('rejects file/other schemes', () => {
    expect(isNavigableUrl('file:///etc/passwd')).toBe(false);
    expect(isNavigableUrl('javascript:alert(1)')).toBe(false);
  });
});
