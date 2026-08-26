/** Ephemeral loopback HTTP server for OAuth redirects (RFC 8252 §7.3).
 *  Binds an OS-assigned port on 127.0.0.1, serves exactly one `/callback`
 *  hit, then closes — the coordinator in app/core/agent/mcp/oauth.ts
 *  restarts it before the next auth flow needs a redirect URI. */

import * as http from 'http';

export interface LoopbackServer {
  port: number;
  close: () => void;
}

export function startLoopbackServer(
  onCallback: (query: URLSearchParams) => void,
): Promise<LoopbackServer> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      onCallback(url.searchParams);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body><h2>Tide</h2><p>Connected — you can close this tab.</p></body></html>');
      server.close();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0, close: () => server.close() });
    });
  });
}
