import { describe, it, expect } from 'vitest';
import { createServer } from './server.js';
describe('desktop session boundary', () => {
  it('requires the session token, exact Host and same Origin before HTTP or websocket routes', async () => {
    const token = 'a'.repeat(64), origin = 'http://127.0.0.1:19001';
    const app = await createServer({ logger: false, desktopSession: { token, origin: () => origin } });
    const allowed = { host: '127.0.0.1:19001', 'x-gba-session': token };
    try {
      expect((await app.inject({url:'/api/health',headers:allowed})).statusCode).toBe(200);
      for (const headers of [
        {host:allowed.host}, {...allowed,'x-gba-session':'b'.repeat(64)},
        {...allowed,host:'attacker.example:19001'}, {...allowed,origin:'https://attacker.example'},
      ]) expect((await app.inject({url:'/api/health',headers})).statusCode).toBe(401);
      const upgrade = await app.inject({ url: '/api/agent/ws', headers: { host:allowed.host,connection:'upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':'MTIzNDU2Nzg5MDEyMzQ1Ng==' } });
      expect(upgrade.statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it('uses the supplied desktop picker and preserves the standalone server contract', async () => {
    const app = await createServer({ logger:false, desktopSession:{token:'c'.repeat(64),origin:()=> 'http://127.0.0.1:19002',nativePicker:async kind => ({kind,path:'/controlled/choice'})} });
    try {
      const r=await app.inject({method:'POST',url:'/api/dialogs/pick',headers:{host:'127.0.0.1:19002','x-gba-session':'c'.repeat(64)},payload:{kind:'folder'}});
      expect(r.statusCode).toBe(200);expect(r.json()).toEqual({kind:'folder',path:'/controlled/choice'});
    } finally { await app.close(); }
    const standalone=await createServer({logger:false});
    try { expect((await standalone.inject('/api/health')).statusCode).toBe(200); } finally { await standalone.close(); }
  });
});
