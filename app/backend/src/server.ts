import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { pickPath } from './projects/file-picker.js';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import { registerHealthRoute } from './routes/health.js';
import { registerProjectsRoute } from './routes/projects.js';
import { registerAgentRoute } from './routes/agent.js';
import { registerTileIntelRoute } from './routes/tile-intel.js';
import { ProjectSessionStore } from './projects/session-store.js';

export interface CreateServerOptions {
  readonly logger?: FastifyServerOptions['logger'];
  readonly desktopSession?: { token: string; origin: () => string; nativePicker?: typeof pickPath };
}

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? { level: 'info' },
  });

  if (options.desktopSession) {
    const session = options.desktopSession;
    const expected = Buffer.from(session.token);
    app.addHook('onRequest', async (req, reply) => {
      const actual = Buffer.from(typeof req.headers['x-gba-session'] === 'string' ? req.headers['x-gba-session'] : '');
      const origin = session.origin();
      if (!origin || actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
          (req.headers.origin && req.headers.origin !== origin) ||
          req.headers.host !== new URL(origin).host) {
        return reply.code(401).send({ error: 'Desktop session required' });
      }
    });
  }
  const sessionStore = new ProjectSessionStore();

  // websocketPlugin must be registered before any route that uses
  // `{ websocket: true }`, and must live on the top-level app so
  // app.injectWS works in tests.
  await app.register(websocketPlugin);
  await app.register(registerHealthRoute);
  await app.register(registerProjectsRoute, { sessionStore, nativePicker: options.desktopSession?.nativePicker });
  await app.register(registerAgentRoute, { sessionStore });
  await app.register(registerTileIntelRoute, { sessionStore });

  return app;
}
