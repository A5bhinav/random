import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import type { AppConfig } from './config.js';
import { registerWSHandler } from './ws/handler.js';
import { registerContentRoutes } from './routes/content.js';
import { createAdapterFactory } from './adapters/factory.js';
import { initSupabase } from './lib/supabase.js';
import { initRedis, getRedis, shutdownRedis } from './lib/redis.js';

export async function buildServer(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
    },
  });

  // Initialise external clients (skip in test -- no real services)
  if (config.NODE_ENV !== 'test') {
    initSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
    const redis = initRedis(config.REDIS_URL);
    await redis.connect();
  }

  await app.register(fastifyCors);
  await app.register(fastifyWebsocket);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyMultipart);

  // Health check -- no auth required
  app.get('/healthz', async () => {
    return { status: 'ok' };
  });

  // Readiness check -- verifies Redis connectivity
  app.get('/readyz', async (_request, reply) => {
    try {
      const redis = getRedis();
      await redis.ping();
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  // REST routes
  await registerContentRoutes(app, { jwtSecret: config.SUPABASE_JWT_SECRET });

  // Adapter factory (null in test mode — handler uses stubs)
  const factory =
    config.NODE_ENV !== 'test'
      ? createAdapterFactory({
          deepgramApiKey: config.DEEPGRAM_API_KEY,
          openaiApiKey: config.OPENAI_API_KEY,
        })
      : null;

  // WebSocket handler
  await registerWSHandler(app, {
    jwtSecret: config.SUPABASE_JWT_SECRET,
    factory,
    logger: app.log,
  });

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info('Shutting down...');
    await shutdownRedis();
    await app.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}
