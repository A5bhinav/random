import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { REDIS_SESSION_TTL_S, SessionState } from '@coach/shared';
import type { LiveSessionState } from '@coach/shared';

const mockSetex = vi.fn().mockResolvedValue('OK');
const mockGetex = vi.fn();
const mockDel = vi.fn().mockResolvedValue(1);

vi.mock('../src/lib/redis.js', () => ({
  getRedis: () => ({
    setex: mockSetex,
    getex: mockGetex,
    del: mockDel,
  }),
}));

import {
  saveSessionState,
  getSessionState,
  deleteSessionState,
} from '../src/lib/session-store.js';

const SAMPLE_STATE: LiveSessionState = {
  session_id: 'sess-1',
  user_id: 'user-1',
  state: SessionState.RUNNING_REP,
  plan: null,
  start_ts: 1700000000000,
  elapsed_ms: 30000,
  current_segment_index: 0,
  turn_index: 2,
  last_client_audio_seq: 100,
  last_server_tts_seq: 50,
};

describe('session-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveSessionState', () => {
    it('serializes and calls setex with correct TTL', async () => {
      await saveSessionState('sess-1', SAMPLE_STATE);

      expect(mockSetex).toHaveBeenCalledWith(
        'session:sess-1',
        REDIS_SESSION_TTL_S,
        JSON.stringify(SAMPLE_STATE),
      );
    });

    it('does not throw on Redis error', async () => {
      mockSetex.mockRejectedValueOnce(new Error('connection refused'));
      await expect(saveSessionState('sess-1', SAMPLE_STATE)).resolves.toBeUndefined();
    });
  });

  describe('getSessionState', () => {
    it('deserializes and refreshes TTL', async () => {
      mockGetex.mockResolvedValueOnce(JSON.stringify(SAMPLE_STATE));

      const result = await getSessionState('sess-1');

      expect(mockGetex).toHaveBeenCalledWith('session:sess-1', 'EX', REDIS_SESSION_TTL_S);
      expect(result).toEqual(SAMPLE_STATE);
    });

    it('returns null for missing key', async () => {
      mockGetex.mockResolvedValueOnce(null);

      const result = await getSessionState('sess-missing');
      expect(result).toBeNull();
    });

    it('returns null on Redis error', async () => {
      mockGetex.mockRejectedValueOnce(new Error('timeout'));

      const result = await getSessionState('sess-1');
      expect(result).toBeNull();
    });
  });

  describe('deleteSessionState', () => {
    it('calls del with correct key', async () => {
      await deleteSessionState('sess-1');
      expect(mockDel).toHaveBeenCalledWith('session:sess-1');
    });

    it('does not throw on Redis error', async () => {
      mockDel.mockRejectedValueOnce(new Error('connection refused'));
      await expect(deleteSessionState('sess-1')).resolves.toBeUndefined();
    });
  });
});
