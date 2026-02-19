import { insertSessionEvent, insertSessionEvents, type SessionEventRow } from './repository.js';

const FLUSH_INTERVAL_MS = 500;
const FLUSH_TIMEOUT_MS = 2_000;

/** Events that bypass the batch buffer and write immediately. */
const MUST_PERSIST_TYPES = new Set(['session.start', 'session.end', 'server.error']);

/**
 * Per-session event batcher.
 * - Must-persist events (session.start, session.end, server.error) write immediately.
 * - All other events accumulate in a buffer and flush every 500ms.
 * - Call `flush()` on session end for a synchronous drain (2s timeout).
 */
export class EventBatcher {
  private buffer: SessionEventRow[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.interval = setInterval(() => {
      this.drainBuffer();
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * Queue an event. Must-persist events write immediately; others are batched.
   */
  queue(type: string, payload: Record<string, unknown>): void {
    if (MUST_PERSIST_TYPES.has(type)) {
      // Fire-and-forget immediate write
      insertSessionEvent(this.sessionId, type, payload).catch(() => {});
      return;
    }

    this.buffer.push({
      session_id: this.sessionId,
      ts_ms: Date.now(),
      type,
      payload,
    });
  }

  /**
   * Flush all buffered events. Called on session end.
   * Resolves when buffer is drained or after 2s timeout.
   */
  async flush(): Promise<void> {
    this.stopInterval();
    if (this.buffer.length === 0) return;

    const events = this.buffer.splice(0);
    const flushPromise = insertSessionEvents(events);

    // 2-second timeout -- don't block WS close forever
    await Promise.race([
      flushPromise,
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ]);
  }

  /** Stop the interval and discard any remaining events. */
  destroy(): void {
    this.stopInterval();
    this.buffer.length = 0;
  }

  /** Visible for testing. */
  get _bufferLength(): number {
    return this.buffer.length;
  }

  private drainBuffer(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0);
    insertSessionEvents(events).catch(() => {});
  }

  private stopInterval(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
