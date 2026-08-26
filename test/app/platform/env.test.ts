import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDevBuild } from '../../../app/platform/env';

afterEach(() => vi.unstubAllEnvs());

describe('isDevBuild', () => {
  it('dev channel is dev', () => {
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'dev');
    expect(isDevBuild()).toBe(true);
  });
  it('stable channel is packaged', () => {
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'stable');
    expect(isDevBuild()).toBe(false);
  });
  it('canary channel is packaged', () => {
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'canary');
    expect(isDevBuild()).toBe(false);
  });
  it('set-but-empty fails safe to dev', () => {
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', '');
    expect(isDevBuild()).toBe(true);
  });
  it('truly unset (outside the shell — tests, spike scripts) fails safe to dev', () => {
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', undefined);
    expect(isDevBuild()).toBe(true);
  });
  it('unknown channel fails safe to dev', () => {
    vi.stubEnv('ELECTROBUN_INSTALL_ROOT_NAME', 'beta');
    expect(isDevBuild()).toBe(true);
  });
});
