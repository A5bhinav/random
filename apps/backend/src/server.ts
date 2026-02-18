import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config.js';
import { registerWSHandler } from './ws/handler.js';
import { initSupabase } from './lib/supabase.js';

export async function buildServer(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    },
  });

  // Initialise Supabase client (skip in test -- no real Supabase project)
  if (config.NODE_ENV !== 'test') {
    initSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
  }

  await app.register(fastifyCors);
  await app.register(fastifyWebsocket);
  await app.register(fastifyRateLimit, { global: false });

  // Health check -- no auth required
  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  // Readiness check -- verifies DB + Redis connectivity
  // For now, returns ok. Will add real checks when Redis is wired.
  app.get('/readyz', async (_request, reply) => {
    try {
      // TODO: check redis.ping() once wired
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  // WebSocket handler
  await registerWSHandler(app, {
    jwtSecret: config.SUPABASE_JWT_SECRET,
    logger: app.log,
  });

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info('Shutting down...');
    await app.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}
