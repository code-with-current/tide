import { describe, expect, it } from 'vitest';
import { sanitizePtyEnv } from '../../electron/ipc/terminal-env';

describe('sanitizePtyEnv', () => {
  it('strips host-private vars that corrupt shell children', () => {
    const env = sanitizePtyEnv({
      PATH: '/usr/bin',
      ARGV0: '/opt/OpenChamber.AppImage',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_CHANNEL_FD: '42',
      BASH_ENV: '/tmp/evil.sh',
      ENV: '/tmp/evil.env',
      BASH_XTRACEFD: '7',
      HOME: '/home/dev',
    } as Record<string, string>);
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev' });
  });

  it('keeps normal environments untouched', () => {
    const base = { PATH: '/usr/bin', HOME: '/h', TERM: 'xterm-256color', SHELL: '/bin/zsh' };
    expect(sanitizePtyEnv(base)).toEqual(base);
  });

  it('does not mutate the input object', () => {
    const input = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' };
    const out = sanitizePtyEnv(input);
    expect(input.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(out).not.toBe(input);
  });
});
