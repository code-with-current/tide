import { describe, expect, it } from 'vitest';
import { arrayBufferToBase64 } from '../../src/lib/api/client';

describe('arrayBufferToBase64', () => {
  it('round-trips small buffers', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const decoded = Uint8Array.from(atob(arrayBufferToBase64(bytes.buffer)), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('encodes buffers larger than the 64KB spread limit', () => {
    const bytes = new Uint8Array(200 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const decoded = Uint8Array.from(atob(arrayBufferToBase64(bytes.buffer)), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[100_000]).toBe(bytes[100_000]);
  });
});
