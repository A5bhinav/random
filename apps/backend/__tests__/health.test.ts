import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TEST_CONFIG = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_JWT_SECRET: 'test-secret-at-least-32-chars-long!!',
  REDIS_URL: 'redis://localhost:6379',
  DEEPGRAM_API_KEY: 'test-key',
  OPENAI_API_KEY: 'test-key',
};

describe('health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer(TEST_CONFIG);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz returns 200', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/readyz',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /nonexistent returns 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent',
    });
    expect(response.statusCode).toBe(404);
  });
});
