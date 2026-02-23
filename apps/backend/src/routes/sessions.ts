import type { FastifyInstance } from 'fastify';
import { verifySupabaseToken } from '../auth/token.js';
import { getSession } from '../lib/repository.js';

export async function registerSessionRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): Promise<void> {
  /**
   * GET /v1/sessions/:id
   *
   * Fetches a session record. The caller must own the session (user_id match).
   *
   * Response: SessionRow shape or 404
   */
  app.get<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
    // ── Auth ──────────────────────────────────────────────────────────────
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing Bearer token' });
    }

    let userId: string;
    try {
      const claims = await verifySupabaseToken(auth.slice(7), opts.jwtSecret);
      userId = claims.sub;
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    // ── Fetch ─────────────────────────────────────────────────────────────
    const { id } = request.params;
    let session;
    try {
      session = await getSession(id);
    } catch (err) {
      request.log.error({ err }, 'getSession failed');
      return reply.status(502).send({ error: 'Database error' });
    }

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // ── Ownership check ───────────────────────────────────────────────────
    // The service-role client bypasses RLS, so enforce ownership explicitly.
    if (session.user_id !== userId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return reply.status(200).send(session);
  });
}
