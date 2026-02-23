import type { FastifyInstance } from 'fastify';
import { getSupabase } from '../lib/supabase.js';
import { createAnonymousToken } from '../auth/token.js';
import { ensureUserProfile } from '../lib/repository.js';

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): Promise<void> {
  /**
   * POST /v1/auth/anonymous
   *
   * Creates or returns an anonymous Supabase user keyed by device_id and
   * issues a Supabase-compatible JWT the client can use for all subsequent
   * REST and WebSocket calls.
   *
   * Body: { device_id: string }
   * Response: { token: string, user_id: string, expires_at: number }
   */
  app.post<{ Body: { device_id?: string } }>(
    '/v1/auth/anonymous',
    {
      schema: {
        body: {
          type: 'object',
          required: ['device_id'],
          properties: {
            device_id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { device_id } = request.body;

      if (!device_id) {
        return reply.status(400).send({ error: 'device_id is required' });
      }

      let userId: string;
      try {
        const supabase = getSupabase();
        const { data, error } = await supabase.auth.admin.createUser({
          user_metadata: { device_id },
          // Supabase marks the user anonymous when no email/phone is provided
          // and anonymous sign-in is enabled in project settings.
        });

        if (error) {
          request.log.error({ err: error }, 'Supabase createUser failed');
          return reply.status(502).send({ error: 'Failed to create anonymous user' });
        }

        userId = data.user.id;
      } catch (err) {
        request.log.error({ err }, 'Supabase Admin API call threw');
        return reply.status(502).send({ error: 'Auth service unavailable' });
      }

      // Ensure a row exists in public.users (trigger may already handle this,
      // but call explicitly so the service-role path is also covered).
      await ensureUserProfile(userId);

      const { token, expiresAt } = await createAnonymousToken(userId, opts.jwtSecret);

      return reply.status(200).send({ token, user_id: userId, expires_at: expiresAt });
    },
  );
}
