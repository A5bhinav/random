import { describe, it, expect } from 'vitest';
import {
  AUDIO_CHUNK_BYTES,
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_CHUNK_MS,
  AUDIO_BYTES_PER_SECOND,
  TIMER_WARNING_THRESHOLDS,
  PACING_CHECK_INTERVAL_MS,
  PACING_DEBOUNCE_MS,
  PROTOCOL_VERSION,
  WS_BACKPRESSURE_BYTES,
  AUTH_RATE_LIMIT_MAX,
} from '../src/constants.js';

describe('audio constants consistency', () => {
  it('chunk bytes matches 20ms at 16kHz mono 16-bit', () => {
    const expected = (AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2 * AUDIO_CHUNK_MS) / 1000;
    expect(AUDIO_CHUNK_BYTES).toBe(expected);
    expect(AUDIO_CHUNK_BYTES).toBe(640);
  });

  it('bytes per second matches 16kHz mono 16-bit', () => {
    const expected = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2;
    expect(AUDIO_BYTES_PER_SECOND).toBe(expected);
    expect(AUDIO_BYTES_PER_SECOND).toBe(32000);
  });
});

describe('timer constants', () => {
  it('warning thresholds are in descending order', () => {
    for (let i = 1; i < TIMER_WARNING_THRESHOLDS.length; i++) {
      expect(TIMER_WARNING_THRESHOLDS[i]).toBeLessThan(TIMER_WARNING_THRESHOLDS[i - 1]!);
    }
  });

  it('includes standard 60s and 15s thresholds', () => {
    expect(TIMER_WARNING_THRESHOLDS).toContain(60_000);
    expect(TIMER_WARNING_THRESHOLDS).toContain(15_000);
  });
});

describe('pacing constants', () => {
  it('debounce is longer than check interval', () => {
    expect(PACING_DEBOUNCE_MS).toBeGreaterThan(PACING_CHECK_INTERVAL_MS);
  });
});

describe('protocol constants', () => {
  it('has a version string', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
  });

  it('backpressure is 64KB', () => {
    expect(WS_BACKPRESSURE_BYTES).toBe(65536);
  });

  it('rate limit is 10 per minute', () => {
    expect(AUTH_RATE_LIMIT_MAX).toBe(10);
  });
});
