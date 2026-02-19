import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { verifySupabaseToken } from '../auth/token.js';
import { insertContentPack } from '../lib/repository.js';
import { parseContent, isSupportedMime, SUPPORTED_MIMES } from '../lib/content-parser.js';
import { MAX_CONTENT_FILE_MB } from '@coach/shared';

const MAX_FILE_BYTES = MAX_CONTENT_FILE_MB * 1024 * 1024;

export async function registerContentRoutes(
  app: FastifyInstance,
  opts: { jwtSecret: string },
): Promise<void> {
  app.post('/v1/content', async (request, reply) => {
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

    // ── Multipart ─────────────────────────────────────────────────────────
    const part = await request.file({ limits: { fileSize: MAX_FILE_BYTES } });
    if (!part) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const mimeType = part.mimetype;
    if (!isSupportedMime(mimeType)) {
      part.file.resume(); // drain the stream
      return reply.status(415).send({
        error: `Unsupported file type "${mimeType}". Accepted: ${SUPPORTED_MIMES.join(', ')}`,
      });
    }

    const buffer = await part.toBuffer();

    if (part.file.truncated) {
      return reply.status(413).send({ error: `File exceeds ${MAX_CONTENT_FILE_MB} MB limit` });
    }

    // ── Parse ─────────────────────────────────────────────────────────────
    let chunks;
    try {
      chunks = await parseContent(buffer, mimeType);
    } catch (err) {
      request.log.error({ err }, 'Content parsing failed');
      return reply.status(422).send({ error: 'Failed to extract text from file' });
    }

    if (chunks.length === 0) {
      return reply.status(422).send({ error: 'No extractable text found in file' });
    }

    // ── Persist ───────────────────────────────────────────────────────────
    const contentId = uuid();
    await insertContentPack({
      contentId,
      userId,
      filename: part.filename,
      mimeType,
      chunks,
    });

    return reply.status(201).send({ content_id: contentId, chunk_count: chunks.length });
  });
}
