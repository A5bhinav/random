import { describe, it, expect } from 'vitest';
import {
  AUDIO_CHUNK_BYTES,
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_CHUNK_MS,
  AUDIO_BYTES_PER_SECOND,
  TIMER_TOTAL_MS,
  TIMER_WARNING_THRESHOLDS,
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
  it('total is 180 seconds', () => {
    expect(TIMER_TOTAL_MS).toBe(180_000);
  });

  it('warnings are at 60s and 15s', () => {
    expect(TIMER_WARNING_THRESHOLDS).toEqual([60_000, 15_000]);
  });

  it('all warning thresholds are less than total', () => {
    for (const threshold of TIMER_WARNING_THRESHOLDS) {
      expect(threshold).toBeLessThan(TIMER_TOTAL_MS);
    }
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
