import { describe, it, expect } from 'vitest';
import { validateClientMessage } from '../src/ws/validator.js';
import { ErrorCode } from '@coach/shared';

describe('validateClientMessage', () => {
  const validEnvelope = (type: string, payload: unknown) =>
    JSON.stringify({
      type,
      event_id: 'evt_1',
      session_id: 'sess_1',
      ts_ms: Date.now(),
      payload,
    });

  it('accepts valid client.hello', () => {
    const msg = validEnvelope('client.hello', {
      protocol_version: '1.0',
      app_version: '0.0.1',
      device_info: { platform: 'ios', os_version: '17.0' },
    });
    const result = validateClientMessage(msg);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.event.type).toBe('client.hello');
    }
  });

  it('accepts valid session.start', () => {
    const msg = validEnvelope('session.start', {
      requested_duration_ms: 600_000,
      content_id: 'cnt_abc123',
    });
    const result = validateClientMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('accepts valid audio.start', () => {
    const msg = validEnvelope('audio.start', {
      codec: 'pcm_s16le',
      sample_rate_hz: 16000,
      channels: 1,
      chunk_ms: 20,
    });
    const result = validateClientMessage(msg);
    expect(result.valid).toBe(true);
  });

  it('accepts valid empty-payload events', () => {
    for (const type of ['audio.stop', 'client.barge_in', 'client.ping']) {
      const msg = validEnvelope(type, {});
      const result = validateClientMessage(msg);
      expect(result.valid).toBe(true);
    }
  });

  it('rejects invalid JSON', () => {
    const result = validateClientMessage('not json{');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe(ErrorCode.ERR_BAD_EVENT_SCHEMA);
      expect(result.message).toContain('Invalid JSON');
    }
  });

  it('rejects missing envelope fields', () => {
    const result = validateClientMessage(JSON.stringify({ type: 'client.hello' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe(ErrorCode.ERR_BAD_EVENT_SCHEMA);
    }
  });

  it('rejects unknown event type', () => {
    const msg = validEnvelope('unknown.event', {});
    const result = validateClientMessage(msg);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain('Unknown event type');
    }
  });

  it('rejects invalid payload for known event type', () => {
    const msg = validEnvelope('client.hello', { bad: 'payload' });
    const result = validateClientMessage(msg);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain('Invalid payload');
    }
  });

  it('rejects audio.start with wrong codec', () => {
    const msg = validEnvelope('audio.start', {
      codec: 'opus',
      sample_rate_hz: 16000,
      channels: 1,
      chunk_ms: 20,
    });
    const result = validateClientMessage(msg);
    expect(result.valid).toBe(false);
  });
});
