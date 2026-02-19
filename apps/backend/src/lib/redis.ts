import { Redis } from 'ioredis';

let instance: Redis | null = null;

/**
 * Initialise the Redis client. Call once at startup.
 */
export function initRedis(url: string): Redis {
  if (instance) {
    throw new Error('Redis client already initialised');
  }
  instance = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });
  return instance;
}

/**
 * Return the initialised Redis client.
 * Throws if called before `initRedis()`.
 */
export function getRedis(): Redis {
  if (!instance) {
    throw new Error('Redis client not initialised -- call initRedis() first');
  }
  return instance;
}

/** Disconnect and reset. For graceful shutdown. */
export async function shutdownRedis(): Promise<void> {
  if (instance) {
    await instance.quit().catch(() => {});
    instance = null;
  }
}

/** Reset without disconnect. For testing only. */
export function _resetRedis(): void {
  instance = null;
}
