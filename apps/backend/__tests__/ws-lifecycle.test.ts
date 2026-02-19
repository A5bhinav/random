import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import { buildServer } from '../src/server.js';
import { _createTestSupabaseToken } from '../src/auth/token.js';
import { PROTOCOL_VERSION } from '@coach/shared';

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

function makeEvent(type: string, payload: unknown, sessionId = '') {
  return JSON.stringify({
    type,
    event_id: uuid(),
    session_id: sessionId,
    ts_ms: Date.now(),
    payload,
  });
}

function parseEvent(raw: string) {
  return JSON.parse(raw);
}

/**
 * A buffered WebSocket wrapper that queues messages from the start.
 * Solves the race condition where server sends a message before the test
 * attaches a listener.
 */
class BufferedWS {
  ws: WebSocket;
  private queue: string[] = [];
  private waiters: Array<(msg: string) => void> = [];
  private closeResolvers: Array<(info: { code: number; reason: string }) => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const msg = data.toString();
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    });
    this.ws.on('close', (code, reason) => {
      for (const r of this.closeResolvers) r({ code, reason: reason?.toString() ?? '' });
      this.closeResolvers = [];
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
  }

  nextMessage(timeout = 2000): Promise<string> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for message')), timeout);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  waitClose(timeout = 5000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for close')), timeout);
      this.closeResolvers.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  send(data: string | Buffer) {
    this.ws.send(data);
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

describe('WS lifecycle integration', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const clients: BufferedWS[] = [];

  beforeAll(async () => {
    app = await buildServer(TEST_CONFIG);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (typeof address === 'string' || !address) throw new Error('Failed to get server address');
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    for (const c of clients) c.close();
    clients.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  async function connect(): Promise<BufferedWS> {
    const c = new BufferedWS(`${baseUrl}/v1/ws`);
    clients.push(c);
    await c.ready();
    return c;
  }

  async function doHandshake(c: BufferedWS): Promise<{ userId: string; sessionId: string }> {
    // Receive server.hello
    const hello = parseEvent(await c.nextMessage());
    expect(hello.type).toBe('server.hello');
    expect(hello.payload.protocol_version).toBe(PROTOCOL_VERSION);

    // Send client.hello
    c.send(makeEvent('client.hello', {
      protocol_version: PROTOCOL_VERSION,
      app_version: '0.0.1',
      device_info: { platform: 'ios', os_version: '17.0' },
    }));

    // Send auth.anonymous
    const { token } = await _createTestSupabaseToken('user_test', TEST_CONFIG.SUPABASE_JWT_SECRET);
    c.send(makeEvent('auth.anonymous', { token }));

    // Receive auth.ok
    const auth = parseEvent(await c.nextMessage());
    expect(auth.type).toBe('auth.ok');
    expect(auth.payload.user_id).toBe('user_test');

    // Send session.start
    c.send(makeEvent('session.start', {
      requested_duration_ms: 600_000,
      content_id: 'cnt_abc123',
    }));

    // Receive session.start_ack
    const ack = parseEvent(await c.nextMessage());
    expect(ack.type).toBe('session.start_ack');

    // session.plan will arrive once LLM plan generation is wired (Milestone 4)

    return { userId: auth.payload.user_id, sessionId: ack.payload.session_id };
  }

  it('completes full handshake: hello → auth → session.start → ack', async () => {
    const c = await connect();
    const { sessionId } = await doHandshake(c);
    expect(sessionId).toBeTruthy();
  });

  it('receives timer.tick after session start', async () => {
    const c = await connect();
    await doHandshake(c);

    // Wait for a timer tick (should arrive within ~1s)
    const tick = parseEvent(await c.nextMessage(3000));
    expect(tick.type).toBe('timer.tick');
    expect(tick.payload.remaining_ms).toBeLessThanOrEqual(600_000);
    expect(tick.payload.remaining_ms).toBeGreaterThan(0);
  });

  it('server sends server.hello immediately on connect', async () => {
    const c = await connect();
    const hello = parseEvent(await c.nextMessage());
    expect(hello.type).toBe('server.hello');
    expect(hello.payload.connection_id).toBeTruthy();
  });

  it('rejects binary frame before audio.start with ERR_SESSION_STATE', async () => {
    const c = await connect();
    await doHandshake(c);

    const closePromise = c.waitClose();
    c.send(Buffer.alloc(640));

    const { code } = await closePromise;
    expect(code).toBe(4002);
  });

  it('returns server.error for invalid JSON', async () => {
    const c = await connect();
    // Consume server.hello
    await c.nextMessage();

    c.send('not-json{{{');

    const error = parseEvent(await c.nextMessage());
    expect(error.type).toBe('server.error');
    expect(error.payload.code).toBe('ERR_BAD_EVENT_SCHEMA');
  });

  it('returns server.error for malformed event envelope', async () => {
    const c = await connect();
    await c.nextMessage(); // consume server.hello

    c.send(JSON.stringify({ type: 'client.hello' }));

    const error = parseEvent(await c.nextMessage());
    expect(error.type).toBe('server.error');
    expect(error.payload.code).toBe('ERR_BAD_EVENT_SCHEMA');
  });

  it('rejects auth with invalid token', async () => {
    const c = await connect();
    await c.nextMessage(); // consume server.hello

    c.send(makeEvent('client.hello', {
      protocol_version: PROTOCOL_VERSION,
      app_version: '0.0.1',
      device_info: { platform: 'android', os_version: '14' },
    }));

    c.send(makeEvent('auth.anonymous', { token: 'invalid.jwt.token' }));

    const auth = parseEvent(await c.nextMessage());
    expect(auth.type).toBe('auth.error');
  });
});
