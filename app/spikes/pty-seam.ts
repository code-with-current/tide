/** Live E2E for the PTY seam (Task 3.4): spawns zsh through
 *  createPtySessionManager + the platform-default backend, waits for real
 *  COMMAND output (the marker is quote-split so the kernel's echo of the
 *  typed input can't satisfy it — interactive zsh takes >1s to initialize on
 *  a heavy zshrc, so the check is poll-based), exercises resize, and verifies
 *  kill drops anything emitted afterwards. Run under bun:
 *  `bun app/spikes/pty-seam.ts` — 3/3 PASS required (spike 1.1 pattern). */

import { createPtySessionManager } from '../platform/pty';

const ID = 'seam-spike';
const MARKER = 'SPIKE_OK';

const result = {
  backend: '',
  bytes: 0,
  sawMarker: false,
  coalesced: false,
  resizeOk: false,
  killDroppedPending: false,
};

const deliveries: string[] = [];

const manager = createPtySessionManager({ intervalMs: 16 });
result.backend = manager.backendName;

const ok = manager.spawnSession({
  id: ID,
  cmd: '/bin/zsh',
  args: ['-i'],
  cwd: process.env['HOME'] ?? '/tmp',
  env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  cols: 80,
  rows: 24,
  onOutput(data) {
    result.bytes += data.length;
    deliveries.push(data);
    if (data.includes(MARKER)) result.sawMarker = true;
  },
  onExit() {
    // kill() suppresses exit events by design (old killTerminal semantics);
    // natural exits deliver — not asserted here, E2E via the app.
  },
});

if (!ok) {
  console.log(JSON.stringify({ spike: 'pty-seam', ok: false, error: 'spawn failed', ...result }));
  process.exit(1);
}

setTimeout(() => manager.write(ID, `echo SPIKE_"OK"\r`), 300);

// Poll for the real command output (zsh init can take >1s on a heavy zshrc).
const waitForMarker = async (): Promise<boolean> => {
  for (let i = 0; i < 60; i++) {
    if (result.sawMarker) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return result.sawMarker;
};

void (async () => {
  result.sawMarker = await waitForMarker();
  try {
    manager.resize(ID, 120, 40);
    result.resizeOk = true;
  } catch {
    result.resizeOk = false;
  }
  // Coalescing: joined deliveries are fewer than the bytes they carry (a
  // raw chunk-per-callback stream would deliver 1 delivery per few bytes).
  result.coalesced = result.sawMarker && deliveries.length < result.bytes;
  // Write and kill in the SAME tick: whatever zsh emits afterwards must
  // never be delivered (the coalescer's alive-guard drops it).
  manager.write(ID, 'echo AFTER_KILL\r');
  manager.kill(ID);
  await new Promise((r) => setTimeout(r, 600));
  result.killDroppedPending = !deliveries.some((d) => d.includes('AFTER_KILL'));
  const pass =
    result.sawMarker && result.bytes > 0 && result.coalesced && result.resizeOk && result.killDroppedPending;
  console.log(JSON.stringify({ spike: 'pty-seam', ok: pass, ...result }));
  process.exit(pass ? 0 : 1);
})();