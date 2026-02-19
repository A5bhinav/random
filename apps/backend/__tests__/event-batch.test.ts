import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockInsertSessionEvent = vi.fn().mockResolvedValue(undefined);
const mockInsertSessionEvents = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/lib/repository.js', () => ({
  insertSessionEvent: (...args: unknown[]) => mockInsertSessionEvent(...args),
  insertSessionEvents: (...args: unknown[]) => mockInsertSessionEvents(...args),
}));

import { EventBatcher } from '../src/lib/event-batch.js';

describe('EventBatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('must-persist events write immediately', () => {
    const batcher = new EventBatcher('sess-1');

    batcher.queue('session.start', { drill_id: 'pitch' });

    expect(mockInsertSessionEvent).toHaveBeenCalledWith(
      'sess-1',
      'session.start',
      { drill_id: 'pitch' },
    );
    expect(batcher._bufferLength).toBe(0);

    batcher.destroy();
  });

  it('session.end writes immediately', () => {
    const batcher = new EventBatcher('sess-1');
    batcher.queue('session.end', { reason: 'timer' });

    expect(mockInsertSessionEvent).toHaveBeenCalledWith('sess-1', 'session.end', { reason: 'timer' });
    batcher.destroy();
  });

  it('server.error writes immediately', () => {
    const batcher = new EventBatcher('sess-1');
    batcher.queue('server.error', { code: 'ERR_SESSION_STATE' });

    expect(mockInsertSessionEvent).toHaveBeenCalledWith('sess-1', 'server.error', { code: 'ERR_SESSION_STATE' });
    batcher.destroy();
  });

  it('non-must-persist events are buffered', () => {
    const batcher = new EventBatcher('sess-1');

    batcher.queue('timer.tick', { remaining_ms: 170000 });
    batcher.queue('stt.partial', { text: 'hello' });

    expect(mockInsertSessionEvent).not.toHaveBeenCalled();
    expect(batcher._bufferLength).toBe(2);

    batcher.destroy();
  });

  it('buffer flushes on 500ms interval', () => {
    const batcher = new EventBatcher('sess-1');

    batcher.queue('timer.tick', { remaining_ms: 170000 });
    batcher.queue('stt.partial', { text: 'hello' });

    vi.advanceTimersByTime(500);

    expect(mockInsertSessionEvents).toHaveBeenCalledTimes(1);
    const events = mockInsertSessionEvents.mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('timer.tick');
    expect(events[1].type).toBe('stt.partial');
    expect(batcher._bufferLength).toBe(0);

    batcher.destroy();
  });

  it('flush() drains buffer immediately', async () => {
    vi.useRealTimers(); // flush is async
    const batcher = new EventBatcher('sess-1');

    batcher.queue('audio.start', {});
    batcher.queue('audio.stop', {});

    await batcher.flush();

    expect(mockInsertSessionEvents).toHaveBeenCalledTimes(1);
    const events = mockInsertSessionEvents.mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(batcher._bufferLength).toBe(0);
  });

  it('flush() is no-op when buffer is empty', async () => {
    vi.useRealTimers();
    const batcher = new EventBatcher('sess-1');

    await batcher.flush();

    expect(mockInsertSessionEvents).not.toHaveBeenCalled();
  });

  it('destroy() clears buffer and stops interval', () => {
    const batcher = new EventBatcher('sess-1');

    batcher.queue('timer.tick', { remaining_ms: 170000 });
    expect(batcher._bufferLength).toBe(1);

    batcher.destroy();
    expect(batcher._bufferLength).toBe(0);

    // Advancing time should not trigger any flush
    vi.advanceTimersByTime(1000);
    expect(mockInsertSessionEvents).not.toHaveBeenCalled();
  });

  it('does not flush empty buffer on interval', () => {
    const _batcher = new EventBatcher('sess-1');

    vi.advanceTimersByTime(500);

    expect(mockInsertSessionEvents).not.toHaveBeenCalled();

    _batcher.destroy();
  });
});
