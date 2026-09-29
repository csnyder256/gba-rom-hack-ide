import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@rom-editor/shared';
import { createServer } from './server.js';

describe('backend server', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createServer({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responds to GET /api/health with a real status payload', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('rom-editor-backend');
    const releaseVersion = readFileSync(new URL('../../../VERSION', import.meta.url), 'utf8').trim();
    expect(body.version).toBe(releaseVersion);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });
});
