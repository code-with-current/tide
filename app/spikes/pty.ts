import { spawn } from 'node-pty';

const proc = spawn('/bin/zsh', [], {
  name: 'xterm-256color',
  cwd: process.env['HOME'],
  env: process.env as unknown as Record<string, string>,
});

let bytes = 0;
let sawMarker = false;
proc.onData((d) => {
  bytes += d.length;
  if (d.includes('SPIKE_OK')) sawMarker = true;
});

setTimeout(() => proc.write('echo SPIKE_OK\r'), 300);
setTimeout(() => proc.resize(120, 40), 800);
setTimeout(() => {
  proc.kill();
  console.log(JSON.stringify({ spike: 'pty', bytes, sawMarker, ok: bytes > 0 && sawMarker }));
  process.exit(bytes > 0 && sawMarker ? 0 : 1);
}, 1500);
