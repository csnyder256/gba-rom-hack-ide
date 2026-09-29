import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createDesktopApiFetch } from './desktop-api-fetch.js';

it('reaches the authenticated local API and never sends the token to another origin or follows a redirect', async () => {
  const token = 'c'.repeat(64);
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: externalOrigin }); res.end(); return; }
    if (req.headers['x-gba-session'] !== token) { res.writeHead(401); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ accepted: true, accept: req.headers.accept }));
  });
  const external = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ leaked: Boolean(req.headers['x-gba-session']) })); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => external.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const externalOrigin = `http://127.0.0.1:${(external.address() as { port: number }).port}`;
  try {
    expect((await fetch(origin)).status).toBe(401);
    const callback = createDesktopApiFetch(origin, token, fetch);
    expect(await (await callback(new Request(origin, { headers: { accept: 'application/json' } }))).json()).toEqual({ accepted: true, accept: 'application/json' });
    expect(await (await callback(externalOrigin)).json()).toEqual({ leaked: false });
    await expect(callback(origin + '/redirect')).rejects.toThrow();
  } finally {
    server.closeAllConnections(); external.closeAllConnections();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => external.close(() => r()))]);
  }
});
