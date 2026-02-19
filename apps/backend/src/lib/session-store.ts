import { getRedis } from './redis.js';
import { REDIS_SESSION_TTL_S } from '@coach/shared';
import type { LiveSessionState } from '@coach/shared';
import type { Redis } from 'ioredis';

function key(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Returns the Redis client or null if not initialised (e.g. in tests). */
function redis(): Redis | null {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

export async function saveSessionState(
  sessionId: string,
  state: LiveSessionState,
): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.setex(key(sessionId), REDIS_SESSION_TTL_S, JSON.stringify(state));
  } catch (err) {
    console.error('[session-store] saveSessionState failed', { sessionId, err: String(err) });
  }
}

export async function getSessionState(
  sessionId: string,
): Promise<LiveSessionState | null> {
  const r = redis();
  if (!r) return null;
  try {
    // GETEX refreshes TTL atomically
    const json = await r.getex(key(sessionId), 'EX', REDIS_SESSION_TTL_S);
    return json ? (JSON.parse(json) as LiveSessionState) : null;
  } catch (err) {
    console.error('[session-store] getSessionState failed', { sessionId, err: String(err) });
    return null;
  }
}

export async function deleteSessionState(sessionId: string): Promise<void> {
  const r = redis();
  if (!r) return;
  try {
    await r.del(key(sessionId));
  } catch (err) {
    console.error('[session-store] deleteSessionState failed', { sessionId, err: String(err) });
  }
}
