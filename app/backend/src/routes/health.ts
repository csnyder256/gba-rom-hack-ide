import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@rom-editor/shared';

const SERVICE_NAME = 'rom-editor-backend';
const SERVICE_VERSION = '0.2.0';
const startedAt = Date.now();

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: (Date.now() - startedAt) / 1000,
    };
  });
}
